import {
  Fetcher,
  DurableObjectNamespace,
  Request,
} from "@cloudflare/workers-types";
import { IceServer } from "./server/ice";

export interface Env {
  ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
  CF_TURN_TOKEN_ID: string;
  CF_RTC_API_TOKEN: string;
}

export { Room } from "./server/room";

const ICE_SERVER = new IceServer();

export default {
  async fetch(req: Request, env: Env) {
    const url = new URL(req.url);

    {
      const response = await ICE_SERVER.fetch(req, env);
      if (response) {
        return response;
      }
    }

    // If NOT /room/<appId/<roomId>, serve test HTML
    const match = url.pathname.match(/^\/room\/([^/]+)\/([^/]+)$/);
    if (!match) {
      // everything else falls through to static assets
      return env.ASSETS.fetch(req);
    }

    // WebSocket upgrade required
    const upgrade = req.headers.get("Upgrade");
    if (upgrade?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const appId = decodeURIComponent(match[1]);
    const roomId = decodeURIComponent(match[2]);
    if (!appId || !roomId) {
      return new Response("App id and room id required", { status: 400 });
    }
    const id = env.ROOM.idFromName(`${appId}/${roomId}`);
    const stub = env.ROOM.get(id);

    return stub.fetch(req);
  },
};
