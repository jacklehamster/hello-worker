import {
  WebSocket,
  DurableObject,
  DurableObjectState,
  Request,
} from "@cloudflare/workers-types";
import { mintIceToken } from "./utils/iceToken";
import { Env } from "./env";
import { extractPathInfo } from "./utils/url-utils";

type AnyJson =
  | null
  | boolean
  | number
  | string
  | AnyJson[]
  | { [k: string]: AnyJson };

type Attachment = { userId: string };

function getAttachment(ws: WebSocket): Attachment | null {
  try {
    return ws.deserializeAttachment() as Attachment | null;
  } catch {
    return null;
  }
}

export class Room implements DurableObject {
  constructor(private state: DurableObjectState, private env: Env) {}

  async getIceToken(appId: string, roomId: string, userId: string) {
    return await mintIceToken({
      secret: this.env.ICE_AUTH_SECRET,
      appId,
      roomId,
      userId,
      ttlMs: 30_000, //  30s
    });
  }

  async fetch(req: Request): Promise<Response> {
    const { appId, roomId, userId, host } = extractPathInfo(req);

    if (!appId || !roomId) {
      return new Response("Missing appId or roomId", { status: 400 });
    }
    if (!userId) {
      return new Response("Missing userId", { status: 400 });
    }
    const pair = new WebSocketPair();
    const [client, server] = pair;

    // IMPORTANT: accept first
    this.state.acceptWebSocket(server);

    // Persist peerId via attachment (survives hibernation)
    server.serializeAttachment({ userId } satisfies Attachment);

    console.debug(
      `Room ${this.state.id.toString()} (${appId}/${roomId}) got new peer: (userId=${userId})`
    );

    // Notify existing peers about the newcomer
    const sockets = this.state.getWebSockets();
    for (const ws of this.state.getWebSockets()) {
      //  Provide ice token
      const iceToken = await this.getIceToken(appId, roomId, userId);
      ws.send(
        JSON.stringify({
          type: "ice-server",
          url: `https://${host}/api/ice?token=${iceToken.token}`,
        })
      );

      if (ws === server) continue; //  don't anounce peer joined to self
      try {
        ws.send(
          JSON.stringify({
            type: "peer-joined",
            userId,
            users: this.getAttachments(sockets).map(({ userId }) => ({
              userId,
            })),
          })
        );
      } catch {}
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  private getAttachments(websockets: WebSocket[]) {
    return websockets
      .map((w) => getAttachment(w))
      .filter((a): a is Attachment => !!a);
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const attachment = getAttachment(ws);
    console.debug(
      `Room ${this.state.id.toString()} got message from ${attachment?.userId}`,
      message
    );

    if (!attachment) {
      // This should not happen after the attachment fix,
      // but keep a helpful error if it does.
      try {
        ws.send(JSON.stringify({ type: "error", error: "missing-userId" }));
      } catch {}
      return;
    }

    if (typeof message !== "string") {
      ws.send(JSON.stringify({ type: "error", error: "binary-not-supported" }));
      return;
    }

    let msg: {
      to?: string;
      type?: string;
      payload?: AnyJson;
    };
    try {
      msg = JSON.parse(message);
    } catch {
      ws.send(JSON.stringify({ type: "error", error: "invalid-json" }));
      return;
    }

    // Generic relay: require msg.to
    if (typeof msg.to === "string") {
      const toUserId = msg.to;

      const out = {
        type: msg.type,
        userId: attachment.userId,
        payload: msg.payload ?? null,
      };

      for (const other of this.state.getWebSockets()) {
        if (getAttachment(other)?.userId === toUserId) {
          try {
            other.send(JSON.stringify(out));
          } catch {}
          return;
        }
      }

      ws.send(
        JSON.stringify({ type: "error", error: "user-not-found", to: toUserId })
      );
      return;
    }

    ws.send(JSON.stringify({ type: "error", error: "missing-to" }));
  }

  webSocketClose(ws: WebSocket) {
    const attachment = getAttachment(ws);
    console.debug(
      `Room ${this.state.id.toString()} peer disconnected: ${
        attachment?.userId
      }`
    );

    if (!attachment) return;

    const { userId } = attachment;

    // Notify other peers about the departure
    const sockets = this.state.getWebSockets();
    for (const other of this.state.getWebSockets()) {
      if (other === ws) continue;
      try {
        other.send(
          JSON.stringify({
            type: "peer-left",
            userId,
            users: this.getAttachments(sockets.filter((s) => s !== ws)).map(
              ({ userId }) => ({ userId })
            ),
          })
        );
      } catch {}
    }
  }

  webSocketError(ws: WebSocket, err: unknown) {
    const peerId = getAttachment(ws);
    console.error(
      `Room ${this.state.id.toString()} ws error for peer ${peerId}:`,
      err
    );
  }
}
