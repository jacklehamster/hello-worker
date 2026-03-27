import type { IPeer } from "./impl/signal-room.js";
import { enterRoom as baseEnterRoom } from "./impl/signal-room.js";
import { RoomEvent, WorkerCommand } from "./signal-room.worker.js";

export function enterRoom<T extends string, P = any>({
  userId,
  worldId,
  room,
  protocol = "wss",
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
  protocol?: string;
  host: string;
  autoRejoin?: boolean;
  onOpen?: () => void;
  onClose?: (ev: Pick<CloseEvent, "code" | "reason" | "wasClean">) => void;
  onError?: () => void;
  onPeerJoined: (users: IPeer[], selfJoined: number) => void;
  onPeerLeft: (users: { userId: string }[]) => void;
  onIceUrl?(url: string, expiration: number): void;
  onMessage: (type: T, payload: P, from: string) => void;
  logLine?: (direction: string, obj?: any) => void;

  // Pass the URL to your worker file (bundler will handle it)
  workerUrl?: URL;
}): {
  exitRoom: () => void;
  send: <P extends any>(
    type: T,
    userId: "server" | string,
    payload?: P,
  ) => void;
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
      protocol,
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

  let worker: Worker | undefined;
  const res = fetch(workerUrl).then(async (res) => {
    if (!res.ok) {
      throw new Error(`Failed to load worker script: ${res.status}`);
    }
    const source = await res.text();

    const blob = new Blob([source], { type: "text/javascript" });
    const blobUrl = URL.createObjectURL(blob);

    worker = new Worker(blobUrl, { type: "module" });

    worker.addEventListener("message", onWorkerMessage);

    worker.postMessage({
      cmd: "enter",
      userId,
      worldId,
      room,
      host,
      autoRejoin,
    } as WorkerCommand);
  });
  let exited = false;

  const onWorkerMessage = (e: MessageEvent<RoomEvent<T, P>>) => {
    const ev = e.data;

    if (ev.kind === "open") onOpen?.();
    else if (ev.kind === "close") {
      worker?.terminate();
      onClose?.(ev.ev);
    } else if (ev.kind === "error") onError?.();
    else if (ev.kind === "peer-joined")
      onPeerJoined(
        ev.users.map((ev) => ({ userId: ev.userId, joined: ev.joined })),
        ev.joined,
      );
    else if (ev.kind === "peer-left") onPeerLeft(ev.users);
    else if (ev.kind === "ice-server") onIceUrl?.(ev.url, ev.expiration);
    else if (ev.kind === "message")
      onMessage(ev.type, ev.payload, ev.fromUserId);
    else if (ev.kind === "log") logLine?.(ev.direction, ev.obj);
  };

  return {
    exitRoom: () => {
      exited = true;
      worker?.removeEventListener("message", onWorkerMessage);
      worker?.postMessage({ cmd: "exit" } as WorkerCommand);
    },
    send: (type, toUserId, payload) => {
      worker?.postMessage({
        cmd: "send",
        toUserId,
        host,
        room,
        type,
        payload,
      } as WorkerCommand);
    },
  };
}

export type EnterRoom<T extends string, P> = typeof enterRoom<T, P>;
