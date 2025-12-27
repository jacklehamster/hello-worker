type AnyJson =
  | null
  | boolean
  | number
  | string
  | AnyJson[]
  | { [k: string]: AnyJson };

type Attachment = { peerId: string };

function getPeerId(ws: WebSocket): string | undefined {
  try {
    const a = ws.deserializeAttachment() as Attachment | null;
    return a?.peerId;
  } catch {
    return undefined;
  }
}

export class Room implements DurableObject {
  constructor(private state: DurableObjectState, private env: unknown) {
    void env;
  }

  async fetch(_req: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // IMPORTANT: accept first
    this.state.acceptWebSocket(server);

    // Persist peerId via attachment (survives hibernation)
    const peerId = crypto.randomUUID();
    server.serializeAttachment({ peerId } satisfies Attachment);

    console.log(`Room ${this.state.id.toString()} got new peer: ${peerId}`);

    // Notify existing peers about the newcomer
    for (const ws of this.state.getWebSockets()) {
      if (ws === server) continue;
      try {
        ws.send(JSON.stringify({ type: "peer-joined", peerId }));
      } catch {}
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const from = getPeerId(ws);
    console.log(`Room ${this.state.id.toString()} got message from ${from}:`, message);

    if (!from) {
      // This should not happen after the attachment fix,
      // but keep a helpful error if it does.
      try {
        ws.send(JSON.stringify({ type: "error", error: "missing-peerid" }));
      } catch {}
      return;
    }

    if (typeof message !== "string") {
      ws.send(JSON.stringify({ type: "error", error: "binary-not-supported" }));
      return;
    }

    let msg: any;
    try {
      msg = JSON.parse(message);
    } catch {
      ws.send(JSON.stringify({ type: "error", error: "invalid-json" }));
      return;
    }

    // Generic relay: require msg.to
    if (typeof msg.to === "string") {
      const toPeerId = msg.to;

      const out = {
        type: msg.type,
        from,
        payload: msg.payload ?? null,
      };

      for (const other of this.state.getWebSockets()) {
        if (getPeerId(other) === toPeerId) {
          try {
            other.send(JSON.stringify(out));
          } catch {}
          return;
        }
      }

      ws.send(JSON.stringify({ type: "error", error: "peer-not-found", to: toPeerId }));
      return;
    }

    ws.send(JSON.stringify({ type: "error", error: "missing-to" }));
  }

  webSocketClose(ws: WebSocket) {
    const peerId = getPeerId(ws);
    console.log(`Room ${this.state.id.toString()} peer disconnected: ${peerId}`);
  }

  webSocketError(ws: WebSocket, err: unknown) {
    const peerId = getPeerId(ws);
    console.log(`Room ${this.state.id.toString()} ws error for peer ${peerId}:`, err);
  }
}
