import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import App from "./App.tsx"

// Light or dark like the device, and along when it switches.
const dark = window.matchMedia("(prefers-color-scheme: dark)")
const theme = () => document.documentElement.classList.toggle("dark", dark.matches)
theme()
dark.addEventListener("change", theme)

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
