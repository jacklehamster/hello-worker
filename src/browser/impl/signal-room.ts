export interface IPeer<T extends string = string, P = any> {
  userId: string;
  receive(type: T, payload: P): boolean;
}

/**
 * enterRoom connects to the signaling room via WebSocket.
 */
export function enterRoom<T extends string, P = any>(params: {
  userId: string;
  appId: string;
  room: string;
  host: string;
  onOpen?: () => void;
  onClose?: (ev: Pick<CloseEvent, "code" | "reason" | "wasClean">) => void;
  onError?: () => void;
  logLine?: (direction: string, obj?: any) => void;
  onPeerJoined(users: IPeer<T, P>[]): void;
  onPeerLeft(users: { userId: string }[]): void;
  onIceUrl?(url: string): void;
  onMessage(type: T, payload: P, from: IPeer<T, P>): void;
  autoRejoin?: boolean;
}): { exitRoom: () => void } {
  type Message = {
    type: "peer-joined" | "peer-left" | "ice-server" | T;
    userId: string;
    users: { userId: string }[];
    payload: P;
    url: string;
  };

  const { userId, appId, room, host, autoRejoin = true, logLine } = params;

  let exited = false;
  let retryCount = 0;
  let ws: WebSocket;
  let timeoutId: ReturnType<typeof setTimeout>;
  let initialConnection = true;

  const peers = new Map<string, IPeer<T, P>>();
  const wsUrl = `wss://${host}/room/${appId}/${room}?userId=${encodeURIComponent(
    userId
  )}`;

  // Helper for sending (uses the current ws instance)
  function send(type: T, to: string, payload: P) {
    if (!ws) return false;
    if (exited || ws.readyState !== WebSocket.OPEN) return false;
    const obj = { type, to, payload };
    ws.send(JSON.stringify(obj));
    logLine?.("👤 ➡️ 🖥️", obj);
    return true;
  }

  function connect() {
    if (exited) return;

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      if (initialConnection) {
        params.onOpen?.();
        initialConnection = false;
      }
      retryCount = 0; // Reset backoff on successful connection
    };

    ws.onmessage = (e: MessageEvent) => {
      try {
        const result = JSON.parse(e.data);
        const msgs: Message[] = Array.isArray(result) ? result : [result];
        msgs.forEach((msg) => {
          logLine?.("🖥️ ➡️ 👤", msg);
          if (msg.type === "peer-joined" || msg.type === "peer-left") {
            updatePeers(msg.users);
          } else if (msg.type === "ice-server") {
            params.onIceUrl?.(msg.url);
          } else if (msg.userId) {
            params.onMessage(msg.type, msg.payload, {
              userId: msg.userId,
              receive: (type: T, payload: P) => send(type, msg.userId, payload),
            });
          }
        });
      } catch {
        logLine?.("⚠️ ERROR", { error: "invalid-json" });
      }
    };

    ws.onclose = (ev: CloseEvent) => {
      // 1. Check if we should even try to reconnect
      const recoverableCodes = [1001, 1006, 1011, 1012, 1013];
      const isRecoverable = recoverableCodes.includes(ev.code);

      if (autoRejoin && !exited && isRecoverable) {
        // 2. Exponential Backoff: 1s, 2s, 4s, 8s... capped at 30s
        const backoff = Math.min(Math.pow(2, retryCount) * 1000, 30000);
        // 3. Add Jitter: +/- 1000ms randomness
        const jitter = Math.random() * 1000;
        const delay = backoff + jitter;

        logLine?.("🔄 RECONNECTING", {
          attempt: retryCount + 1,
          delayMs: Math.round(delay),
        });

        retryCount++;
        timeoutId = setTimeout(connect, delay);
      } else {
        params.onClose?.({
          code: ev.code,
          reason: ev.reason,
          wasClean: ev.wasClean,
        });
      }
    };

    ws.onerror = (ev) => {
      console.error("WS Error", ev);
      params.onError?.();
    };
  }

  // Helper for peer tracking (logic from your original code)
  function updatePeers(updatedUsers: { userId: string }[]) {
    const joined: IPeer<T, P>[] = [];
    const left: { userId: string }[] = [];
    const updatedPeerSet = new Set<string>();

    updatedUsers.forEach(({ userId: pUserId }) => {
      if (pUserId === userId) return;
      if (!peers.has(userId)) {
        const newPeer = {
          userId: pUserId,
          receive: (t: T, p: P) => send(t, pUserId, p),
        };
        peers.set(userId, newPeer);
        joined.push(newPeer);
      }
      updatedPeerSet.add(userId);
    });

    for (const userId of peers.keys()) {
      if (!updatedPeerSet.has(userId)) {
        peers.delete(userId);
        left.push({ userId });
      }
    }
    //  Notify peer joined first then peer left. (avoid disconnect in case the peer leaving / joining is on the same user).
    if (joined.length) params.onPeerJoined(joined);
    if (left.length) params.onPeerLeft(left);
  }

  // Start initial connection
  connect();

  return {
    exitRoom: () => {
      exited = true;
      clearTimeout(timeoutId);
      ws.close();
    },
  };
}
