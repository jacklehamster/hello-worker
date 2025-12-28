import type { IUser } from "./impl/signal-room.js";
import { enterRoom as baseEnterRoom } from "./impl/signal-room.js";
declare const __VERSION__: string;

type WorkerRoomEvent<T extends string = string, P = any> =
  | { kind: "open" }
  | { kind: "close" }
  | { kind: "error" }
  | { kind: "peer-joined"; userId: string }
  | { kind: "peer-left"; userId: string }
  | { kind: "message"; type: T; payload: P; fromUserId: string }
  | { kind: "log"; direction: string; obj?: any };

export function enterRoom<T extends string, P = any>({
  userId,
  room,
  host,
  onOpen,
  onClose,
  onError,
  onPeerJoined,
  onPeerLeft,
  onMessage,
  logLine,
  workerUrl,
}: {
  userId: string;
  room: string;
  host: string;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: () => void;
  onPeerJoined?: (user: IUser<T, P>) => void;
  onPeerLeft?: (userId: string) => void;
  onMessage?: (type: T, payload: P, from: IUser<T, P>) => void;
  logLine?: (direction: string, obj?: any) => void;

  // Pass the URL to your worker file (bundler will handle it)
  workerUrl?: URL;
}): { exitRoom: () => void } {
    if (!workerUrl) {
        const CDN_WORKER_URL = new URL(
          `https://cdn.jsdelivr.net/npm/@dobuki/hello-worker@${__VERSION__}/dist/signal-room.worker.js`
        );

        console.warn("Warning: enterRoom called without workerUrl; this may cause issues in some environments. You should pass workerUrl explicitly. Use:", CDN_WORKER_URL);
        return baseEnterRoom<T, P>({
            userId,
            room,
            host,
            onOpen,
            onClose,
            onError,
            onPeerJoined,
            onPeerLeft,
            onMessage,
        });
    }
  const worker = new Worker(workerUrl, { type: "module" });

  function makeUser(userId: string): IUser<T, P> {
    return {
      userId,
      receive: (type: T, payload: P) => {
        worker.postMessage({ cmd: "send", toUserId: userId, type, payload });
        return true;
      },
    };
  }

  const onWorkerMessage = (e: MessageEvent<WorkerRoomEvent<T, P>>) => {
    const ev = e.data;

    if (ev.kind === "open") onOpen?.();
    else if (ev.kind === "close") onClose?.();
    else if (ev.kind === "error") onError?.();
    else if (ev.kind === "peer-joined") onPeerJoined?.(makeUser(ev.userId));
    else if (ev.kind === "peer-left") onPeerLeft?.(ev.userId);
    else if (ev.kind === "message") onMessage?.(ev.type, ev.payload, makeUser(ev.fromUserId));
    else if (ev.kind === "log") logLine?.(ev.direction, ev.obj);
  };

  worker.addEventListener("message", onWorkerMessage);

  worker.postMessage({ cmd: "enter", userId, room, host });
  (window as any)._worker = worker; // for debugging

  return {
    exitRoom: () => {
      worker.postMessage({ cmd: "exit" });
      worker.removeEventListener("message", onWorkerMessage);
      worker.terminate();
    },
  };
}

export type EnterRoom<T extends string, P> = typeof enterRoom<T, P>;
export type { IUser };