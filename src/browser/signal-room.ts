import type { IPeer } from "./impl/signal-room.js";
import { enterRoom as baseEnterRoom } from "./impl/signal-room.js";
import { RoomEvent, WorkerCommand } from "./signal-room.worker.js";

export function enterRoom<T extends string, P = any>({
  userId,
  worldId,
  room,
  host,
  autoRejoin = true,
  onOpen,
  onClose,
  onError,
  onPeerJoined,
  onPeerLeft,
  onIceUrl,
  onMessage,
  logLine,
  workerUrl,
}: {
  userId: string;
  worldId: string;
  room: string;
  host: string;
  autoRejoin?: boolean;
  onOpen?: () => void;
  onClose?: (ev: Pick<CloseEvent, "code" | "reason" | "wasClean">) => void;
  onError?: () => void;
  onPeerJoined: (users: IPeer<T, P>[]) => void;
  onPeerLeft: (users: { userId: string }[]) => void;
  onIceUrl?(url: string): void;
  onMessage: (type: T, payload: P, from: IPeer<T, P>) => void;
  logLine?: (direction: string, obj?: any) => void;

  // Pass the URL to your worker file (bundler will handle it)
  workerUrl?: URL;
}): {
  exitRoom: () => void;
  sendToServer: (type: T, payload?: P) => void;
  broadcast<T extends string, P extends any>(type: T, payload?: P): void;
} {
  if (!workerUrl) {
    const CDN_WORKER_URL = `https://cdn.jsdelivr.net/npm/@dobuki/hello-worker/dist/signal-room.worker.min.js`;

    console.warn(
      "Warning: enterRoom called without workerUrl; this may cause issues in some environments. You should pass workerUrl explicitly. Use:",
      CDN_WORKER_URL,
    );
    return baseEnterRoom<T, P>({
      userId,
      worldId,
      room,
      host,
      autoRejoin,
      onOpen,
      onClose,
      onError,
      onPeerJoined,
      onPeerLeft,
      onIceUrl,
      onMessage,
    });
  }
  const worker = new Worker(workerUrl, { type: "module" });
  let exited = false;

  function makeUser({ userId }: { userId: string }): IPeer<T, P> {
    return {
      userId,
      receive: (type: T, payload: P) => {
        if (exited) return false;
        worker.postMessage({
          cmd: "send",
          toUserId: userId,
          host,
          room,
          type,
          payload,
        } as WorkerCommand);
        return true;
      },
    };
  }

  const onWorkerMessage = (e: MessageEvent<RoomEvent<T, P>>) => {
    const ev = e.data;

    if (ev.kind === "open") onOpen?.();
    else if (ev.kind === "close") {
      worker.terminate();
      onClose?.(ev.ev);
    } else if (ev.kind === "error") onError?.();
    else if (ev.kind === "peer-joined")
      onPeerJoined(ev.users.map((ev) => makeUser({ userId: ev.userId })));
    else if (ev.kind === "peer-left") onPeerLeft(ev.users);
    else if (ev.kind === "ice-server") onIceUrl?.(ev.url);
    else if (ev.kind === "message")
      onMessage(ev.type, ev.payload, makeUser({ userId: ev.fromUserId }));
    else if (ev.kind === "log") logLine?.(ev.direction, ev.obj);
  };

  worker.addEventListener("message", onWorkerMessage);

  worker.postMessage({
    cmd: "enter",
    userId,
    worldId,
    room,
    host,
    autoRejoin,
  } as WorkerCommand);

  return {
    exitRoom: () => {
      exited = true;
      worker.removeEventListener("message", onWorkerMessage);
      worker.postMessage({ cmd: "exit" } as WorkerCommand);
    },
    sendToServer: (type: T, payload?: P) => {
      worker.postMessage({
        cmd: "send",
        toUserId: "server",
        host,
        room,
        type,
        payload,
      } as WorkerCommand);
    },
    broadcast<T extends string, P extends any>(type: T, payload?: P) {
      worker.postMessage({
        cmd: "send",
        toUserId: "broadcast",
        host,
        room,
        type,
        payload,
      } as WorkerCommand);
    },
  };
}

export type EnterRoom<T extends string, P> = typeof enterRoom<T, P>;
