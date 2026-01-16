import { Request } from "@cloudflare/workers-types";

export function extractPathInfo(request: Request): {
  roomId?: string;
  worldId?: string;
  userId?: string;
  host: string;
} {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/room\/([^/]+)\/([^/]+)$/);
  const userId = url.searchParams.get("userId") ?? undefined;

  const worldId = match ? decodeURIComponent(match[1]) : undefined;
  const roomId = match ? decodeURIComponent(match[2]) : undefined;
  return { worldId, roomId, userId, host: url.host };
}
