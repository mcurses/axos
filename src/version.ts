// The hub's release and the version of what clients rely on (tool names and arguments, hook JSON, event frames,
// headers; docs/PROTOCOL.md). The protocol number changes only when an existing client would break.
export const VERSION = "0.18.1";
// The plugin release that ships with this hub (plugin/.claude-plugin/plugin.json); a session on an older one is told once.
export const PLUGIN = "0.16.4";
export const PROTOCOL = 1;
