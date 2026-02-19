import { IceUrlProvider } from "./ice-url-provider";

const FALLBACK_RTC_CONFIG = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

export class RTCConfigProvider {
  constructor(private iceUrlProvider: IceUrlProvider) {}

  private rtcConfig: RTCConfiguration & { timestamp: number } = {
    ...FALLBACK_RTC_CONFIG,
    timestamp: Date.now(),
  };
  private rtcConfigPromise?: Promise<RTCConfiguration & { timestamp: number }>;

  async getRtcConfig(): Promise<RTCConfiguration & { timestamp: number }> {
    const now = Date.now();
    if (now - (this.rtcConfig?.timestamp ?? 0) < 10000) {
      return this.rtcConfig;
    }

    if (!this.rtcConfigPromise) {
      this.rtcConfigPromise = new Promise<
        RTCConfiguration & { timestamp: number }
      >(async (resolve) => {
        let retries = 3;
        for (let r = 0; r < retries; r++) {
          try {
            const iceUrl = (await this.iceUrlProvider.requestIce()).url;
            const r = await fetch(iceUrl);
            if (!r.ok) throw new Error(`ICE endpoint failed: ${r.status}`);
            const rtcConfig = (await r.json()) as RTCConfiguration & {
              timestamp: number;
            };
            resolve(rtcConfig);
            return;
          } catch (e) {
            console.warn("Failed fetching iceUrl");
          }
        }
      });
      this.rtcConfig = await this.rtcConfigPromise;
      this.rtcConfigPromise = undefined;
    }
    return this.rtcConfig;
  }
}
