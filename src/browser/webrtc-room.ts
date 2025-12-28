import { EnterRoom, IUser, enterRoom } from "./signal-room";

type SigType = "offer" | "answer" | "ice";
type SigPayload = RTCSessionDescriptionInit | RTCIceCandidateInit;

type PeerState = {
  userId: string;
  pc: RTCPeerConnection;

  // ICE that arrived before we had remoteDescription
  pendingRemoteIce: RTCIceCandidateInit[];

  // the signaling "user" handle so we can send messages
  users: Set<IUser<SigType, SigPayload>>;

  dataChannel: RTCDataChannel | null;
};

const DEFAULT_ENTER_ROOM = enterRoom;

export function joinWebRTCRoom({
  onMessage,
  logLine = console.log,
  enterRoom = DEFAULT_ENTER_ROOM,
}: {
  onMessage?: (data: any, from: string) => void;
  logLine?: (direction: string, obj?: any) => void;
  enterRoom?: EnterRoom<SigType, SigPayload>;
}) {
  const userId = crypto.randomUUID();
  const rtcConfig: RTCConfiguration = {
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  };

  const peers: Map<string, PeerState> = new Map();

  function wireDataChannel(state: PeerState) {
    const dc = state.dataChannel;
    if (!dc) return;

    dc.onopen = () => logLine("💬", { event: "dc-open", userId: state.userId });
    dc.onmessage = (e) => {
      onMessage?.(e.data as any, state.userId);
      logLine("💬", { event: "dc-message", userId: state.userId, data: e.data });
    };
    dc.onclose = () => logLine("💬", { event: "dc-close", userId: state.userId });
    dc.onerror = () => logLine("⚠️ ERROR", { error: "dc-error", userId: state.userId });
  }

  async function flushRemoteIce(state: PeerState) {
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

  function getPeer(user: IUser<SigType, SigPayload>): PeerState {
    let state = peers.get(user.userId);
    if (!state) {
        const newState: PeerState = {
          userId: user.userId,
          pc: new RTCPeerConnection(rtcConfig),
          pendingRemoteIce: [],
          users: new Set([user]),
          dataChannel: null,
        };
        peers.set(user.userId, newState);

        // Send local ICE candidates to this peer
        newState.pc.onicecandidate = (ev) => {
          if (!ev.candidate) return;
          for(let user of newState.users) {
              const success = user.receive("ice", ev.candidate.toJSON());
              if (success) break;
              newState.users.delete(user);
          }
        };
            
        // Responder receives DataChannel here
        newState.pc.ondatachannel = (ev) => {
          newState.dataChannel = ev.channel;
          wireDataChannel(newState);
        };
        newState.pc.onconnectionstatechange = () => {
          logLine("💬", { event: "pc-state", userId: newState.userId, state: newState.pc.connectionState });
        };
        state = newState;
    } else {
      state.users.add(user);
    }
    peers.set(state.userId, state);
    return state;
  }

  function leaveUser(userId: string) {
    const p = peers.get(userId);
    if (!p) return;
    try { p.dataChannel?.close(); } catch {}
    try { p.pc.close(); } catch {}
    peers.delete(userId);
    logLine("👤 USER LEFT", userId);
  }

  const roomsEntered = new Map<string, { host: string; room: string; exitRoom: () => void }>();
  function enter({ room, host }: { room: string; host: string; }) {
    const { exitRoom } = enterRoom({
      userId,
      room,
      host,
      logLine,

      // Existing peers initiate to the newcomer (Option 1)
      onPeerJoined: async (user) => {
        const state = getPeer(user);
        const pc = state.pc;

        // Initiator creates the DataChannel
        if (!state.dataChannel) {
          state.dataChannel = pc.createDataChannel("data");
          wireDataChannel(state);
        }

        // Offer flow: createOffer -> setLocalDescription -> send localDescription
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        user.receive("offer", pc.localDescription!);
      },

      onPeerLeft: (userId) => {
        const state = peers.get(userId);
        if (!state) return;
        for (const user of state.users) {
          if (user.userId === userId) {
            state.users.delete(user);
            break;
          }
        }
        if (state.users.size === 0) {
          try { state.dataChannel?.close(); } catch {}
          try { state.pc.close(); } catch {}
          leaveUser(userId);
        }
      },

      onMessage: async (type, payload, from) => {
        const state = getPeer(from);
        const pc = state.pc;

        if (type === "offer") {
          // Responder: set remote offer
          await pc.setRemoteDescription(payload as RTCSessionDescriptionInit);

          // Create and send answer
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);

          from.receive("answer", pc.localDescription!);

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
    roomsEntered.set(`${host}/room/${room}`, { exitRoom, host, room });
  }

  function exit({ room, host }: { room: string; host: string; }) {
    const key = `${host}/room/${room}`;
    const session = roomsEntered.get(key);
    if (session) {
      session.exitRoom();
      roomsEntered.delete(key);
    }
  }

  const sendToUser = (userId: string, data: string) => {
    const p = peers.get(userId);
    if (!p) return;
    if (p.dataChannel?.readyState === "open") p.dataChannel.send(data);
  };

  function sendToAll(data: string) {
    for (const p of peers.values()) {
      if (p.dataChannel?.readyState === "open") p.dataChannel.send(data);
    }
  }

  return {
    userId,
    sendToUser,
    sendToAll,
    end: () => {
      roomsEntered.values().forEach(({ exitRoom }) => exitRoom());
      roomsEntered.clear();

      for (const p of peers.values()) {
        try { p.dataChannel?.close(); } catch {}
        try { p.pc.close(); } catch {}
      }

      peers.clear();
    },
    enter,
    exit,
  };
}
