import { IPeer } from "./impl/signal-room";
import { EnterRoom, enterRoom } from "./signal-room";

export type SigType = "offer" | "answer" | "ice";
export type SigPayload = RTCSessionDescriptionInit | RTCIceCandidateInit;

type UserState = {
  userId: string;
  pc?: RTCPeerConnection;

  // ICE that arrived before we had remoteDescription
  pendingRemoteIce: RTCIceCandidateInit[];

  // the signaling "user" handle so we can send messages
  peer: IPeer<SigType, SigPayload>;

  expirationTimeout?: number;
};

const DEFAULT_ENTER_ROOM = enterRoom;

export function collectPeerConnections({
  appId,
  receivePeerConnection,
  peerlessUserExpiration = 5000,
  fallbackRtcConfig = {
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  },
  enterRoomFunction: enterRoom = DEFAULT_ENTER_ROOM,
  logLine = console.debug,
  onLeaveUser,
  workerUrl,
  onRoomReady,
  onRoomClose,
}: {
  appId: string;
  fallbackRtcConfig?: RTCConfiguration;
  enterRoomFunction?: EnterRoom<SigType, SigPayload>;
  onLeaveUser?: (userId: string) => void;
  logLine?: (direction: string, obj?: any) => void;
  workerUrl?: URL;
  peerlessUserExpiration?: number;
  receivePeerConnection(connection: {
    pc: RTCPeerConnection;
    userId: string;
    initiator: boolean;
    restart?: () => void;
  }): void;
  onRoomReady?(info: { host: string; room: string }): void;
  onRoomClose?(info: {
    host: string;
    room: string;
    ev: Pick<CloseEvent, "reason" | "code" | "wasClean">;
  }): void;
}) {
  const userId = `user-${crypto.randomUUID()}`;
  const users: Map<string, UserState> = new Map();
  let iceUrl: string | undefined = undefined;

  async function getRtcConfig(): Promise<RTCConfiguration> {
    if (iceUrl) {
      try {
        const r = await fetch(iceUrl);
        if (!r.ok) throw new Error(`ICE endpoint failed: ${r.status}`);
        return await r.json();
      } catch (e) {
        console.warn("Using fallback rtcConfig:", e);
      }
    }
    return fallbackRtcConfig;
  }

  async function setupPC(state: UserState) {
    state.pc = new RTCPeerConnection(await getRtcConfig());
    // Send local ICE candidates to this peer
    state.pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      state.peer.receive("ice", ev.candidate.toJSON());
    };

    state.pc.onconnectionstatechange = () => {
      logLine("💬", {
        event: "pc-state",
        userId: state.userId,
        state: state.pc?.connectionState,
      });
    };
    return state.pc;
  }

  async function getPeer(
    peer: IPeer<SigType, SigPayload>
  ): Promise<[UserState, boolean]> {
    let state = users.get(peer.userId);
    let isNewPeer = false;
    if (!state) {
      const newState: UserState = {
        userId: peer.userId,
        pendingRemoteIce: [],
        peer,
      };
      users.set(peer.userId, newState);

      await setupPC(newState);
      state = newState;

      //  New user
      users.set(state.userId, state);
      isNewPeer = true;
    } else if (state) {
      clearTimeout(state.expirationTimeout);
      state.expirationTimeout = 0;
    }
    if (!state.pc) {
      await setupPC(state);
    }
    state.peer = peer;
    return [state, isNewPeer];
  }

  function leaveUser(userId: string) {
    onLeaveUser?.(userId);
    const p = users.get(userId);
    if (!p) return;
    try {
      p.pc?.close();
    } catch {}
    users.delete(userId);
  }

  async function flushRemoteIce(state: UserState) {
    if (!state.pc?.remoteDescription) return;

    const queued = state.pendingRemoteIce;
    state.pendingRemoteIce = [];

    for (const ice of queued) {
      try {
        await state.pc.addIceCandidate(ice);
      } catch (e) {
        logLine("⚠️ ERROR", {
          error: "add-ice-failed",
          userId: state.userId,
          detail: String(e),
        });
      }
    }
  }

  const roomsEntered = new Map<
    string,
    { room: string; host: string; exitRoom: () => void }
  >();

  function exit({ room, host }: { room: string; host: string }) {
    const key = `${host}/room/${room}`;
    const session = roomsEntered.get(key);
    if (session) {
      session.exitRoom();
      roomsEntered.delete(key);
    }
  }

  function enter({ room, host }: { room: string; host: string }) {
    return new Promise<void>(async (resolve, reject) => {
      async function makeOffer(user: IPeer) {
        // Offer flow: createOffer -> setLocalDescription -> send localDescription
        const [state] = await getPeer(user);
        const pc = state.pc;
        const offer = await pc?.createOffer();
        await pc?.setLocalDescription(offer);
        user.receive("offer", pc?.localDescription?.toJSON()!);
      }

      const { exitRoom } = enterRoom({
        userId,
        appId,
        room,
        host,
        logLine,
        workerUrl,
        autoRejoin: true,

        onOpen() {
          onRoomReady?.({ room, host });
          resolve();
        },
        onError() {
          console.error("onError");
          reject();
        },
        onClose(ev) {
          onRoomClose?.({ room, host, ev });
        },

        // Existing peers initiate to the newcomer
        onPeerJoined(joiningUsers: IPeer<SigType, SigPayload>[]) {
          joiningUsers.forEach(async (user) => {
            const [state, isNewPeer] = await getPeer(user);
            if (!isNewPeer) return;
            const pc = state.pc;
            if (!pc) return;

            async function restart() {
              const state = users.get(user.userId);
              if (state) {
                state.pc = undefined;
                const pc = await setupPC(state);
                receivePeerConnection({
                  pc,
                  userId: user.userId,
                  initiator: true,
                  restart,
                });
                await new Promise((resolve) => setTimeout(resolve, 3000));
                makeOffer(user);
              }
            }

            receivePeerConnection({
              pc,
              userId: user.userId,
              initiator: true,
              restart,
            });
            makeOffer(user);
          });
        },

        onPeerLeft(leavingUsers: { userId: string }[]) {
          leavingUsers.forEach(({ userId }) => {
            const state = users.get(userId);
            if (!state) return;
            state.expirationTimeout = setTimeout(
              () => leaveUser(userId),
              peerlessUserExpiration ?? 0
            );
          });
        },

        onIceUrl(url) {
          iceUrl = url;
        },

        async onMessage(type: SigType, payload: any, from: IPeer) {
          const [state] = await getPeer(from);
          const pc = state.pc;
          if (!pc) return;

          if (type === "offer") {
            receivePeerConnection({
              pc,
              userId: from.userId,
              initiator: false,
              restart() {
                //  reset PC
                state.pc = undefined;
              },
            });
            // Responder: set remote offer
            await pc.setRemoteDescription(payload as RTCSessionDescriptionInit);

            // Create and send answer
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            from.receive("answer", pc.localDescription?.toJSON()!);

            // Now safe to apply any queued ICE from this peer
            await flushRemoteIce(state);
            return;
          }

          if (type === "answer") {
            // Initiator: set remote answer
            await pc.setRemoteDescription(payload as RTCSessionDescriptionInit);
            await flushRemoteIce(state);
            return;
          }

          if (type === "ice") {
            const ice = payload as RTCIceCandidateInit;

            // If we don't have remoteDescription yet, queue it
            if (!pc.remoteDescription) {
              state.pendingRemoteIce.push(ice);
              return;
            }

            try {
              await pc.addIceCandidate(ice);
            } catch (e) {
              logLine("⚠️ ERROR", {
                error: "add-ice-failed",
                userId: state.userId,
                detail: String(e),
              });
            }
            return;
          }
        },
      });
      roomsEntered.set(`${host}/room/${room}`, { exitRoom, room, host });
    });
  }

  return {
    userId,
    enterRoom: enter,
    exitRoom: exit,
    leaveUser,
    end() {
      roomsEntered.forEach(({ exitRoom }) => exitRoom());
      roomsEntered.clear();
      users.forEach(({ userId }) => leaveUser(userId));
      users.clear();
    },
  };
}

/*
Turn Token ID
<CF_TURN_TOKEN_ID>

API Token
<CF_RTC_API_TOKEN>

CURL
curl \
	-H "Authorization: Bearer <CF_RTC_API_TOKEN>" \
	-H "Content-Type: application/json" -d '{"ttl": 86400}' \
	https://rtc.live.cloudflare.com/v1/turn/keys/<CF_TURN_TOKEN_ID>/credentials/generate-ice-servers

JSON
{
	"iceServers": [
    {
      "urls": [
        "stun:stun.cloudflare.com:3478",
        "turn:turn.cloudflare.com:3478?transport=udp",
        "turn:turn.cloudflare.com:3478?transport=tcp",
        "turns:turn.cloudflare.com:5349?transport=tcp"
      ],
      "username": "xxxx",
      "credential": "yyyy",
    }
  ]
}

*/
