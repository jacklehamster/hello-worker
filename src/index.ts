import { Fetcher, DurableObjectNamespace, Request } from "@cloudflare/workers-types";

export interface Env {
  ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
}

export { Room } from "./room";

export default {
  async fetch(req: Request, env: Env) {
    const url = new URL(req.url);

    // If NOT /room/<id>, serve test HTML
    const match = url.pathname.match(/^\/room\/([^/]+)$/);
    if (!match) {
      // everything else falls through to static assets
      return env.ASSETS.fetch(req);
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
