import { DurableObjectNamespace, Fetcher } from "@cloudflare/workers-types";

export interface Env {
  ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
  CF_TURN_TOKEN_ID: string;
  CF_RTC_API_TOKEN: string;
  ICE_AUTH_SECRET: string;
}
