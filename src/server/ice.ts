import { Request } from "@cloudflare/workers-types";
import { Env } from "./env";
import { verifyIceToken } from "./utils/iceToken";

export class IceServer {
  corsAnyOrigin() {
    return {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    };
  }

  withCors(res: Response) {
    const h = new Headers(res.headers);
    for (const [k, v] of Object.entries(this.corsAnyOrigin())) h.set(k, v);
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: h,
    });
  }

  async fetch(req: Request, env: Env) {
    const url = new URL(req.url);

    // 1) Return ICE servers for WebRTC (TURN/STUN)
    if (url.pathname === "/api/ice") {
      if (req.method === "OPTIONS")
        return this.withCors(new Response(null, { status: 204 }));

      const token = url.searchParams.get("token");
      const result = await verifyIceToken({
        secret: env.ICE_AUTH_SECRET,
        token,
      });
      if (!result) {
        return this.withCors(new Response("Unauthorized", { status: 401 }));
      }
      console.debug(
        `Providing ice servers for ${result.userId} in ${result.appId}/${result.roomId}`
      );

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
      return this.withCors(
        new Response(
          JSON.stringify({
            ...json,
            expire: (result.expiration - Date.now()) / 1000,
          }),
          {
            headers: { "Content-Type": "application/json" },
          }
        )
      );
    }
    return undefined;
  }
}
