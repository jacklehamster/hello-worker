/// <reference lib="webworker" />

import { enterRoom, type IPeer } from "./impl/signal-room.js";

export type RoomEvent<T extends string = string, P = any> =
  | { kind: "open" }
  | { kind: "close"; ev: Pick<CloseEvent, "code" | "reason" | "wasClean"> }
  | { kind: "error" }
  | { kind: "peer-joined"; users: { userId: string; joined: number }[] }
  | { kind: "peer-left"; users: { userId: string }[] }
  | { kind: "ice-server"; url: string; expiration: number }
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
      worldId: string;
      room: string;
      host: string;
      autoRejoin: boolean;
    }
  | { cmd: "exit" }
  | {
      cmd: "send";
      host: string;
      room: string;
      toUserId?: "server" | string;
      type: T;
      payload?: P;
    };

let exitRoom: (() => void) | null = null;
let send: (type: string, userId: "server" | string, payload?: any) => void;

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

    const result = enterRoom({
      userId: msg.userId,
      worldId: msg.worldId,
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
        emit({
          kind: "peer-joined",
          users: users.map(({ userId, joined }) => ({ userId, joined })),
        });
      },
      onPeerLeft: (users: { userId: string }[]) => {
        emit({ kind: "peer-left", users });
      },
      onIceUrl(url: string, expiration: number) {
        emit({ kind: "ice-server", url, expiration });
      },
      onMessage: (type: any, payload: any, from: string) => {
        emit({
          kind: "message",
          type,
          payload,
          fromUserId: from,
        });
      },
    });

    exitRoom = result.exitRoom;
    send = result.send;
    return;
  }

  if (msg.cmd === "send") {
    if (msg.toUserId) {
      send(msg.type, msg.toUserId, msg.payload);
    }
    return;
  }

  if (msg.cmd === "exit") {
    exitRoom?.();
    self.close();
    return;
  }
});
