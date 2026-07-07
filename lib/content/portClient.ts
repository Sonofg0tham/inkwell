import { CHECK_PORT, type PortRequest, type PortResponse } from '../messaging/protocol';

const PING_INTERVAL_MS = 20_000;
const RECONNECT_DELAY_MS = 250;

interface Outstanding {
  chunkHash: string;
  text: string;
  handler: (r: PortResponse) => void;
}

/**
 * Long-lived port to the background with automatic reconnect. The MV3 service
 * worker can die at any time; onDisconnect triggers reconnection and re-sends
 * outstanding requests (idempotent — the background answers repeats from cache).
 */
export class PortClient {
  private port: chrome.runtime.Port | null = null;
  private outstanding = new Map<string, Outstanding>();
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private dead = false;

  check(
    requestId: string,
    chunkHash: string,
    text: string,
    handler: (r: PortResponse) => void,
  ): void {
    if (this.dead) return;
    this.outstanding.set(requestId, { chunkHash, text, handler });
    this.post({ t: 'check', requestId, chunkHash, text });
    this.updatePing();
  }

  cancel(requestIds: string[]): void {
    const live = requestIds.filter((id) => this.outstanding.delete(id));
    if (live.length > 0) this.post({ t: 'cancel', requestIds: live });
    this.updatePing();
  }

  destroy(): void {
    this.dead = true;
    this.outstanding.clear();
    this.updatePing();
    try {
      this.port?.disconnect();
    } catch {
      // already gone
    }
    this.port = null;
  }

  private ensureConnected(): chrome.runtime.Port | null {
    if (this.port) return this.port;
    try {
      const port = chrome.runtime.connect({ name: CHECK_PORT });
      port.onMessage.addListener((msg: PortResponse) => this.onMessage(msg));
      port.onDisconnect.addListener(() => {
        this.port = null;
        // SW restarted or extension reloaded. If the runtime is gone entirely,
        // chrome.runtime.id is undefined — stop trying.
        if (!chrome.runtime?.id) {
          this.dead = true;
          this.updatePing();
          return;
        }
        if (this.outstanding.size > 0) {
          setTimeout(() => this.resend(), RECONNECT_DELAY_MS);
        }
      });
      this.port = port;
      return port;
    } catch {
      this.dead = true;
      return null;
    }
  }

  private post(msg: PortRequest): void {
    const port = this.ensureConnected();
    if (!port) return;
    try {
      port.postMessage(msg);
    } catch {
      this.port = null;
    }
  }

  private resend(): void {
    if (this.dead) return;
    for (const [requestId, o] of this.outstanding) {
      this.post({ t: 'check', requestId, chunkHash: o.chunkHash, text: o.text });
    }
  }

  private onMessage(msg: PortResponse): void {
    const o = this.outstanding.get(msg.requestId);
    if (!o) return;
    this.outstanding.delete(msg.requestId);
    this.updatePing();
    o.handler(msg);
  }

  private updatePing(): void {
    const shouldPing = !this.dead && this.outstanding.size > 0;
    if (shouldPing && this.pingTimer === undefined) {
      this.pingTimer = setInterval(() => this.post({ t: 'ping' }), PING_INTERVAL_MS);
    } else if (!shouldPing && this.pingTimer !== undefined) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
  }
}
