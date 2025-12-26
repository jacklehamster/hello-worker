type AnyJson =
  | null
  | boolean
  | number
  | string
  | AnyJson[]
  | { [k: string]: AnyJson };

export class Room implements DurableObject {
  constructor(private state: DurableObjectState, private env: unknown) {
    void env;
  }

  async fetch(_req: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.state.acceptWebSocket(server);

    // Assign internal peerId (client doesn't need to know it yet)
    const peerId = crypto.randomUUID();
    (server as any).peerId = peerId;

    // Notify all *existing* peers that a new peer joined
    for (const ws of this.state.getWebSockets()) {
      if (ws === server) continue;
      try {
        ws.send(JSON.stringify({ type: "peer-joined", peerId }));
      } catch {
        // ignore
      }
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const from = (ws as any).peerId as string | undefined;

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

    // Route targeted welcome messages
    if (typeof msg.to === "string") {
      const toPeerId = msg.to;
    
      const out = {
        type: msg.type,
        from: (ws as any).peerId,
        payload: msg.payload ?? null,
      };
    
      for (const other of this.state.getWebSockets()) {
        if ((other as any).peerId === toPeerId) {
          try {
            other.send(JSON.stringify(out));
          } catch {}
          return;
        }
      }
    
      ws.send(
        JSON.stringify({
          type: "error",
          error: "peer-not-found",
          to: toPeerId,
        })
      );
      return;
    }

    // Optional while developing: reject everything else so it stays quiet
    ws.send(JSON.stringify({ type: "error", error: "unsupported-message-type" }));
  }
}
