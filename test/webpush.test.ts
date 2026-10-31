import { describe, expect, test } from "bun:test";
import { generateVapidKeys, parseDevice, webPushSender } from "../src/webpush.ts";

describe("web push", () => {
  test("a push is an encrypted aes128gcm request with VAPID to the device's endpoint; 410 means the device is gone", async () => {
    const keys = generateVapidKeys();
    const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const p256dh = Buffer.from(await crypto.subtle.exportKey("raw", kp.publicKey)).toString("base64url");
    const auth = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
    const device = parseDevice({ endpoint: "https://web.push.apple.com/QW", keys: { p256dh, auth } })!;
    expect(device).not.toBeNull();
    const seen: { url: string; headers: Record<string, string>; bytes: number }[] = [];
    let status = 201;
    const sender = webPushSender("https://axos.example", keys, (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), headers: init!.headers as Record<string, string>, bytes: (init!.body as Uint8Array).byteLength });
      return new Response(null, { status });
    }) as typeof fetch);
    const payload = { title: "alice/dev1", body: "Deploy now?", url: "https://axos.example/ui#m1", tag: "axos-ask-1", priority: "high" as const, open: 1 };
    expect(await sender.send(device, payload, { ttl: 3600, urgency: "high", topic: "axos-ask-1" })).toBe("ok");
    expect(seen[0]!.url).toBe("https://web.push.apple.com/QW");
    expect(seen[0]!.headers["Content-Encoding"]).toBe("aes128gcm");
    expect(seen[0]!.headers["Authorization"]).toMatch(/^vapid t=.+, k=.+/);
    expect(seen[0]!.headers["Urgency"]).toBe("high");
    expect(seen[0]!.headers["Topic"]).toBe("axos-ask-1");
    expect(seen[0]!.bytes).toBeGreaterThan(JSON.stringify(payload).length);
    status = 410;
    expect(await sender.send(device, payload, { ttl: 3600, urgency: "high" })).toBe("gone");
    status = 500;
    await expect(sender.send(device, payload, { ttl: 3600, urgency: "high" })).rejects.toThrow("push service 500");
  });

  test("only a browser's subscription shape is accepted", () => {
    const keys = { p256dh: "B".repeat(87), auth: "a".repeat(22) };
    expect(parseDevice({ endpoint: "https://push.example/x", keys })).toMatchObject({ endpoint: "https://push.example/x" });
    expect(parseDevice({ endpoint: "http://push.example/x", keys })).toBeNull();
    expect(parseDevice({ endpoint: "https://push.example/x", keys: { ...keys, auth: "short" } })).toBeNull();
    expect(parseDevice({ endpoint: "https://push.example/x", keys: { ...keys, p256dh: "not base64url!" + "B".repeat(80) } })).toBeNull();
    expect(parseDevice({ endpoint: "https://push.example/x" })).toBeNull();
    expect(parseDevice(null)).toBeNull();
  });
});
