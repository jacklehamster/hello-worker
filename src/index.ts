import { Request } from "@cloudflare/workers-types";
import { IceServer } from "./server/ice";
import { Env } from "./server/env";
import { extractPathInfo } from "./server/utils/url-utils";
export { Room } from "./server/room";

const ICE_SERVER = new IceServer();

export default {
  async fetch(req: Request, env: Env) {
    {
      const response = await ICE_SERVER.fetch(req, env);
      if (response) {
        return response;
      }
    }

    // If NOT /room/<worldId/<roomId>, serve test HTML
    const { worldId, roomId } = extractPathInfo(req);
    if (!worldId || !roomId) {
      // everything else falls through to static assets
      return env.ASSETS.fetch(req);
    }

    // WebSocket upgrade required
    const upgrade = req.headers.get("Upgrade");
    if (upgrade?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    if (!worldId || !roomId) {
      return new Response("App id and room id required", { status: 400 });
    }
    const id = env.ROOM.idFromName(`${worldId}/${roomId}`);
    const stub = env.ROOM.get(id);

    return stub.fetch(req);
  },
};
