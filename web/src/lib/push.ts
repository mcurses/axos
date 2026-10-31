// The page's own pushes: this browser subscribes with the hub's key and hands the subscription to the hub. On an
// iPhone that works only once the page is on the home screen; Safari in a tab cannot subscribe.
import { post } from "@/lib/api";

export type PushState =
  | { kind: "unsupported" } // no service worker or Push API here
  | { kind: "needs-install" } // iOS Safari in a tab: add to the home screen first
  | { kind: "denied" } // the person said no in the browser's dialog; only its settings undo that
  | { kind: "off" }
  | { kind: "on" };

const ios = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = () => window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

export function deviceLabel(): string {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "device";
  const app = standalone() ? "home screen" : /Firefox/.test(ua) ? "Firefox" : /Edg\//.test(ua) ? "Edge" : /Chrome/.test(ua) ? "Chrome" : /Safari/.test(ua) ? "Safari" : "browser";
  return `${os}, ${app}`;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.register("/ui/sw.js", { scope: "/ui/" });
}

export async function pushState(hubKey: string | null): Promise<PushState> {
  if (!hubKey || !("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return ios() && !standalone() && hubKey ? { kind: "needs-install" } : { kind: "unsupported" };
  }
  if (Notification.permission === "denied") return { kind: "denied" };
  const sub = await (await registration()).pushManager.getSubscription();
  return sub ? { kind: "on" } : { kind: "off" };
}

// Turn on: ask the browser, subscribe, register with the hub.
export async function enablePush(hubKey: string): Promise<void> {
  const reg = await registration();
  if ((await Notification.requestPermission()) !== "granted") throw new Error("the browser did not allow notifications");
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: hubKey });
  await post("push/subscribe", { subscription: sub.toJSON(), label: deviceLabel() });
}

export async function disablePush(): Promise<void> {
  const sub = await (await registration()).pushManager.getSubscription();
  if (!sub) return;
  await post("push/unsubscribe", { endpoint: sub.endpoint });
  await sub.unsubscribe();
}

// On every load of a subscribed device: tell the hub the subscription again (it is idempotent, and a hub whose
// database was restored learns the device back), set the badge, and take notifications of settled items off.
export async function syncPush(hubKey: string | null, open: number): Promise<void> {
  if (!hubKey || !("serviceWorker" in navigator) || !("PushManager" in window)) return;
  try {
    const reg = await registration();
    const sub = await reg.pushManager.getSubscription();
    if (sub) await post("push/subscribe", { subscription: sub.toJSON(), label: deviceLabel() });
    if ("setAppBadge" in navigator) await (open > 0 ? navigator.setAppBadge(open) : navigator.clearAppBadge());
    for (const n of await reg.getNotifications()) n.close();
  } catch {
    // Best effort: the page works without pushes.
  }
}
