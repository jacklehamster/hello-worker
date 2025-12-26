import TEST_HTML from "./sample-html";

export interface Env {
  ROOM: DurableObjectNamespace;
}

export { Room } from "./room";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // If NOT /room/<id>, serve test HTML
    const match = url.pathname.match(/^\/room\/([^/]+)$/);
    if (!match) {
      return new Response(TEST_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // WebSocket upgrade required
    const upgrade = req.headers.get("Upgrade");
    if (upgrade?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const roomId = decodeURIComponent(match[1]);
    const id = env.ROOM.idFromName(roomId);
    const stub = env.ROOM.get(id);

    return stub.fetch(req);
  },
};
