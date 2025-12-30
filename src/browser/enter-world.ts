import { EnterRoom, enterRoom } from "./signal-room";
import { SigType, SigPayload, collectPeerConnections } from "./webrtc-peer-collector";

export function enterWorld({
  uid, appId, logLine = console.debug, enterRoomFunction = enterRoom, peerlessUserExpiration, workerUrl,
}: {
  uid?: string;
  appId: string;
  logLine?: (direction: string, obj?: any) => void;
  enterRoomFunction?: EnterRoom<SigType, SigPayload>;
  peerlessUserExpiration?: number;
  workerUrl?: URL;
}) {
  const userId = uid ?? `user-${crypto.randomUUID()}`;
  const rtcConfig: RTCConfiguration = {
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  };

  const messagesListeners = new Set<(data: any, from: string) => void>();

  function wireDataChannel(userId: string, dc: RTCDataChannel) {
    dc.onopen = () => logLine("💬", { event: "dc-open", userId });
    dc.onmessage = ({ data }) => {
      messagesListeners.forEach(listener => listener(data as any, userId));
      logLine("💬", { event: "dc-message", userId, data });
    };
    dc.onclose = () => logLine("💬", { event: "dc-close", userId });
    dc.onerror = () => logLine("⚠️ ERROR", { error: "dc-error", userId });
  }

  const dataChannels: Map<string, RTCDataChannel> = new Map();

  const { enterRoom, exitRoom, getUsers, leaveUser, addUserListener, removeUserListener, end: endPeerCollection } = collectPeerConnections({
    userId,
    appId,
    rtcConfig,
    enterRoomFunction,
    logLine,
    workerUrl,
    peerlessUserExpiration,
    onLeaveUser(userId: string) {
      const dc = dataChannels.get(userId);
      try { dc?.close(); } catch { }
      dataChannels.delete(userId);
    },
    receivePeerConnection({ pc, userId, initiator }) {
      if (initiator) {
        const dc = pc.createDataChannel("data");
        wireDataChannel(userId, dc);
        dataChannels.set(userId, dc);
      } else {
        pc.ondatachannel = (ev) => {
          const dc = ev.channel;
          wireDataChannel(userId, dc);
          dataChannels.set(userId, dc);
        };
      }

      logLine("💬", { event: "pc-ready", userId, initiator });
    },
  });

  function send(data: any, userId?: string) {
    dataChannels.forEach((dataChannel, pUserId) => {
      if (userId && pUserId !== userId) return;
      if (dataChannel.readyState === "open") dataChannel.send(data);
    });
  }

  function removeMessageListener(listener: (data: any, from: string) => void) {
    messagesListeners.delete(listener);
  }

  function addMessageListener(listener: (data: any, from: string) => void) {
    messagesListeners.add(listener);
    return () => {
      removeMessageListener(listener);
    };
  }

  return {
    userId,
    send,
    enterRoom,
    exitRoom,
    leaveUser,
    getUsers,
    addMessageListener,
    removeMessageListener,
    addUserListener,
    removeUserListener,
    end() {
      endPeerCollection();
      dataChannels.forEach((dataChannel) => {
        try { dataChannel.close(); } catch { }
      });
      dataChannels.clear();
    },
  };
}
