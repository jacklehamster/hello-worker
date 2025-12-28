type AnyJson =
  | null
  | boolean
  | number
  | string
  | AnyJson[]
  | { [k: string]: AnyJson };

type Attachment = { peerId: string; userId: string };

function getAttachment(ws: WebSocket): Attachment | null {
  try {
    const a = ws.deserializeAttachment() as Attachment | null;
    return a ;
  } catch {
    return null;
  }
}

export class Room implements DurableObject {
  constructor(private state: DurableObjectState, private env: unknown) {
    void env;
  }

  async fetch(req: Request): Promise<Response> {
    const userId = new URL(req.url).searchParams.get("userId");
    if (!userId) {
      return new Response("Missing userId", { status: 400 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // IMPORTANT: accept first
    this.state.acceptWebSocket(server);

    // Persist peerId via attachment (survives hibernation)
    const peerId = crypto.randomUUID();
    server.serializeAttachment({ peerId, userId } satisfies Attachment);

    console.log(`Room ${this.state.id.toString()} got new peer: ${peerId} (userId=${userId})`);

    // Notify existing peers about the newcomer
    for (const ws of this.state.getWebSockets()) {
      if (ws === server) continue;
      try {
        ws.send(JSON.stringify({ type: "peer-joined", peerId, userId }));
      } catch {}
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const attachment = getAttachment(ws);
    console.log(`Room ${this.state.id.toString()} got message from ${attachment}:`, message);

    if (!attachment) {
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

    let msg: {
      to?: string;
      type?: string;
      payload?: AnyJson;
    };
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
        userId: attachment.userId,
        peerId: attachment.peerId,
        payload: msg.payload ?? null,
      };

      for (const other of this.state.getWebSockets()) {
        if (getAttachment(other)?.peerId === toPeerId) {
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
    const attachment = getAttachment(ws);
    console.log(`Room ${this.state.id.toString()} peer disconnected:`, attachment);

    if (!attachment) return;

    const { peerId, userId } = attachment;

    // Notify other peers about the departure
    for (const other of this.state.getWebSockets()) {
      if (other === ws) continue;
      try {
        other.send(JSON.stringify({ type: "peer-left", peerId, userId }));
      } catch {}
    }
  }  

  webSocketError(ws: WebSocket, err: unknown) {
    const peerId = getAttachment(ws);
    console.log(`Room ${this.state.id.toString()} ws error for peer ${peerId}:`, err);
  }
}
