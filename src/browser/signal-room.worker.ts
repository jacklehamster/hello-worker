/// <reference lib="webworker" />

import { enterRoom, type IPeer } from "./impl/signal-room.js";

export type RoomEvent<T extends string = string, P = any> =
  | { kind: "open" }
  | { kind: "close"; ev: Pick<CloseEvent, "code" | "reason" | "wasClean"> }
  | { kind: "error" }
  | { kind: "peer-joined"; users: { userId: string }[] }
  | { kind: "peer-left"; users: { userId: string }[] }
  | {
      kind: "message";
      type: T;
      payload: P;
      fromUserId: string;
    }
  | { kind: "log"; direction: string; obj?: any };

export type WorkerCommand<T extends string = string, P = any> =
  | {
      cmd: "enter";
      userId: string;
      appId: string;
      room: string;
      host: string;
      autoRejoin: boolean;
    }
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
      appId: msg.appId,
      room: msg.room,
      host: msg.host,
      autoRejoin: msg.autoRejoin,
      onOpen: () => emit({ kind: "open" }),
      onClose: ({
        code,
        reason,
        wasClean,
      }: Pick<CloseEvent, "code" | "reason" | "wasClean">) =>
        emit({ kind: "close", ev: { code, reason, wasClean } }),
      onError: () => emit({ kind: "error" }),
      logLine: (direction: string, obj?: any) => {
        console.debug(`[signal-room.worker] ${direction}`, obj);
        emit({ kind: "log", direction, obj });
      },
      onPeerJoined: (users: IPeer[]) => {
        // Save the ability to send to this peer
        users.forEach(({ userId, receive }) => peerSend.set(userId, receive));
        emit({
          kind: "peer-joined",
          users: users.map(({ userId }) => ({ userId })),
        });
      },
      onPeerLeft: (users: { userId: string }[]) => {
        users.forEach(({ userId }) => peerSend.delete(userId));
        emit({ kind: "peer-left", users });
      },
      onMessage: (type: any, payload: any, from: IPeer) => {
        // We can also learn peerSend via onMessage in case join events vary
        peerSend.set(from.userId, from.receive);
        emit({
          kind: "message",
          type,
          payload,
          fromUserId: from.userId,
        });
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
