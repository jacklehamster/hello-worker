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

type Attachment = {
  userId: string;
  worldId: string;
  roomId: string;
  host: string;
};

function getAttachment(ws: WebSocket): Attachment | null {
  try {
    return ws.deserializeAttachment() as Attachment | null;
  } catch {
    return null;
  }
}

export class Room implements DurableObject {
  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}

  async getIceToken(worldId: string, roomId: string, userId: string) {
    return await mintIceToken({
      secret: this.env.ICE_AUTH_SECRET,
      worldId,
      roomId,
      userId,
      ttlMs: 30_000, //  30s
    });
  }

  async fetch(req: Request): Promise<Response> {
    const { worldId, roomId, userId, host } = extractPathInfo(req);

    if (!worldId || !roomId) {
      return new Response("Missing worldId or roomId", { status: 400 });
    }
    if (!userId) {
      return new Response("Missing userId", { status: 400 });
    }
    const pair = new WebSocketPair();
    const [client, server] = pair;

    // IMPORTANT: accept first
    this.state.acceptWebSocket(server);

    // Persist userId via attachment (survives hibernation)
    server.serializeAttachment({
      userId,
      worldId,
      roomId,
      host,
    } satisfies Attachment);

    console.debug(
      `Room ${this.state.id.toString()} (${worldId}/${roomId}) got new peer: (userId=${userId})`,
    );

    //  Provide ice token
    const iceToken = await this.getIceToken(worldId, roomId, userId);

    // Notify existing peers about the newcomer
    const sockets = this.state.getWebSockets();
    for (const ws of this.state.getWebSockets()) {
      if (ws === server) {
        ws.send(
          JSON.stringify({
            type: "ice-server",
            url: `https://${host}/api/ice?token=${iceToken.token}`,
          }),
        );
      } else {
        try {
          ws.send(
            JSON.stringify([
              {
                type: "ice-server",
                url: `https://${host}/api/ice?token=${iceToken.token}`,
              },
              {
                type: "peer-joined",
                userId,
                users: this.getAttachments(sockets).map(({ userId }) => ({
                  userId,
                })),
              },
            ]),
          );
        } catch {}
      }
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  private getAttachments(websockets: WebSocket[]) {
    return websockets
      .map((w) => getAttachment(w))
      .filter((a): a is Attachment => !!a);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const attachment = getAttachment(ws);
    console.debug(
      `Room ${this.state.id.toString()} got message from ${attachment?.userId}`,
      message,
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
      to?: "server" | string;
      type?: string;
      payload?: AnyJson;
    };
    try {
      msg = JSON.parse(message);
    } catch {
      ws.send(JSON.stringify({ type: "error", error: "invalid-json" }));
      return;
    }

    if (msg.to === "server") {
      this.handleServerMessage({
        type: msg.type,
        payload: msg.payload,
        ws,
        attachment,
      });
      return;
    }

    // Generic relay: require msg.to
    if (typeof msg.to === "string") {
      const toUserId: string = msg.to;

      const out = {
        type: msg.type,
        userId: attachment.userId,
        payload: msg.payload ?? null,
      };

      for (const other of this.state.getWebSockets()) {
        if (getAttachment(other)?.userId === toUserId) {
          try {
            other.send(JSON.stringify(out));
          } catch {
            console.warn("Failed to send", toUserId);
          }
          return;
        }
      }

      ws.send(
        JSON.stringify({
          type: "error",
          error: "user-not-found",
          to: toUserId,
        }),
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
      }`,
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
              ({ userId }) => ({ userId }),
            ),
          }),
        );
      } catch {}
    }
  }

  webSocketError(ws: WebSocket, err: unknown) {
    const peerId = getAttachment(ws);
    console.error(
      `Room ${this.state.id.toString()} ws error for peer ${peerId}:`,
      err,
    );
  }

  async handleServerMessage({
    type,
    ws,
    attachment,
    payload,
  }: {
    type?: string;
    ws: WebSocket;
    attachment: Attachment;
    payload?: AnyJson;
  }) {
    switch (type) {
      case "request-ice": {
        const { worldId, roomId, userId, host } = attachment;
        //  Provide ice token
        const iceToken = await this.getIceToken(worldId, roomId, userId);
        ws.send(
          JSON.stringify({
            type: "ice-server",
            url: `https://${host}/api/ice?token=${iceToken.token}`,
          }),
        );
        break;
      }
      case "broadcast": {
        const userId = attachment.userId;
        for (const other of this.state.getWebSockets()) {
          if (other === ws) continue;
          try {
            other.send(
              JSON.stringify({ type, userId, payload: payload ?? null }),
            );
          } catch {
            console.warn("Failed to send");
          }
        }
        break;
      }
      default:
        console.debug(
          "Unrecognized server type",
          type,
          "with payload",
          payload,
        );
    }
  }
}
