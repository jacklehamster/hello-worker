import { IPeer } from "./impl/signal-room";
import { EnterRoom, enterRoom } from "./signal-room";

export type SigType = "offer" | "answer" | "ice";
export type SigPayload = RTCSessionDescriptionInit | RTCIceCandidateInit;

type UserState = {
  userId: string;
  pc: RTCPeerConnection;

  // ICE that arrived before we had remoteDescription
  pendingRemoteIce: RTCIceCandidateInit[];

  // the signaling "user" handle so we can send messages
  peers: Map<string, IPeer<SigType, SigPayload>>;

  expirationTimeout?: number;
};
type UserListener = (user: string, action: "join"|"leave") => void;

const DEFAULT_ENTER_ROOM = enterRoom;


export function collectPeerConnections({
  userId,
  appId,
  receivePeerConnection,
  peerlessUserExpiration,
  rtcConfig = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] },
  enterRoomFunction: enterRoom = DEFAULT_ENTER_ROOM,
  logLine = console.debug,
  onLeaveUser,
  workerUrl,
}: {
  userId: string;
  appId: string;
  rtcConfig?: RTCConfiguration;
  enterRoomFunction?: EnterRoom<SigType, SigPayload>;
  onLeaveUser?: (userId: string) => void;
  logLine?: (direction: string, obj?: any) => void;
  workerUrl?: URL;
  peerlessUserExpiration?: number;
  receivePeerConnection(connection: { pc: RTCPeerConnection, userId: string, initiator: boolean }): void;
}) {
  const users: Map<string, UserState> = new Map();

  function getPeer(peer: IPeer<SigType, SigPayload>): UserState {
    let state = users.get(peer.userId);
    if (!state) {
        const newState: UserState = {
          userId: peer.userId,
          pc: new RTCPeerConnection(rtcConfig),
          pendingRemoteIce: [],
          peers: new Map(),
        };
        newState.peers.set(peer.peerId, peer);
        users.set(peer.userId, newState);

        // Send local ICE candidates to this peer
        newState.pc.onicecandidate = (ev) => {
          if (!ev.candidate) return;
          for(let user of newState.peers.values()) {
              const success = user.receive("ice", ev.candidate.toJSON());
              if (success) break;
          }
        };
            
        newState.pc.onconnectionstatechange = () => {
          logLine("💬", { event: "pc-state", userId: newState.userId, state: newState.pc.connectionState });
        };
        state = newState;

        //  New user
        users.set(state.userId, state);
    } else if (state) {
      clearTimeout(state.expirationTimeout);
      state.expirationTimeout = 0;
      state.peers.set(peer.peerId, peer);
    }
    return state;
  }

  function leaveUser(userId: string) {
    onLeaveUser?.(userId);
    const p = users.get(userId);
    if (!p) return;
    try { p.pc.close(); } catch {}
    users.delete(userId);
  }

  async function flushRemoteIce(state: UserState) {
    if (!state.pc.remoteDescription) return;

    const queued = state.pendingRemoteIce;
    state.pendingRemoteIce = [];

    for (const ice of queued) {
      try {
        await state.pc.addIceCandidate(ice);
      } catch (e) {
        logLine("⚠️ ERROR", { error: "add-ice-failed", userId: state.userId, detail: String(e) });
      }
    }
  }

  const roomsEntered = new Map<string, { room: string; host: string; exitRoom: () => void }>();

  function exit({ room, host }: { room: string; host: string; }) {
    const key = `${host}/room/${room}`;
    const session = roomsEntered.get(key);
    if (session) {
      session.exitRoom();
      roomsEntered.delete(key);
    }
  }

  function enter({ room, host }: { room: string; host: string; }) {
    return new Promise<void>((resolve, reject) => {
      async function makeOffer(user: IPeer) {
          // Offer flow: createOffer -> setLocalDescription -> send localDescription
          const state = getPeer(user);
          const pc = state.pc;
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          user.receive("offer", pc.localDescription?.toJSON()!);
      }

      const { exitRoom } = enterRoom({
        userId,
        appId,
        room,
        host,
        logLine,
        workerUrl,

        onOpen: resolve,
        onError: reject,

        // Existing peers initiate to the newcomer (Option 1)
        onPeerJoined(joiningUsers: IPeer<SigType, SigPayload>[]) {
          joiningUsers.forEach(user => {
            const state = getPeer(user);
            const pc = state.pc;
            receivePeerConnection({ pc, userId: user.userId, initiator: true });
            makeOffer(user);
          });
        },

        onPeerLeft(leavingUsers: { userId: string; peerId: string }[]) {
          console.log("LEFT", leavingUsers);
          leavingUsers.forEach(({ userId, peerId }) => {
            const state = users.get(userId);
            if (!state) return;
            state.peers.delete(peerId);
            if (state.peers.size === 0) {
              state.expirationTimeout = setTimeout(() => leaveUser(userId), peerlessUserExpiration ?? 0);
            }
          });
        },

        async onMessage(type: SigType, payload: any, from: IPeer) {
          const state = getPeer(from);
          const pc = state.pc;

          if (type === "offer") {
            receivePeerConnection({ pc, userId: from.userId, initiator: false });
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
              logLine("⚠️ ERROR", { error: "add-ice-failed", userId: state.userId, detail: String(e) });
            }
            return;
          }
        },
      });
      roomsEntered.set(`${host}/room/${room}`, { exitRoom, room, host });
    });
  }

  return {
    enterRoom: enter,
    exitRoom: exit,
    leaveUser,
    getRooms() {
      return Array.from(roomsEntered.values());
    },
    end() {
      roomsEntered.forEach(({ exitRoom }) => exitRoom());
      roomsEntered.clear();
      users.forEach(({ userId }) => leaveUser(userId));
      users.clear();
    },
  };
}



