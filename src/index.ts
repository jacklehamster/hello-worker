import {
  Fetcher,
  DurableObjectNamespace,
  Request,
} from "@cloudflare/workers-types";

export interface Env {
  ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
  CF_TURN_TOKEN_ID: string;
  CF_RTC_API_TOKEN: string;
}

export { Room } from "./room";

export default {
  async fetch(req: Request, env: Env) {
    const url = new URL(req.url);

    // 1) Return ICE servers for WebRTC (TURN/STUN)
    if (url.pathname === "/api/ice") {
      // optional: only allow same-origin
      // optional: require auth cookie / token, etc.

      const r = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${env.CF_TURN_TOKEN_ID}/credentials/generate-ice-servers`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.CF_RTC_API_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ttl: 3600 }), // 1 hour is typical
        }
      );

      if (!r.ok) {
        return new Response("Failed to get ICE servers", { status: 502 });
      }

      // Cloudflare returns { iceServers: [...] }
      const json = await r.json();
      return new Response(JSON.stringify(json), {
        headers: { "content-type": "application/json" },
      });
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
