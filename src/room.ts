// src/room.ts
export class Room implements DurableObject {
  constructor(private state: DurableObjectState, private env: unknown) {
    void env;
  }

  async fetch(req: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Accept socket (hibernation-safe)
    this.state.acceptWebSocket(server);

    // Assign peer id
    const peerId = crypto.randomUUID();
    (server as any).peerId = peerId;

    // Notify existing peers
    for (const ws of this.state.getWebSockets()) {
      if (ws === server) continue;
      try {
        ws.send(
          JSON.stringify({
            type: "peer-joined",
            peerId,
            t: Date.now(),
          })
        );
      } catch {
        // ignore broken sockets
      }
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const peerId = (ws as any).peerId;
    let payload: unknown = null;

    // Try to parse JSON, fall back to raw string
    if (typeof message === "string") {
      try {
        payload = JSON.parse(message);
      } catch {
        payload = message;
      }
    } else {
      // Binary data — send as base64 for now (simple + JSON-safe)
      payload = {
        binary: true,
        data: Array.from(new Uint8Array(message)),
      };
    }

    const response = {
      type: "echo",
      from: peerId,
      payload,
      t: Date.now(),
    };

    try {
      ws.send(JSON.stringify(response));
    } catch {
      // ignore send failures
    }
  }

  webSocketClose(ws: WebSocket) {
    void ws;
  }
}
