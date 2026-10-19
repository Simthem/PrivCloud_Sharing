import { MantineProvider } from "@mantine/core"
import { StrictMode, useLayoutEffect } from "react"
import { createRoot } from "react-dom/client"
import ExternalPreviewViewer from "../../src/components/external/ExternalPreviewViewer"

declare global {
  var initialCanvases: number[][]
  var viewerReady: boolean
  var violations: string[]
}

async function main() {
  const raw = new Uint8Array(await (await fetch("/fixture-key")).arrayBuffer())
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"])
  raw.fill(0)
  function Fixture() {
    useLayoutEffect(() => {
      globalThis.initialCanvases = [...document.querySelectorAll("canvas")].map(item => [item.width, item.height])
      globalThis.viewerReady = true
    }, [])
    return <ExternalPreviewViewer previewId="synthetic-viewer" previewKey={key} manifest={{
      v: 1, title: "Synthetic fixture", watermark: "Synthetic", createdAt: "2026-10-14T00:00:00Z",
      pages: Array.from({ length: 30 }, () => ({ width: 512, height: 640 })),
    }} />
  }
  globalThis.violations = []
  addEventListener("securitypolicyviolation", event => globalThis.violations.push(event.violatedDirective))
  createRoot(document.getElementById("root")!).render(<StrictMode><MantineProvider getStyleNonce={() => "viewer-fixture"}><Fixture /></MantineProvider></StrictMode>)
}
void main()
