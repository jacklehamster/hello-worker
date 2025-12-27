import { enterRoom, IUser } from "./signal-room";

type SigType = "offer" | "answer" | "ice";
type SigPayload = RTCSessionDescriptionInit | RTCIceCandidateInit;

type PeerState = {
  userId: string;
  pc: RTCPeerConnection;

  // ICE that arrived before we had remoteDescription
  pendingRemoteIce: RTCIceCandidateInit[];

  // whether we've started negotiation as initiator
  started: boolean;

  // the signaling "user" handle so we can send messages
  users: Set<IUser<SigType, SigPayload>>;

  dataChannel: RTCDataChannel | null;
};

export function joinWebRTCRoom({
  userId,
  room,
  host,
  logLine,
}: {
  userId: string;
  room: string;
  host: string;
  logLine: (direction: string, obj?: any) => void;
}) {
  const rtcConfig: RTCConfiguration = {
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  };

  const peers: Map<string, PeerState> = new Map();

  function wireDataChannel(state: PeerState) {
    const dc = state.dataChannel;
    if (!dc) return;

    dc.onopen = () => logLine("ℹ️", { event: "dc-open", userId: state.userId });
    dc.onmessage = (e) =>
      logLine("ℹ️", { event: "dc-message", userId: state.userId, data: e.data });
    dc.onclose = () => logLine("ℹ️", { event: "dc-close", userId: state.userId });
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
    let state = peers.get(user.info.userId);
    if (!state) {
        const newState: PeerState = {
            userId: user.info.userId,
            pc: new RTCPeerConnection(rtcConfig),
            pendingRemoteIce: [],
            started: false,
            users: new Set([user]),
            dataChannel: null,
        };
        peers.set(user.info.userId, newState);

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
        logLine("ℹ️", { event: "pc-state", userId: newState.userId, state: newState.pc.connectionState });
        };
        state = newState;
    } else {
      state.users.add(user);
    }
    peers.set(state.userId, state);
    return state;
  }

  function ensurePeer(user: IUser<SigType, SigPayload>): PeerState {
    return getPeer(user);
  }

  enterRoom<SigType, SigPayload>({
    userId: userId,
    room,
    host,
    logLine,

    // Existing peers initiate to the newcomer (Option 1)
    onPeerJoined: async (user) => {
      const state = ensurePeer(user);
      const pc = state.pc;

      // if (state.started) return; // already started negotiation

      // Initiator creates the DataChannel
      if (!state.dataChannel) {
        state.dataChannel = pc.createDataChannel("data");
        wireDataChannel(state);
      }

      // Offer flow: createOffer -> setLocalDescription -> send localDescription
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      state.started = true;

      user.receive("offer", pc.localDescription!);
    },

    onMessage: async (type, payload, from) => {
      const state = ensurePeer(from);
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

  const sendToUser = (userId: string, data: string) => {
    const p = peers.get(userId);
    if (!p) return;
    if (p.dataChannel?.readyState === "open") p.dataChannel.send(data);
  };

  return {
    peers,
    // optional helper to broadcast on data channels
    sendToPeer: sendToUser,
    sendToAll: (data: string) => {
      for (const p of peers.values()) {
        sendToUser(p.userId, data);
      }
    },
    leaveUser: (userId: string) => {
      const p = peers.get(userId);
      if (!p) return;
      try { p.dataChannel?.close(); } catch {}
      try { p.pc.close(); } catch {}
      peers.delete(userId);
    },
    exitRoom: () => {
      for (const p of peers.values()) {
        try { p.dataChannel?.close(); } catch {}
        try { p.pc.close(); } catch {}
      }
      peers.clear();
    },
  };
}
