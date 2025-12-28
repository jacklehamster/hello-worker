/// <reference lib="webworker" />

import { enterRoom, type IUser } from "./impl/signal-room.js";

type RoomEvent<T extends string = string, P = any> =
  | { kind: "open" }
  | { kind: "close" }
  | { kind: "error" }
  | { kind: "peer-joined"; userId: string }
  | { kind: "peer-left"; userId: string }
  | { kind: "message"; type: T; payload: P; fromUserId: string }
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
  console.log("[signal-room.worker] received command", msg);

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
        console.log(`[signal-room.worker] ${direction}`, obj);
        emit({ kind: "log", direction, obj });
      },
      onPeerJoined: (user: IUser) => {
        // Save the ability to send to this peer
        peerSend.set(user.userId, (type, payload) => user.receive(type, payload));
        emit({ kind: "peer-joined", userId: user.userId });
      },
      onPeerLeft: (userId: string) => {
        peerSend.delete(userId);
        emit({ kind: "peer-left", userId });
      },
      onMessage: (type: any, payload: any, from: IUser) => {
        // We can also learn peerSend via onMessage in case join events vary
        peerSend.set(from.userId, (t, p) => from.receive(t, p));
        emit({ kind: "message", type, payload, fromUserId: from.userId });
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
    exitRoom = null;
    peerSend.clear();
    return;
  }
});
