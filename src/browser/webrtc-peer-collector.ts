import { IPeer } from "./signal/impl/signal-room";
import { EnterRoom, enterRoom } from "./signal/signal-room";

export type SigType = "offer" | "answer" | "ice" | "request-ice" | "broadcast";
export type SigPayload = RTCSessionDescriptionInit | RTCIceCandidateInit;

type UserState = {
  pc?: RTCPeerConnection;

  // ICE that arrived before we had remoteDescription
  pendingRemoteIce: RTCIceCandidateInit[];

  // the signaling "user" handle so we can send messages
  peer: IPeer<SigType, SigPayload>;

  expirationTimeout?: number;

  // ✅ prevent concurrent setupPC for the same user
  setupPromise?: Promise<RTCPeerConnection>;

  // ✅ serialize all peer operations (offer/answer/ice) per user
  opChain?: Promise<void>;

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
          const resp = await fetch(iceUrl);
          if (!resp.ok) throw new Error(`ICE endpoint failed: ${resp.status}`);
          rtcConfig = (await resp.json()) as RTCConfiguration & {
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
      /**
       * Create a new RTCPeerConnection and attach handlers.
       * NOTE: This should ONLY be called via ensurePC/resetPC so it cannot run concurrently.
       */
      async function setupPC(state: UserState) {
        const now = Date.now();
        if (now - (rtcConfig?.timestamp ?? 0) > 10000) {
          const ice =
            !iceUrl || iceUrl.expiration - now < 2000
              ? await requestIce()
              : iceUrl;
          rtcConfig = await getRtcConfig(ice.url, requestIce);
        }

        const pc = new RTCPeerConnection(rtcConfig);
        state.pc = pc;

        // Send local ICE candidates to this peer
        pc.onicecandidate = (ev) => {
          if (!ev.candidate) return;
          state.peer.receive("ice", ev.candidate.toJSON());
        };

        pc.onconnectionstatechange = async () => {
          logLine?.("💬", {
            event: "pc-state",
            userId: state.peer.userId,
            state: state.pc?.connectionState,
          });

          if (state.pc?.connectionState === "failed") {
            // reset the connection in a serialized way
            // (don't call getPeer(forceReset) here; keep the same state)
            try {
              await resetPC(state);
              if (state.pc) {
                receivePeerConnection({
                  pc: state.pc,
                  userId: state.peer.userId,
                  restart: () => state.close(),
                });
                // You previously did an offer on reset via your reset() path.
                // We keep behavior by offering after a failure reset.
                await makeOffer(state.peer);
              }
            } catch (e) {
              logLine?.("⚠️ ERROR", {
                error: "pc-reset-failed",
                userId: state.peer.userId,
                detail: String(e),
              });
            }
          }
        };

        return pc;
      }

      /**
       * ✅ Single-flight PC setup per state.
       */
      function ensurePC(state: UserState): Promise<RTCPeerConnection> {
        if (state.pc && state.pc.signalingState !== "closed") {
          return Promise.resolve(state.pc);
        }
        if (state.setupPromise) return state.setupPromise;

        state.setupPromise = (async () => {
          return await setupPC(state);
        })().finally(() => {
          state.setupPromise = undefined;
        });

        return state.setupPromise;
      }

      /**
       * ✅ Reset the PC exactly once, safely.
       */
      async function resetPC(state: UserState): Promise<RTCPeerConnection> {
        // If a setup is in flight, wait for it so we don't race close vs init.
        if (state.setupPromise) {
          try {
            await state.setupPromise;
          } catch {
            // ignore; we'll proceed to rebuild
          }
        }

        try {
          state.pc?.close();
        } catch {}
        state.pc = undefined;
        // pending ICE no longer valid for the old pc
        state.pendingRemoteIce = [];

        return await ensurePC(state);
      }

      /**
       * Get or create state.
       * - Creates exactly one state per userId (stores it before awaiting).
       * - Does NOT reset by default; resets are explicit via resetPC.
       */
      async function getPeer(
        peer: IPeer<SigType, SigPayload>,
      ): Promise<UserState> {
        let state = users.get(peer.userId);
        if (!state) {
          const newState: UserState = {
            pendingRemoteIce: [],
            peer,
            close() {
              try {
                this.pc?.close();
              } catch {}
              this.pc = undefined;
              this.setupPromise = undefined;
              this.opChain = undefined;
              users.delete(peer.userId);
            },
            reset() {
              // Maintain external behavior: same signature; do a safe reset + re-offer after a delay
              const self = this;
              // serialize the reset with opChain so it doesn't interleave with message handling
              self.opChain = (self.opChain ?? Promise.resolve()).then(
                async () => {
                  await resetPC(self);

                  setTimeout(async () => {
                    if (!self.pc) return;
                    receivePeerConnection({
                      pc: self.pc,
                      userId: self.peer.userId,
                      restart: () => self.close(),
                    });
                    await makeOffer(self.peer);
                  }, 3000);
                },
              );
            },
          };

          // ✅ Put in map immediately so concurrent callers share it
          users.set(peer.userId, newState);

          // Ensure we have a PC (single-flight)
          console.log("setupPC on new state");
          await ensurePC(newState);
          console.log("Done setupPC on new state");

          state = newState;
        } else {
          // refresh peer handle and cancel expiration
          clearTimeout(state.expirationTimeout);
          state.expirationTimeout = 0;
        }

        state.peer = peer;
        return state;
      }

      async function makeOffer(user: IPeer) {
        const state = await getPeer(user);
        // serialize offer creation so we don't overlap with other operations
        state.opChain = (state.opChain ?? Promise.resolve()).then(async () => {
          const pc = await ensurePC(state);
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          user.receive("offer", pc.localDescription?.toJSON()!);
        });
        return state.opChain;
      }

      // ✅ single-flight ICE request handling (prevents overwriting resolver)
      let icePromiseResolve:
        | undefined
        | ((url: { url: string; expiration: number }) => void);
      let iceInFlight: Promise<{ url: string; expiration: number }> | undefined;

      async function requestIce() {
        if (!iceInFlight) {
          iceInFlight = new Promise<{ url: string; expiration: number }>(
            (resolve) => {
              icePromiseResolve = resolve;
              sendToServer("request-ice");
            },
          ).finally(() => {
            icePromiseResolve = undefined;
            iceInFlight = undefined;
          });
        }
        return await iceInFlight;
      }

      /**
       * Message handling, but ALWAYS executed inside state.opChain for this peer.
       */
      async function handleMessage(
        state: UserState,
        type: SigType,
        payload: any,
        from: IPeer<SigType, SigPayload>,
      ) {
        console.log("Message in.", type);
        logLine?.("💬", {
          type,
          preSignalingState: state.pc?.signalingState,
        });

        const pc = await ensurePC(state);

        logLine?.("💬", { type, signalingState: pc.signalingState });

        if (type === "offer") {
          console.log("Got offer. State: " + pc.signalingState);

          // Previous behavior sometimes rebuilt the PC if stable.
          // That was a major source of races. Instead, only rebuild if closed.
          const activePC =
            pc.signalingState === "closed" ? await resetPC(state) : pc;

          receivePeerConnection({
            pc: activePC,
            userId: from.userId,
            restart: () => state.close(),
          });

          // Responder: set remote offer
          await activePC.setRemoteDescription(
            payload as RTCSessionDescriptionInit,
          );

          // Create and send answer
          const answer = await activePC.createAnswer();
          await activePC.setLocalDescription(answer);
          from.receive("answer", activePC.localDescription?.toJSON()!);

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
              userId: state.peer.userId,
              detail: String(e),
            });
          }
          return;
        }

        if (type === "broadcast") {
          onBroadcastMessage?.(payload, from.userId);
          return;
        }
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
            const state = await getPeer(user);

            // Serialize "new peer joined" flow
            state.opChain = (state.opChain ?? Promise.resolve()).then(
              async () => {
                const pc = await ensurePC(state);
                receivePeerConnection({
                  pc,
                  userId: user.userId,
                  restart: () => state.close(),
                });
                await makeOffer(user);
              },
            );
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

          // ✅ serialize everything per-peer so we never re-enter setup/SDP ops concurrently
          state.opChain = (state.opChain ?? Promise.resolve())
            .then(async () => {
              await handleMessage(state, type, payload, from);
            })
            .catch((e) => {
              logLine?.("⚠️ ERROR", {
                error: "onMessage-failed",
                userId: from.userId,
                detail: String(e),
              });
            });

          return state.opChain;
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
