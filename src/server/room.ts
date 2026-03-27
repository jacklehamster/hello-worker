import {
  WebSocket,
  DurableObject,
  DurableObjectState,
  Request,
} from "@cloudflare/workers-types";
import { mintIceToken } from "./utils/iceToken";
import { Env } from "./env";
import { extractPathInfo } from "./utils/url-utils";

export {};

declare global {
  interface CloudflareWebsocket {
    accept(): unknown;
    addEventListener(
      event: "close",
      callbackFunction: (code?: number, reason?: string) => unknown,
    ): unknown;
    addEventListener(
      event: "error",
      callbackFunction: (e: unknown) => unknown,
    ): unknown;
    addEventListener(
      event: "message",
      callbackFunction: (event: { data: any }) => unknown,
    ): unknown;

    /**
     * @param code https://developer.mozilla.org/en-US/docs/Web/API/CloseEvent
     * @param reason
     */
    close(code?: number, reason?: string): unknown;
    send(message: string | Uint8Array): unknown;
  }

  class WebSocketPair {
    0: WebSocket; // Client
    1: WebSocket; // Server
  }

  interface ResponseInit {
    webSocket?: CloudflareWebsocket;
  }
}

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
  joined: number;
};

type IncomingMessage = {
  to?: "server" | string;
  type?: string;
  payload?: AnyJson;
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
      secret: this.env.ICE_AUTH_SECRET ?? "ICE_AUTH_SECRET",
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
    const client = pair[0];
    const server = pair[1];

    // IMPORTANT: accept first
    this.state.acceptWebSocket(server);

    // Persist userId via attachment (survives hibernation)
    server.serializeAttachment({
      userId,
      worldId,
      roomId,
      host,
      joined: Date.now(),
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
            expiration: iceToken.expiration,
          }),
        );
      } else {
        try {
          ws.send(
            JSON.stringify([
              {
                type: "ice-server",
                url: `https://${host}/api/ice?token=${iceToken.token}`,
                expiration: iceToken.expiration,
              },
              {
                type: "peer-joined",
                userId,
                users: this.getAttachments(sockets)
                  .map(({ userId, joined }) => ({
                    userId,
                    joined,
                  }))
                  .toSorted((a, b) => {
                    if (a.joined !== b.joined) {
                      return a.joined - b.joined;
                    }
                    return a.userId.localeCompare(b.userId);
                  }),
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
      //  Non-string messages just get broadcasted
      for (const other of this.state.getWebSockets()) {
        if (other === ws) return;
        try {
          other.send(message);
        } catch {
          console.warn("Failed to send");
        }
      }

      console.debug(
        "Broadcasted message from",
        attachment.userId,
        "to",
        `${attachment.worldId}/${attachment.roomId}`,
      );
      return;
    }

    let data: IncomingMessage | IncomingMessage[];
    try {
      data = JSON.parse(message);
    } catch {
      ws.send(JSON.stringify({ type: "error", error: "invalid-json" }));
      return;
    }
    const msgs = Array.isArray(data) ? data : [data];
    msgs.forEach((msg) => {
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
    });
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
            users: this.getAttachments(sockets.filter((s) => s !== ws))
              .map(({ userId, joined }) => ({ userId, joined }))
              .toSorted((a, b) => {
                if (a.joined !== b.joined) {
                  return a.joined - b.joined;
                }
                return a.userId.localeCompare(b.userId);
              }),
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

  private timeout: ReturnType<typeof setTimeout> = 0;
  private readonly broadcastMessages: {
    type: string;
    userId: string;
    payload: any;
  }[] = [];

  private queueBroadcast({
    type,
    userId,
    payload,
  }: {
    type: string;
    userId: string;
    payload: any;
  }) {
    clearTimeout(this.timeout);
    this.broadcastMessages.push({ type, userId, payload });
    this.timeout = setTimeout(() => {
      for (const other of this.state.getWebSockets()) {
        const attachment = getAttachment(other);
        const filteredMessages = this.broadcastMessages.filter(
          ({ userId }) => attachment?.userId !== userId,
        );
        if (!filteredMessages.length) continue;
        try {
          other.send(JSON.stringify(filteredMessages));
        } catch {
          console.warn("Failed to send");
        }
      }
      this.broadcastMessages.length = 0;
    });
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
        this.queueBroadcast({ type, userId, payload });
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
