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
      const retries = 3;
      for (let r = 0; r < retries; r++) {
        try {
          const resp = await fetch(iceUrl);
          if (!resp.ok) throw new Error(`ICE endpoint failed: ${resp.status}`);
          rtcConfig = (await resp.json()) as RTCConfiguration & {
            timestamp: number;
          };
          return rtcConfig;
        } catch {
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
      // ---------------------------------------------------------------------
      // Per-room ICE request single-flight
      // ---------------------------------------------------------------------
      let icePromiseResolve:
        | undefined
        | ((url: { url: string; expiration: number }) => void);
      let iceInFlight: Promise<{ url: string; expiration: number }> | undefined;

      // sendToServer is defined by enterRoom; we declare here and assign later
      let sendToServer: (type: SigType, payload?: any) => void = () => {};

      function requestIce(): Promise<{ url: string; expiration: number }> {
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
        return iceInFlight;
      }

      // ---------------------------------------------------------------------
      // Queue helper: the ONLY thing that mutates opChain
      // ---------------------------------------------------------------------
      function enqueue<T>(state: UserState, fn: () => Promise<T>): Promise<T> {
        const prior = state.opChain ?? Promise.resolve();
        const next = prior.then(fn);
        // store as void chain so errors don’t break future scheduling
        state.opChain = next.then(
          () => undefined,
          () => undefined,
        );
        return next;
      }

      // ---------------------------------------------------------------------
      // PeerConnection lifecycle (single-flight)
      // ---------------------------------------------------------------------
      async function setupPCNow(state: UserState): Promise<RTCPeerConnection> {
        const now = Date.now();
        if (now - (rtcConfig?.timestamp ?? 0) > 10000) {
          const ice =
            !iceUrl || iceUrl.expiration - now < 2000
              ? await requestIce()
              : iceUrl;
          rtcConfig = await getRtcConfig(ice.url, async () => {
            const v = await requestIce();
            return { url: v.url };
          });
        }

        const pc = new RTCPeerConnection(rtcConfig);
        state.pc = pc;

        pc.onicecandidate = (ev) => {
          if (!ev.candidate) return;
          state.peer.receive("ice", ev.candidate.toJSON());
        };

        pc.onconnectionstatechange = () => {
          logLine?.("💬", {
            event: "pc-state",
            userId: state.peer.userId,
            state: state.pc?.connectionState,
          });

          if (state.pc?.connectionState === "failed") {
            // serialize reset + re-offer
            enqueue(state, async () => {
              await resetPCNow(state);
              if (!state.pc) return;
              receivePeerConnection({
                pc: state.pc,
                userId: state.peer.userId,
                restart: () => state.close(),
              });
              await makeOfferNow(state);
            }).catch(() => {});
          }
        };

        return pc;
      }

      function ensurePCNow(state: UserState): Promise<RTCPeerConnection> {
        if (state.pc && state.pc.signalingState !== "closed") {
          return Promise.resolve(state.pc);
        }
        if (state.setupPromise) return state.setupPromise;

        state.setupPromise = setupPCNow(state).finally(() => {
          state.setupPromise = undefined;
        });

        return state.setupPromise;
      }

      async function resetPCNow(state: UserState): Promise<RTCPeerConnection> {
        // wait any in-flight setup to avoid close/init races
        if (state.setupPromise) {
          try {
            await state.setupPromise;
          } catch {
            // ignore
          }
        }

        try {
          state.pc?.close();
        } catch {}
        state.pc = undefined;
        state.pendingRemoteIce = [];

        return ensurePCNow(state);
      }

      // ---------------------------------------------------------------------
      // State management
      // ---------------------------------------------------------------------
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
              // preserve your external behavior: reset + re-offer after 3s
              const self = this;
              enqueue(self, async () => {
                await resetPCNow(self);
                setTimeout(() => {
                  enqueue(self, async () => {
                    if (!self.pc) return;
                    receivePeerConnection({
                      pc: self.pc,
                      userId: self.peer.userId,
                      restart: () => self.close(),
                    });
                    await makeOfferNow(self);
                  }).catch(() => {});
                }, 3000);
              }).catch(() => {});
            },
          };

          // ✅ set before any await so we never create two states
          users.set(peer.userId, newState);

          console.log("setupPC on new state");
          await ensurePCNow(newState);
          console.log("Done setupPC on new state");

          state = newState;
        } else {
          clearTimeout(state.expirationTimeout);
          state.expirationTimeout = 0;
          state.peer = peer;
        }

        state.peer = peer;
        return state;
      }

      // ---------------------------------------------------------------------
      // Signaling ops (NO enqueue inside these)
      // ---------------------------------------------------------------------
      async function makeOfferNow(state: UserState) {
        const pc = await ensurePCNow(state);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        state.peer.receive("offer", pc.localDescription?.toJSON()!);
      }

      async function handleMessageNow(
        state: UserState,
        type: SigType,
        payload: any,
        from: IPeer<SigType, SigPayload>,
      ) {
        console.log("Message in.", type);

        const pc = await ensurePCNow(state);

        logLine?.("💬", {
          type,
          preSignalingState: pc.signalingState,
        });

        if (type === "offer") {
          receivePeerConnection({
            pc,
            userId: from.userId,
            restart: () => state.close(),
          });

          await pc.setRemoteDescription(payload as RTCSessionDescriptionInit);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          from.receive("answer", pc.localDescription?.toJSON()!);

          await flushRemoteIce(state);
          return;
        }

        if (type === "answer") {
          await pc.setRemoteDescription(payload as RTCSessionDescriptionInit);
          await flushRemoteIce(state);
          return;
        }

        if (type === "ice") {
          const ice = payload as RTCIceCandidateInit;

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

      // ---------------------------------------------------------------------
      // Wire up signaling room
      // ---------------------------------------------------------------------
      const roomSession = enterRoom({
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

            // ✅ enqueue once; call only *_Now functions inside
            enqueue(state, async () => {
              const pc = await ensurePCNow(state);

              receivePeerConnection({
                pc,
                userId: user.userId,
                restart: () => state.close(),
              });

              await makeOfferNow(state);
            }).catch((e) => {
              logLine?.("⚠️ ERROR", {
                error: "peer-joined-flow-failed",
                userId: user.userId,
                detail: String(e),
              });
            });
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

          // ✅ enqueue once; handleMessageNow does not enqueue
          return enqueue(state, async () => {
            await handleMessageNow(state, type, payload, from);
          }).catch((e) => {
            logLine?.("⚠️ ERROR", {
              error: "onMessage-failed",
              userId: from.userId,
              detail: String(e),
            });
          });
        },
      });

      sendToServer = roomSession.sendToServer;

      roomsEntered.set(`${host}/room/${room}`, {
        exitRoom: roomSession.exitRoom,
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
