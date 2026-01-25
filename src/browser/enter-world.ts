import { EnterRoom, enterRoom } from "./signal-room";
import {
  SigType,
  SigPayload,
  collectPeerConnections,
} from "./webrtc-peer-collector";

type UserListener = (
  user: string,
  action: "join" | "leave",
  users: string[],
) => void;

export function enterWorld<D extends string | ArrayBuffer>({
  worldId,
  logLine = console.debug,
  enterRoomFunction = enterRoom,
  peerlessUserExpiration,
  workerUrl,
  onRoomReady,
  onRoomClose,
  dataChannelOptions,
}: {
  worldId: string;
  logLine?: (direction: string, obj?: any) => void;
  enterRoomFunction?: EnterRoom<SigType, SigPayload>;
  peerlessUserExpiration?: number;
  workerUrl?: URL;
  onRoomReady?(info: { host: string; room: string }): void;
  onRoomClose?(info: {
    host: string;
    room: string;
    ev: Pick<CloseEvent, "reason" | "code" | "wasClean">;
  }): void;
  dataChannelOptions?: RTCDataChannelInit;
}) {
  const userIds: string[] = [];

  const messagesListeners = new Set<(data: any, from: string) => void>();

  function createDataChannel(
    pc: RTCPeerConnection,
    peerUserId: string,
    initiator: boolean,
    restart?: () => void,
  ) {
    if (initiator) {
      const dc = pc.createDataChannel("data", dataChannelOptions);
      wireDataChannel(peerUserId, dc, restart);
      dataChannels.set(peerUserId, dc);
    } else {
      function listener(ev: RTCDataChannelEvent) {
        const dc = ev.channel;
        wireDataChannel(peerUserId, dc, restart);
        dataChannels.set(peerUserId, dc);
      }
      pc.addEventListener("datachannel", listener);
      return () => {
        pc.removeEventListener("datachannel", listener);
      };
    }
  }

  function conveyMessage(data: any, userId: string) {
    messagesListeners.forEach((listener) => listener(data, userId));
  }

  function wireDataChannel(
    userId: string,
    dc: RTCDataChannel,
    restart?: () => void,
  ) {
    dc.onopen = () => {
      logLine("💬", { event: "dc-open", userId });
      userIds.push(userId);
      userListeners.forEach((listener) => listener(userId, "join", userIds));
    };
    const onmessage = ({ data }: MessageEvent) => {
      conveyMessage(data, userId);
      // logLine("💬", { event: "dc-message", userId, data });
    };
    dc.addEventListener("message", onmessage);
    dc.addEventListener("close", () => {
      logLine("💬", { event: "dc-close", userId });
      userIds.splice(userIds.indexOf(userId), 1);
      userListeners.forEach((listener) => listener(userId, "leave", userIds));
      dc.removeEventListener("message", onmessage);
      restart?.();
    });
    dc.onerror = () => logLine("⚠️ ERROR", { error: "dc-error", userId });
  }

  const dataChannels = new Map<string, RTCDataChannel>();
  const userListeners = new Set<UserListener>();

  const {
    userId,
    enterRoom,
    exitRoom,
    leaveUser,
    broadcast,
    end: endPeerCollection,
  } = collectPeerConnections({
    worldId,
    enterRoomFunction,
    logLine,
    workerUrl,
    peerlessUserExpiration,
    onRoomReady,
    onRoomClose,
    onLeaveUser(userId: string) {
      const dc = dataChannels.get(userId);
      try {
        dc?.close();
      } catch {}
      dataChannels.delete(userId);
    },
    receivePeerConnection({ pc, userId, initiator, restart }) {
      createDataChannel(pc, userId, initiator, restart);
    },
    onBroadcastMessage(payload, from) {
      conveyMessage(payload, from);
      logLine("📢", { event: "broadcast", userId, data: payload });
    },
  });

  function send(data: D, userId?: string) {
    dataChannels.forEach((dataChannel, pUserId) => {
      if (userId && pUserId !== userId) return;
      if (dataChannel.readyState === "open") {
        dataChannel.send(data as any);
      }
    });
  }

  function removeMessageListener(listener: (data: D, from: string) => void) {
    messagesListeners.delete(listener);
  }

  function addMessageListener(listener: (data: D, from: string) => void) {
    messagesListeners.add(listener);
    return () => {
      removeMessageListener(listener);
    };
  }

  function removeUserListener(listener: UserListener) {
    userListeners.delete(listener);
  }

  function addUserListener(listener: UserListener) {
    userListeners.add(listener);
    return () => {
      removeUserListener(listener);
    };
  }

  return {
    userId,
    send,
    broadcast,
    enterRoom,
    exitRoom,
    leaveUser,
    getUsers: () => userIds,
    addMessageListener,
    removeMessageListener,
    addUserListener,
    removeUserListener,
    end() {
      dataChannels.forEach((dataChannel) => {
        try {
          dataChannel.close();
        } catch {}
      });
      dataChannels.clear();
      endPeerCollection();
      userListeners.clear();
      userIds.length = 0;
    },
  };
}
