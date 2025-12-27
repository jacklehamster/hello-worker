import { enterRoom, IUser } from "./signal-room";

type SigType = "offer" | "answer" | "ice";
type SigPayload = RTCSessionDescriptionInit | RTCIceCandidateInit;

type PeerState = {
  id: string;
  pc: RTCPeerConnection;

  // ICE that arrived before we had remoteDescription
  pendingRemoteIce: RTCIceCandidateInit[];

  // whether we've started negotiation as initiator
  started: boolean;

  // the signaling "user" handle so we can send messages
  user: IUser<SigType, SigPayload>;

  dataChannel: RTCDataChannel | null;
};

export function joinWebRTCRoom({
  room,
  host,
  logLine,
}: {
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

    dc.onopen = () => logLine("ℹ️", { event: "dc-open", peerId: state.id });
    dc.onmessage = (e) =>
      logLine("ℹ️", { event: "dc-message", peerId: state.id, data: e.data });
    dc.onclose = () => logLine("ℹ️", { event: "dc-close", peerId: state.id });
    dc.onerror = () => logLine("⚠️ ERROR", { error: "dc-error", peerId: state.id });
  }

  async function flushRemoteIce(state: PeerState) {
    if (!state.pc.remoteDescription) return;

    const queued = state.pendingRemoteIce;
    state.pendingRemoteIce = [];

    for (const ice of queued) {
      try {
        await state.pc.addIceCandidate(ice);
      } catch (e) {
        logLine("⚠️ ERROR", { error: "add-ice-failed", peerId: state.id, detail: String(e) });
      }
    }
  }

  function createPeer(user: IUser<SigType, SigPayload>): PeerState {
    const peerId = user.id;
    const pc = new RTCPeerConnection(rtcConfig);

    const state: PeerState = {
      id: peerId,
      pc,
      pendingRemoteIce: [],
      started: false,
      user,
      dataChannel: null,
    };

    // Send local ICE candidates to this peer
    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      user.receive("ice", ev.candidate.toJSON());
    };

    // Responder receives DataChannel here
    pc.ondatachannel = (ev) => {
      state.dataChannel = ev.channel;
      wireDataChannel(state);
    };

    pc.onconnectionstatechange = () => {
      logLine("ℹ️", { event: "pc-state", peerId, state: pc.connectionState });
    };

    peers.set(peerId, state);
    return state;
  }

  function ensurePeer(user: IUser<SigType, SigPayload>): PeerState {
    return peers.get(user.id) ?? createPeer(user);
  }

  enterRoom<SigType, SigPayload>({
    room,
    host,
    logLine,

    // Existing peers initiate to the newcomer (Option 1)
    onPeerJoined: async (user) => {
      const state = ensurePeer(user);
      const pc = state.pc;

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
          logLine("⚠️ ERROR", { error: "add-ice-failed", peerId: state.id, detail: String(e) });
        }
        return;
      }
    },
  });

  const sendToPeer = (peerId: string, data: string) => {
    const p = peers.get(peerId);
    if (!p) return;
    if (p.dataChannel?.readyState === "open") p.dataChannel.send(data);
  };

  return {
    peers,
    // optional helper to broadcast on data channels
    sendToPeer,
    sendToAll: (data: string) => {
      for (const p of peers.values()) {
        sendToPeer(p.id, data);
      }
    },
    closePeer: (peerId: string) => {
      const p = peers.get(peerId);
      if (!p) return;
      try { p.dataChannel?.close(); } catch {}
      try { p.pc.close(); } catch {}
      peers.delete(peerId);
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
