import { IceUrlProvider } from "./utils/ice-url-provider";
import { IPeer } from "./signal/impl/signal-room";
import { EnterRoom, enterRoom } from "./signal/signal-room";
import { RTCConfigProvider } from "./utils/rtc-config";

export type SigType = "offer" | "answer" | "ice" | "request-ice" | "broadcast";
export type SigPayload = {
  connectionId?: string;
  offer?: RTCSessionDescriptionInit;
  answer?: RTCSessionDescriptionInit;
  ice?: RTCIceCandidateInit;
} & Record<string, any>;

interface Connection {
  id: string;
  peerConnectionId?: string;
  pc: RTCPeerConnection;
  // ICE that arrived before we had remoteDescription
  pendingRemoteIce: RTCIceCandidateInit[];
}

type UserState = {
  connection?: Connection;

  // the signaling "user" handle so we can send messages
  peer: string;
  joined?: number;

  expirationTimeout?: number;
  close(): void;
  reset(): void;
  connectionPromise?: Promise<Connection>;
};

const DEFAULT_ENTER_ROOM = enterRoom;

/**
 * Collect peers
 */
export function collectPeerConnections({
  userId: passedUserId,
  worldId,
  receivePeerConnection,
  peerlessUserExpiration = 5000,
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

  const roomsEntered = new Map<
    string,
    {
      room: string;
      host: string;
      exitRoom: () => void;
      broadcast: <P extends any>(payload: P) => void;
    }
  >();

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
    if (!state.connection?.pc?.remoteDescription) return;

    const queued = state.connection.pendingRemoteIce;
    state.connection.pendingRemoteIce = [];

    for (const ice of queued) {
      try {
        await state.connection.pc.addIceCandidate(ice);
      } catch (e) {
        logLine?.("⚠️ ERROR", {
          error: "add-ice-failed",
          userId: state.peer,
          detail: String(e),
        });
      }
    }
  }

  const iceUrlProvider = new IceUrlProvider();
  const rtcConfigProvider = new RTCConfigProvider(iceUrlProvider);

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
      async function setupConnection(state: UserState) {
        if (state.connectionPromise) {
          return state.connectionPromise;
        }
        const promise = new Promise<Connection>(async (resolve) => {
          state.connection = {
            id: `conn-${crypto.randomUUID()}`,
            pc: new RTCPeerConnection(await rtcConfigProvider.getRtcConfig()),
            pendingRemoteIce: [],
          };

          // Send local ICE candidates to this peer
          state.connection.pc.onicecandidate = (ev) => {
            if (!ev.candidate) return;
            send("ice", state.peer, {
              connectionId: state.connection?.id,
              ice: ev.candidate.toJSON(),
            });
          };

          state.connection.pc.onconnectionstatechange = async () => {
            logLine?.("💬", {
              event: "pc-state",
              userId: state.peer,
              state: state.connection?.pc?.connectionState,
            });
            if (state.connection?.pc?.connectionState === "failed") {
              //  reset the connection
              state.close();
              const userState = await getPeer(state.peer, true);
              if (userState.connection?.pc) {
                receivePeerConnection({
                  pc: userState.connection?.pc,
                  userId: userState.peer,
                  restart: () => userState.close(),
                });
              } else {
                logLine?.("👤ℹ️", "no pc: " + userState.peer);
              }
              return;
            }
          };

          resolve(state.connection);
        });
        state.connectionPromise = promise;
        await promise;
        state.connectionPromise = undefined;
        return promise;
      }

      async function getPeer(
        peer: string,
        forceReset?: boolean,
      ): Promise<UserState> {
        let state = users.get(peer);
        if (!state || forceReset) {
          const newState: UserState = {
            peer,
            close() {
              if (this.connection) {
                this.connection.pc.close();
                this.connection = undefined;
              }
              users.delete(peer);
            },
            async reset() {
              newState.close();

              setTimeout(async () => {
                const userState = await getPeer(peer, true);
                if (!userState.connection?.pc) {
                  logLine?.("⚠️", "no pc");
                  return;
                }
                receivePeerConnection({
                  pc: userState.connection?.pc,
                  userId: userState.peer,
                  restart: () => userState.close(),
                });
                await makeOffer(userState.peer);
              }, 500);
            },
          };
          state = newState;

          await setupConnection(newState);

          //  New user
          users.set(state.peer, state);
        } else if (state) {
          clearTimeout(state.expirationTimeout);
          state.expirationTimeout = 0;
          if (
            !state.connection?.pc ||
            state.connection?.pc.signalingState === "closed"
          ) {
            await setupConnection(state);
          }
        }
        state.peer = peer;
        return state;
      }

      async function makeOffer(userId: string) {
        // Offer flow: createOffer -> setLocalDescription -> send localDescription
        const state = await getPeer(userId);
        const pc = state.connection?.pc;
        const offer = await pc?.createOffer();
        await pc?.setLocalDescription(offer);
        send("offer", userId, {
          connectionId: state.connection?.id,
          offer: pc?.localDescription?.toJSON(),
        });
      }

      const { exitRoom, send } = enterRoom({
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
        onPeerJoined(joiningUsers: IPeer[], selfJoined: number) {
          joiningUsers.forEach(async (user) => {
            const state = await getPeer(user.userId, true);
            state.joined = user.joined;
            const pc = state.connection?.pc;
            if (!pc) {
              logLine?.("👤ℹ️", "no pc: " + user.userId);
              return;
            }

            receivePeerConnection({
              pc,
              userId: user.userId,
              restart: () => state.close(),
            });
            if (
              user.joined > selfJoined ||
              (user.joined === selfJoined &&
                user.userId.localeCompare(userId) > 0)
            ) {
              await makeOffer(user.userId);
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
          iceUrlProvider.receiveIce(url, expiration);
        },

        async onMessage(type, payload, from: string) {
          if (type === "offer" && payload.offer) {
            //  Grab state and connection
            const state = await getPeer(from, false);
            const connection =
              !state.connection ||
              state.connection.pc.signalingState === "stable"
                ? await setupConnection(state)
                : state.connection; //  reset
            logLine?.("💬", {
              type,
              signalingState: connection.pc.signalingState,
            });

            connection.peerConnectionId = payload.connectionId;
            receivePeerConnection({
              pc: connection.pc,
              userId: from,
              restart: () => state.close(),
            });
            // Responder: set remote offer
            await connection.pc.setRemoteDescription(payload.offer);

            // Create and send answer
            const answer = await connection.pc.createAnswer();
            await connection.pc.setLocalDescription(answer);

            send("answer", from, {
              connectionId: connection.id,
              answer: connection.pc.localDescription?.toJSON(),
            });

            // Now safe to apply any queued ICE from this peer
            await flushRemoteIce(state);
            return;
          }

          if (type === "answer" && payload.answer) {
            const state = await getPeer(from, false);
            const connection =
              state.connection &&
              state.connection.pc.signalingState !== "closed"
                ? state.connection
                : await setupConnection(state);
            logLine?.("💬", {
              type,
              signalingState: connection.pc.signalingState,
            });

            // Initiator: set remote answer
            await connection.pc.setRemoteDescription(payload.answer);
            connection.peerConnectionId = payload.connectionId;
            await flushRemoteIce(state);
            return;
          }

          if (type === "ice" && payload.ice) {
            //  Grab state and connection
            const state = await getPeer(from, false);
            const connection =
              state.connection ?? (await state.connectionPromise);
            if (!connection) {
              logLine?.("⚠️", "No connection");
              return;
            }
            logLine?.("💬", {
              type,
              signalingState: connection.pc.signalingState,
            });

            if (
              connection.peerConnectionId &&
              payload.connectionId !== connection.peerConnectionId
            ) {
              logLine?.(
                "⚠️",
                "Mismatch peerConnectionID" +
                  payload.connectionId +
                  "vs" +
                  connection.peerConnectionId,
              );
              return;
            }

            // If we don't have remoteDescription yet (or if connectionId doesn't match), queue it
            if (
              !connection.pc.remoteDescription ||
              !connection.peerConnectionId
            ) {
              connection.peerConnectionId = payload.connectionId;
              connection.pendingRemoteIce.push(payload.ice);
              return;
            }

            try {
              await connection.pc.addIceCandidate(payload.ice);
            } catch (e) {
              logLine?.("⚠️ ERROR", {
                error: "add-ice-failed",
                userId: state.peer,
                detail: String(e),
              });
            }
            return;
          }

          if (type === "broadcast") {
            onBroadcastMessage?.(payload, from);
          }
        },
      });

      const removeRequester = iceUrlProvider.addRequester((command) =>
        send(command, "server"),
      );

      roomsEntered.set(`${host}/room/${room}`, {
        exitRoom: () => {
          exitRoom();
          removeRequester();
        },
        room,
        host,
        broadcast: (payload) => send("broadcast", "server", payload),
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
      users.forEach(({ peer }) => leaveUser(peer));
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
