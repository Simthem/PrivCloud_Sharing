import { Alert, Button, Center, Loader, Stack, Text } from "@mantine/core"
import { useEffect, useRef, useState } from "react"
import { createExternalPageQueue } from "../../utils/externalPageQueue.util"
import { EXTERNAL_PAGE_MAX_BYTES } from "../../utils/externalPreviewLayout.util"
import useTranslate from "../../hooks/useTranslate.hook"
import teamExternalService from "../../services/teamExternal.service"
import {
  decryptExternalPage,
  type ExternalManifest,
} from "../../utils/externalPreviewCrypto.util"

const preventDefault = (event: React.SyntheticEvent) => event.preventDefault()

/**
 * One page, fetched and decrypted when it comes near the viewport, then drawn
 * into a canvas: there is no image URL to open, save or share.
 */
function PageCanvas({
  previewId,
  index,
  width,
  height,
  label,
  previewKey,
  queue,
}: {
  previewId: string
  index: number
  width: number
  height: number
  label?: string
  previewKey: CryptoKey
  queue: ReturnType<typeof createExternalPageQueue>
}) {
  const t = useTranslate()
  const canvas = useRef<HTMLCanvasElement>(null)
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<
    "waiting" | "loading" | "decrypting" | "drawing" | "ready" | "error"
  >("waiting")

  useEffect(() => {
    const element = canvas.current
    if (!element) return
    let controller: AbortController | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    let ready = false
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) {
          if (ready) {
            ready = false
            element.width = element.height = 1
            controller = undefined
            setState("waiting")
          }
          if (!ready && controller) {
            controller.abort()
            clearTimeout(deadline)
            controller = undefined
            setState("waiting")
          }
          return
        }
        if (ready || controller) return
        const request = new AbortController()
        let requestDeadline: ReturnType<typeof setTimeout> | undefined
        controller = request
        setState("loading")
        const priority = () => {
          const bounds = element.getBoundingClientRect()
          return bounds.top < window.innerHeight && bounds.bottom > 0
            ? -100_000 + Math.abs(bounds.top)
            : Math.abs(bounds.top)
        }
        void queue
          .run(priority, request.signal, async (signal) => {
            requestDeadline = setTimeout(() => {
              request.abort(new DOMException("Page timed out", "TimeoutError"))
              setState("error")
            }, 60_000)
            deadline = requestDeadline
            const sealed = await teamExternalService.getContractorPage(
              previewId,
              index,
              signal,
            )
            signal.throwIfAborted()
            if (sealed.length > EXTERNAL_PAGE_MAX_BYTES + 64)
              throw new Error("Oversized page")
            setState("decrypting")
            let image: Uint8Array | undefined
            let bitmap: ImageBitmap | undefined
            try {
              image = await decryptExternalPage(
                previewKey,
                previewId,
                index,
                sealed,
              )
              signal.throwIfAborted()
              if (image.length > EXTERNAL_PAGE_MAX_BYTES)
                throw new Error("Oversized page")
              if (
                image[0] === 137 &&
                image[1] === 80 &&
                image[2] === 78 &&
                image[3] === 71
              ) {
                if (image.length < 24) throw new Error("Invalid PNG page")
                const header = new DataView(
                  image.buffer,
                  image.byteOffset,
                  image.byteLength,
                )
                if (
                  header.getUint32(16) !== width ||
                  header.getUint32(20) !== height
                )
                  throw new Error("Unexpected PNG page dimensions")
              }
              setState("drawing")
              bitmap = await createImageBitmap(
                new Blob([image as Uint8Array<ArrayBuffer>]),
              )
              signal.throwIfAborted()
              if (bitmap.width !== width || bitmap.height !== height)
                throw new Error("Unexpected page dimensions")
              element.width = width
              element.height = height
              const context = element.getContext("2d")
              if (!context) throw new Error("Canvas unavailable")
              context.drawImage(bitmap, 0, 0)
              ready = true
              setState("ready")
            } finally {
              bitmap?.close()
              image?.fill(0)
            }
          })
          .catch(() => {
            if (!request.signal.aborted) setState("error")
          })
          .finally(() => clearTimeout(requestDeadline))
      },
      {
        rootMargin:
          Math.min(3000, Math.max(800, window.innerHeight * 2)) + "px 0px",
      },
    )
    observer.observe(element)
    return () => {
      observer.disconnect()
      controller?.abort()
      clearTimeout(deadline)
      element.width = element.height = 1
    }
  }, [previewId, index, width, height, previewKey, queue, attempt])

  return (
    <Stack gap={4}>
      {label && (
        <Text size="xs" c="dimmed">
          {label}
        </Text>
      )}
      <div
        style={{
          position: "relative",
          width: "100%",
          maxWidth: width,
          aspectRatio: `${width} / ${height}`,
          background: "#fff",
          boxShadow: "0 2px 12px #0002",
          margin: "0 auto",
        }}
      >
        <canvas
          ref={canvas}
          width={1}
          height={1}
          aria-label={t("external.viewer.page", { page: index + 1 })}
          style={{ width: "100%", height: "100%", display: "block" }}
        />
        {state !== "ready" && (
          <Center style={{ position: "absolute", inset: 0 }}>
            {state === "error" ? (
              <Stack align="center" gap="xs">
                <Text size="sm" c="red">
                  {t("external.viewer.pageError")}
                </Text>
                <Button
                  size="xs"
                  variant="light"
                  onClick={() => setAttempt((value) => value + 1)}
                >
                  {t("external.viewer.retry")}
                </Button>
              </Stack>
            ) : (
              <Stack align="center" gap="xs">
                <Loader size="sm" />
                <Text size="xs" c="dimmed">
                  {t("external.viewer.phase." + state)}
                </Text>
              </Stack>
            )}
          </Center>
        )}
      </div>
    </Stack>
  )
}

export default function ExternalPreviewViewer({
  previewId,
  previewKey,
  manifest,
}: {
  previewId: string
  previewKey: CryptoKey
  manifest: ExternalManifest
}) {
  const t = useTranslate()
  const [queue] = useState(() => createExternalPageQueue())
  // Each child aborts its own queued or active job during effect cleanup.
  // Closing the shared queue in an effect would break StrictMode replays.
  return (
    <Stack
      gap="lg"
      onContextMenu={preventDefault}
      onDragStart={preventDefault}
      style={{ userSelect: "none", WebkitUserSelect: "none" }}
    >
      <Alert color="grape" variant="light">
        {t("external.viewer.notice", { watermark: manifest.watermark })}
      </Alert>
      {manifest.pages.length === 0 ? (
        <Text c="dimmed">{t("external.viewer.empty")}</Text>
      ) : (
        manifest.pages.map((page, index) => (
          <PageCanvas
            key={index}
            previewId={previewId}
            index={index}
            width={page.width}
            height={page.height}
            label={page.label}
            previewKey={previewKey}
            queue={queue}
          />
        ))
      )}
    </Stack>
  )
}
