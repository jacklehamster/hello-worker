/// <reference lib="webworker" />

import { enterRoom, type IPeer } from "./impl/signal-room.js";

export type RoomEvent<T extends string = string, P = any> =
  | { kind: "open" }
  | { kind: "close" }
  | { kind: "error" }
  | { kind: "peer-joined"; userId: string; peerId: string }
  | { kind: "peer-left"; userId: string; peerId: string }
  | { kind: "message"; type: T; payload: P; fromUserId: string; fromPeerId: string }
  | { kind: "log"; direction: string; obj?: any };

type WorkerCommand<T extends string = string, P = any> =
  | { cmd: "enter"; userId: string; room: string; host: string }
  | { cmd: "exit" }
  | { cmd: "send"; toUserId: string; type: T; payload: P };

let exitRoom: (() => void) | null = null;

// Map from userId -> a function to send to that peer (comes from IUser.receive)
const peerSend = new Map<string, (type: any, payload: any) => boolean>();

function emit<T extends string, P>(ev: RoomEvent<T, P>) {
  (self as DedicatedWorkerGlobalScope).postMessage(ev);
}

self.addEventListener("message", (e: MessageEvent<WorkerCommand>) => {
  const msg = e.data;
  console.debug("[signal-room.worker] received command", msg);

  if (msg.cmd === "enter") {
    // If re-entering, clean up first
    exitRoom?.();
    exitRoom = null;
    peerSend.clear();

    const result = enterRoom({
      userId: msg.userId,
      room: msg.room,
      host: msg.host,
      onOpen: () => emit({ kind: "open" }),
      onClose: () => emit({ kind: "close" }),
      onError: () => emit({ kind: "error" }),
      logLine: (direction: string, obj?: any) => {
        console.debug(`[signal-room.worker] ${direction}`, obj);
        emit({ kind: "log", direction, obj });
      },
      onPeerJoined: (user: IPeer) => {
        // Save the ability to send to this peer
        peerSend.set(user.userId, user.receive);
        emit({ kind: "peer-joined", userId: user.userId, peerId: user.peerId });
      },
      onPeerLeft: (userId: string, peerId: string) => {
        peerSend.delete(userId);
        emit({ kind: "peer-left", userId, peerId });
      },
      onMessage: (type: any, payload: any, from: IPeer) => {
        // We can also learn peerSend via onMessage in case join events vary
        peerSend.set(from.userId, from.receive);
        emit({ kind: "message", type, payload, fromUserId: from.userId, fromPeerId: from.peerId });
      },
    });

    exitRoom = result.exitRoom;
    return;
  }

  if (msg.cmd === "send") {
    const sendFn = peerSend.get(msg.toUserId);
    if (sendFn) sendFn(msg.type, msg.payload);
    return;
  }

  if (msg.cmd === "exit") {
    exitRoom?.();
    self.close();
    return;
  }
});
