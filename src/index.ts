import { Request } from "@cloudflare/workers-types";
import { IceServer } from "./server/ice";
import { Env } from "./server/env";
import { extractPathInfo } from "./server/utils/url-utils";
export { Room } from "./server/room";

const ICE_SERVER = new IceServer();

function withCors(response: any) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS",
  );
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(req: Request, env: Env) {
    {
      if (req.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
          },
        });
      }
    }
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
      return withCors(await env.ASSETS.fetch(req));
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
