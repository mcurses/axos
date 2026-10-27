// Push to a human's phone through ntfy. Best effort: a failed push is logged as an event by the caller,
// the ask itself is already stored and visible in the UI.
export interface PushAction {
  label: string; // the button text
  url: string; // POSTed to when tapped
  body: string;
}

export interface Notifier {
  push(topic: string, msg: { title: string; body: string; clickUrl?: string; priority?: "default" | "high"; actions?: PushAction[] }): Promise<void>;
}

// JSON publishing: UTF-8 titles without header encoding, and up to three answer buttons.
export function ntfyNotifier(baseUrl: string, token?: string): Notifier {
  return {
    async push(topic, msg) {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;
      const payload = {
        topic,
        title: msg.title,
        message: msg.body,
        priority: msg.priority === "high" ? 4 : 3,
        tags: ["axos"],
        ...(msg.clickUrl ? { click: msg.clickUrl } : {}),
        ...(msg.actions?.length
          ? { actions: msg.actions.slice(0, 3).map((a) => ({ action: "http", label: a.label, url: a.url, method: "POST", body: a.body, clear: true })) }
          : {}),
      };
      const res = await fetch(baseUrl.replace(/\/$/, ""), { method: "POST", headers, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error(`ntfy ${res.status}`);
    },
  };
}

export const nullNotifier: Notifier = { async push() {} };
