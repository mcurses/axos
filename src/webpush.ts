// Push to a human's phone through the page itself: the page, installed on the home screen, holds a Web Push
// subscription, and the hub sends to it with VAPID (the hub's own key pair, kept in the database) and RFC 8291
// payload encryption. Nothing but the push service of the device's vendor is in between, and it sees ciphertext.
import webpush from "web-push";

export interface PushDevice {
  endpoint: string; // the push service URL the browser handed out
  p256dh: string; // the device's public key (base64url)
  auth: string; // the device's auth secret (base64url)
}

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

// What a push carries; the page's service worker shows it.
export interface WebPushPayload {
  title: string;
  body: string;
  url: string; // the page, with the item's anchor
  tag: string; // a later push with the same tag replaces this one on the device
  priority: "low" | "high";
  open: number; // the human's open questions and unread messages, for the app badge
}

// 'gone': the device unsubscribed (the push service answers 404 or 410); the caller forgets it.
export type PushOutcome = "ok" | "gone" | "failed";

export interface WebPush {
  send(device: PushDevice, payload: WebPushPayload, opts: { ttl: number; urgency: "low" | "high"; topic?: string }): Promise<PushOutcome>;
}

export function generateVapidKeys(): VapidKeys {
  return webpush.generateVAPIDKeys();
}

// subject: who the push service may contact about this sender: the hub's public URL (VAPID requires https: or mailto:).
export function webPushSender(subject: string, keys: VapidKeys, fetchFn: typeof fetch = fetch): WebPush {
  return {
    async send(device, payload, opts) {
      const r = webpush.generateRequestDetails(
        { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
        JSON.stringify(payload),
        { vapidDetails: { subject, ...keys }, TTL: opts.ttl, urgency: opts.urgency, topic: opts.topic, contentEncoding: "aes128gcm" },
      );
      const res = await fetchFn(r.endpoint, { method: r.method, headers: r.headers as Record<string, string>, body: new Uint8Array(r.body as Buffer) });
      if (res.ok) return "ok";
      if (res.status === 404 || res.status === 410) return "gone";
      throw new Error(`push service ${res.status}`);
    },
  };
}

const B64URL = /^[A-Za-z0-9_-]+$/;

// A subscription as the browser serialises it; anything else is rejected before it reaches the database.
export function parseDevice(input: unknown): PushDevice | null {
  const s = input as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  if (!s || typeof s.endpoint !== "string" || !s.keys || typeof s.keys.p256dh !== "string" || typeof s.keys.auth !== "string") return null;
  let url: URL;
  try { url = new URL(s.endpoint); } catch { return null; }
  if (url.protocol !== "https:" || s.endpoint.length > 2048) return null;
  if (!B64URL.test(s.keys.p256dh) || s.keys.p256dh.length < 80 || s.keys.p256dh.length > 100) return null;
  if (!B64URL.test(s.keys.auth) || s.keys.auth.length < 16 || s.keys.auth.length > 32) return null;
  return { endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth };
}
