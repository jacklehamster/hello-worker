export class Room implements DurableObject {
  private ctx: DurableObjectState;

  constructor(ctx: DurableObjectState, env: unknown) {
    this.ctx = ctx;
    void env;
  }

  async fetch(req: Request): Promise<Response> {
    // Create the WebSocket pair
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Accept the server side in the DO (hibernation-friendly)
    this.ctx.acceptWebSocket(server);

    // You can return the client side to the browser
    return new Response(null, { status: 101, webSocket: client });
  }

  // Optional: echo messages back so you can test the connection easily
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    ws.send(message);
  }

  webSocketClose(ws: WebSocket) {
    // No state yet; nothing to clean up
    void ws;
  }
}
