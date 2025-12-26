// export default {
//   async fetch(request: Request, env: any): Promise<Response> {
//     return new Response("<a href='https://github.com/jacklehamster/cloudflare-worker'>Hello, World!</a>", {
//       headers: { "Content-Type": "text/html" },
//     });
//   },
// };


export interface Env {
  ROOM: DurableObjectNamespace;
}

export { Room } from "./room";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // Expect: /room/<roomId>
    const match = url.pathname.match(/^\/room\/([^/]+)$/);
    if (!match) return new Response("Not found", { status: 404 });

    // WebSocket upgrade required
    const upgrade = req.headers.get("Upgrade");
    if (upgrade?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const roomId = decodeURIComponent(match[1]);

    // Route this request to a Durable Object instance for that room
    const id = env.ROOM.idFromName(roomId);
    const stub = env.ROOM.get(id);

    return stub.fetch(req);
  },
};
