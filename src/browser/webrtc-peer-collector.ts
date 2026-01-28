import { IPeer } from "./signal/impl/signal-room";
import { EnterRoom, enterRoom } from "./signal/signal-room";

export type SigType = "offer" | "answer" | "ice" | "request-ice" | "broadcast";
export type SigPayload = RTCSessionDescriptionInit | RTCIceCandidateInit;

type UserState = {
  userId: string;
  pc?: RTCPeerConnection;

  // ICE that arrived before we had remoteDescription
  pendingRemoteIce: RTCIceCandidateInit[];

  // the signaling "user" handle so we can send messages
  peer: IPeer<SigType, SigPayload>;

  expirationTimeout?: number;
  initiateForThisUser: boolean;
  close: () => void;
};

const DEFAULT_ENTER_ROOM = enterRoom;

export function collectPeerConnections({
  userId: passedUserId,
  worldId,
  receivePeerConnection,
  peerlessUserExpiration = 5000,
  fallbackRtcConfig = {
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  },
  enterRoomFunction: enterRoom = DEFAULT_ENTER_ROOM,
  logLine,
  onLeaveUser,
  workerUrl,
  onRoomReady,
  onRoomClose,
  onBroadcastMessage,
}: {
  userId?: string;
  worldId: string;
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
  onBroadcastMessage?<P extends any>(payload: P, from: string): void;
}) {
  const userId = passedUserId ?? `user-${crypto.randomUUID()}`;
  const users: Map<string, UserState> = new Map();
  let iceUrl: { url: string; expiration: number } | undefined = undefined;
  let rtcConfig: RTCConfiguration & { timestamp: number } = {
    ...fallbackRtcConfig,
    timestamp: Date.now(),
  };

  const roomsEntered = new Map<
    string,
    {
      room: string;
      host: string;
      exitRoom: () => void;
      broadcast: <P extends any>(payload: P) => void;
    }
  >();

  async function getRtcConfig(
    iceUrl: string,
  ): Promise<RTCConfiguration & { timestamp: number }> {
    if (iceUrl) {
      try {
        const r = await fetch(iceUrl);
        if (!r.ok) throw new Error(`ICE endpoint failed: ${r.status}`);
        rtcConfig = (await r.json()) as RTCConfiguration & {
          timestamp: number;
        };
      } catch (e) {
        console.warn("Using fallback rtcConfig:", e);
      }
    }
    return rtcConfig;
  }

  function leaveUser(userId: string) {
    onLeaveUser?.(userId);
    const p = users.get(userId);
    if (!p) return;
    users.delete(userId);
    try {
      p.pc?.close();
    } catch {}
  }

  async function flushRemoteIce(state: UserState) {
    if (!state.pc?.remoteDescription) return;

    const queued = state.pendingRemoteIce;
    state.pendingRemoteIce = [];

    for (const ice of queued) {
      try {
        await state.pc.addIceCandidate(ice);
      } catch (e) {
        logLine?.("⚠️ ERROR", {
          error: "add-ice-failed",
          userId: state.userId,
          detail: String(e),
        });
      }
    }
  }

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
      async function restartInitiator(user: IPeer) {
        const state = users.get(user.userId);
        if (!state) return; //  user left
        state.close();
        const pc = await setupPC(state);
        receivePeerConnection({
          pc,
          userId: user.userId,
          initiator: true,
          restart: () => restartInitiator(user),
        });
        await new Promise((resolve) => setTimeout(resolve, 3000));
        await makeOffer(user);
      }

      async function setupPC(state: UserState) {
        const now = Date.now();
        if (now - (rtcConfig?.timestamp ?? 0) > 10000) {
          const ice =
            !iceUrl || iceUrl.expiration - now < 2000
              ? await requestIce()
              : iceUrl;
          rtcConfig = await getRtcConfig(ice.url);
        }
        state.pc = new RTCPeerConnection(rtcConfig);
        // Send local ICE candidates to this peer
        state.pc.onicecandidate = (ev) => {
          if (!ev.candidate) return;
          state.peer.receive("ice", ev.candidate.toJSON());
        };

        state.pc.onconnectionstatechange = () => {
          logLine?.("💬", {
            event: "pc-state",
            userId: state.userId,
            state: state.pc?.connectionState,
          });
        };

        return state.pc;
      }

      async function getPeer(
        peer: IPeer<SigType, SigPayload>,
        forceReset?: boolean,
      ): Promise<UserState> {
        let state = users.get(peer.userId);
        if (!state || forceReset) {
          const newState: UserState = {
            userId: peer.userId,
            pendingRemoteIce: [],
            peer,
            initiateForThisUser: state?.initiateForThisUser ?? false,
            close() {
              this.pc?.close();
              this.pc = undefined;
            },
          };

          await setupPC(newState);
          state = newState;

          //  New user
          users.set(state.userId, state);
        } else if (state) {
          clearTimeout(state.expirationTimeout);
          state.expirationTimeout = 0;
        }
        if (!state.pc || state.pc?.signalingState === "closed") {
          await setupPC(state);
        }
        state.peer = peer;
        return state;
      }

      async function makeOffer(user: IPeer) {
        // Offer flow: createOffer -> setLocalDescription -> send localDescription
        const state = await getPeer(user);
        const pc = state.pc;
        const offer = await pc?.createOffer();
        await pc?.setLocalDescription(offer);
        user.receive("offer", pc?.localDescription?.toJSON()!);
      }

      let icePromiseResolve:
        | undefined
        | ((url: { url: string; expiration: number }) => void);
      async function requestIce() {
        const iceUrl = await new Promise<{ url: string; expiration: number }>(
          (resolve) => {
            icePromiseResolve = resolve;
            sendToServer("request-ice");
          },
        );
        icePromiseResolve = undefined;
        return iceUrl;
      }

      const { exitRoom, sendToServer } = enterRoom({
        userId,
        worldId,
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
        onClose(ev: Pick<CloseEvent, "reason" | "code" | "wasClean">) {
          onRoomClose?.({ room, host, ev });
        },

        // Existing peers initiate to the newcomer
        onPeerJoined(joiningUsers: IPeer<SigType, SigPayload>[]) {
          joiningUsers.forEach(async (user) => {
            const hadState = users.has(user.userId);
            const state = await getPeer(user, true);
            if (!hadState) {
              state.initiateForThisUser = true;
            }
            const pc = state.pc;
            if (!pc) {
              logLine?.("👤ℹ️", "no pc: " + user.userId);
              return;
            }

            receivePeerConnection({
              pc,
              userId: user.userId,
              initiator: state.initiateForThisUser,
              restart: state.initiateForThisUser
                ? () => restartInitiator(user)
                : () => state.close(),
            });
            if (state.initiateForThisUser) {
              await makeOffer(user);
            }
          });
        },

        onPeerLeft(leavingUsers: { userId: string }[]) {
          leavingUsers.forEach(({ userId }) => {
            const state = users.get(userId);
            if (!state) return;
            state.expirationTimeout = setTimeout(
              () => leaveUser(userId),
              peerlessUserExpiration ?? 0,
            );
          });
        },

        onIceUrl(url: string, expiration: number) {
          iceUrl = { url, expiration };
          icePromiseResolve?.(iceUrl);
        },

        async onMessage(type: SigType, payload: any, from: IPeer) {
          const state = await getPeer(from);
          const pc = state.pc;
          if (!pc) return;

          if (type === "offer") {
            state.initiateForThisUser = false;
            receivePeerConnection({
              pc,
              userId: from.userId,
              initiator: false,
              restart() {
                //  reset PC
                state.close();
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
              logLine?.("⚠️ ERROR", {
                error: "add-ice-failed",
                userId: state.userId,
                detail: String(e),
              });
            }
            return;
          }

          if (type === "broadcast") {
            onBroadcastMessage?.(payload, from.userId);
          }
        },
      });
      roomsEntered.set(`${host}/room/${room}`, {
        exitRoom,
        room,
        host,
        broadcast: (payload) => {
          sendToServer("broadcast", payload);
        },
      });
    });
  }

  return {
    userId,
    enterRoom: enter,
    exitRoom: exit,
    leaveUser,
    broadcast<P extends any>(payload: P) {
      roomsEntered.forEach((room) => room.broadcast(payload));
    },
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
