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
  peers: Set<IPeer<SigType, SigPayload>>;
};

const DEFAULT_ENTER_ROOM = enterRoom;


export function collectPeerConnections({
  userId,
  receivePeerConnection,
  leaveUserWithoutPeer = false,
  rtcConfig = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] },
  enterRoomFunction: enterRoom = DEFAULT_ENTER_ROOM,
  logLine = console.debug,
  onLeaveUser,
  workerUrl,
}: {
  userId: string;
  rtcConfig?: RTCConfiguration;
  enterRoomFunction?: EnterRoom<SigType, SigPayload>;
  onLeaveUser?: (userId: string) => void;
  logLine?: (direction: string, obj?: any) => void;
  workerUrl?: URL;
  leaveUserWithoutPeer?: boolean;
  receivePeerConnection(connection: { pc: RTCPeerConnection, userId: string, initiator: boolean }): void;
}) {
  const users: Map<string, UserState> = new Map();
  function getUsers() {
    return [...users.keys()];
  }

  const userListener: Set<(user: string, users: string[]) => void> = new Set();
  function getPeer(peer: IPeer<SigType, SigPayload>): UserState {
    let state = users.get(peer.userId);
    if (!state) {
        const newState: UserState = {
          userId: peer.userId,
          pc: new RTCPeerConnection(rtcConfig),
          pendingRemoteIce: [],
          peers: new Set([peer]),
        };
        users.set(peer.userId, newState);

        // Send local ICE candidates to this peer
        newState.pc.onicecandidate = (ev) => {
          if (!ev.candidate) return;
          for(let user of newState.peers) {
              const success = user.receive("ice", ev.candidate.toJSON());
              if (success) break;
          }
        };
            
        newState.pc.onconnectionstatechange = () => {
          logLine("💬", { event: "pc-state", userId: newState.userId, state: newState.pc.connectionState });
        };
        state = newState;

        console.log(peer.userId, getUsers());

        //  New user
        userListener.forEach(listener => listener(peer.userId, getUsers()));
    } else {
      state.peers.add(peer);
    }
    users.set(state.userId, state);
    return state;
  }

  function leaveUser(userId: string) {
    onLeaveUser?.(userId);
    const p = users.get(userId);
    if (!p) return;
    try { p.pc.close(); } catch {}
    users.delete(userId);
    logLine("👤 USER LEFT", userId);
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
    const { exitRoom } = enterRoom({
      userId,
      room,
      host,
      logLine,
      workerUrl,

      // Existing peers initiate to the newcomer (Option 1)
      async onPeerJoined(user: IPeer) {
        const state = getPeer(user);
        const pc = state.pc;
        receivePeerConnection({ pc, userId: user.userId, initiator: true });

        // Offer flow: createOffer -> setLocalDescription -> send localDescription
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        user.receive("offer", pc.localDescription?.toJSON()!);
      },

      onPeerLeft(userId: string, peerId: string) {
        const state = users.get(userId);
        if (!state) return;
        for (const user of state.peers) {
          if (user.peerId === peerId) {
            state.peers.delete(user);
            break;
          }
        }
        if (state.peers.size === 0 && leaveUserWithoutPeer) {
          leaveUser(userId);
        }
      },

      async onMessage(type: SigType, payload, from) {
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
          receivePeerConnection({ pc, userId: from.userId, initiator: true });
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
  }

  function removeUserListener(listener: (userId: string, users: string[]) => void) {
    userListener.delete(listener);
  }

  function addUserListener(listener: (userId: string, users: string[]) => void) {
    userListener.add(listener);
    return () => {
      removeUserListener(listener);
    };
  }

  return {
    enterRoom: enter,
    exitRoom: exit,
    leaveUser,
    getUsers,
    addUserListener,
    removeUserListener,
    getRooms() {
      return Array.from(roomsEntered.values());
    },
    end() {
      roomsEntered.forEach(({ exitRoom }) => exitRoom());
      roomsEntered.clear();
      users.forEach(({ userId }) => leaveUser(userId));
      userListener.clear();
    },
  };
}



