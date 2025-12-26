// src/room.ts
export class Room implements DurableObject {
  constructor(private state: DurableObjectState, private env: unknown) {
    void env;
  }

  async fetch(req: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Accept socket (hibernation-friendly)
    this.state.acceptWebSocket(server);

    // Assign an id to this peer and attach it to the socket object
    const peerId = crypto.randomUUID();
    (server as any).peerId = peerId;

    // Notify all *other* sockets currently connected to this DO instance
    for (const ws of this.state.getWebSockets()) {
      if (ws === server) continue;
      try {
        ws.send(JSON.stringify({ type: "peer-joined", peerId, t: Date.now() }));
      } catch {
        // ignore broken sockets
      }
    }

    return new Response(null, { status: 101, webSocket: client });
  }
}
