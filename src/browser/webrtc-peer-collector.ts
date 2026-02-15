import { IPeer } from "./signal/impl/signal-room";
import { EnterRoom, enterRoom } from "./signal/signal-room";

export type SigType = "offer" | "answer" | "ice" | "request-ice" | "broadcast";
export type SigPayload = {
  offer?: RTCSessionDescriptionInit;
  answer?: RTCSessionDescriptionInit;
  ice?: RTCIceCandidateInit;
} & Record<string, any>;

type UserState = {
  pc?: RTCPeerConnection;

  // ICE that arrived before we had remoteDescription
  pendingRemoteIce: RTCIceCandidateInit[];

  // the signaling "user" handle so we can send messages
  peer: IPeer<SigType, SigPayload>;

  expirationTimeout?: number;
  close(): void;
  reset(): void;
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
    retryIce: () => Promise<{ url: string }>,
  ): Promise<RTCConfiguration & { timestamp: number }> {
    if (iceUrl) {
      let retries = 3;
      for (let r = 0; r < retries; r++) {
        try {
          const r = await fetch(iceUrl);
          if (!r.ok) throw new Error(`ICE endpoint failed: ${r.status}`);
          rtcConfig = (await r.json()) as RTCConfiguration & {
            timestamp: number;
          };
          return rtcConfig;
        } catch (e) {
          console.warn("Failed fetching iceUrl");
        }
        iceUrl = (await retryIce()).url;
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
      p.close();
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
          userId: state.peer.userId,
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
      async function setupPC(state: UserState) {
        const now = Date.now();
        if (now - (rtcConfig?.timestamp ?? 0) > 10000) {
          const ice =
            !iceUrl || iceUrl.expiration - now < 2000
              ? await requestIce()
              : iceUrl;
          rtcConfig = await getRtcConfig(ice.url, requestIce);
        }
        state.pc = new RTCPeerConnection(rtcConfig);
        // Send local ICE candidates to this peer
        state.pc.onicecandidate = (ev) => {
          if (!ev.candidate) return;
          state.peer.receive("ice", { ice: ev.candidate.toJSON() });
        };

        state.pc.onconnectionstatechange = async () => {
          logLine?.("💬", {
            event: "pc-state",
            userId: state.peer.userId,
            state: state.pc?.connectionState,
          });
          if (state.pc?.connectionState === "failed") {
            //  reset the connection
            state.close();
            const userState = await getPeer(state.peer, true);
            if (userState.pc) {
              receivePeerConnection({
                pc: userState.pc,
                userId: userState.peer.userId,
                restart: () => userState.close(),
              });
            } else {
              logLine?.("👤ℹ️", "no pc: " + userState.peer.userId);
            }
            return;
          }
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
            pendingRemoteIce: [],
            peer,
            close() {
              this.pc?.close();
              this.pc = undefined;
              users.delete(peer.userId);
            },
            async reset() {
              newState.close();
              const userState = await getPeer(peer, true);
              console.log(">>", userState.peer.userId);

              setTimeout(async () => {
                if (!userState.pc) {
                  console.log("no pc");
                  return;
                }
                receivePeerConnection({
                  pc: userState.pc,
                  userId: userState.peer.userId,
                  restart: () => userState.close(),
                });
                await makeOffer(userState.peer);
              }, 3000);
            },
          };

          console.log("setupPC on new state");
          await setupPC(newState);
          console.log("Done setupPC on new state");
          state = newState;

          //  New user
          users.set(state.peer.userId, state);
        } else if (state) {
          clearTimeout(state.expirationTimeout);
          state.expirationTimeout = 0;
          if (!state.pc || state.pc.signalingState === "closed") {
            console.log("setupPC on existing state");
            await setupPC(state);
            console.log("Done setupPC on existing state");
          }
        }
        state.peer = peer;
        return state;
      }

      async function makeOffer(user: IPeer<SigType, SigPayload>) {
        // Offer flow: createOffer -> setLocalDescription -> send localDescription
        const state = await getPeer(user);
        const pc = state.pc;
        const offer = await pc?.createOffer();
        await pc?.setLocalDescription(offer);
        user.receive("offer", { offer: pc!.localDescription!.toJSON() });
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
            const state = await getPeer(user, true);
            const pc = state.pc;
            if (!pc) {
              logLine?.("👤ℹ️", "no pc: " + user.userId);
              return;
            }

            receivePeerConnection({
              pc,
              userId: user.userId,
              restart: () => state.close(),
            });
            await makeOffer(user);
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

        async onMessage(
          type: SigType,
          payload: SigPayload,
          from: IPeer<SigType, SigPayload>,
        ) {
          console.log("Message in.", type);
          const state = await getPeer(from);
          console.log("Message in", type, state.pc?.signalingState);
          logLine?.("💬", {
            type,
            preSignalingState: state.pc?.signalingState,
          });
          const pc =
            state.pc && state.pc.signalingState !== "closed"
              ? state.pc
              : await setupPC(state);
          logLine?.("💬", { type, signalingState: pc.signalingState });

          if (type === "offer" && payload.offer) {
            console.log("Got offer. State: " + pc.signalingState);
            const newPCc =
              pc.signalingState === "stable" ? await setupPC(state) : pc; //  reset
            console.log("Got new PC");
            receivePeerConnection({
              pc: newPCc,
              userId: from.userId,
              restart: () => state.close(),
            });
            // Responder: set remote offer
            await newPCc.setRemoteDescription(payload.offer);
            console.log("Set remote");

            // Create and send answer
            const answer = await newPCc.createAnswer();
            await newPCc.setLocalDescription(answer);
            console.log("Set answer");

            from.receive("answer", {
              answer: newPCc.localDescription?.toJSON(),
            });

            // Now safe to apply any queued ICE from this peer
            await flushRemoteIce(state);
            console.log("Flush");
            return;
          }

          if (type === "answer" && payload.answer) {
            // Initiator: set remote answer
            await pc.setRemoteDescription(payload.answer);
            await flushRemoteIce(state);
            return;
          }

          if (type === "ice" && payload.ice) {
            // If we don't have remoteDescription yet, queue it
            if (!pc.remoteDescription) {
              state.pendingRemoteIce.push(payload.ice);
              return;
            }

            try {
              await state.pc?.addIceCandidate(payload.ice);
            } catch (e) {
              logLine?.("⚠️ ERROR", {
                error: "add-ice-failed",
                userId: state.peer.userId,
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
        broadcast: (payload) => sendToServer("broadcast", payload),
      });
    });
  }

  return {
    userId,
    enterRoom: enter,
    exitRoom: exit,
    leaveUser,
    async reset(userId: string) {
      const userState = users.get(userId);
      userState?.reset();
    },
    broadcast<P extends any>(payload: P) {
      roomsEntered.forEach((room) => room.broadcast(payload));
    },
    end() {
      roomsEntered.forEach(({ exitRoom }) => exitRoom());
      roomsEntered.clear();
      users.forEach(({ peer }) => leaveUser(peer.userId));
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
