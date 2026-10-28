import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// Served by the hub at /ui; `bun run dev` proxies the page's API to a local hub (AXOS_URL, default port 18900).
export default defineConfig({
  base: "/ui/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: { "/ui/api": process.env.AXOS_URL ?? "http://127.0.0.1:18900", "/ui/image": process.env.AXOS_URL ?? "http://127.0.0.1:18900" },
  },
})
