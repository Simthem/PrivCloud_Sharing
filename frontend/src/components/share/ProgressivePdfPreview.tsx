import ZoomablePreview from "./ZoomablePreview";
import {
  Button,
  Center,
  Group,
  Loader,
  NumberInput,
  Stack,
  Text,
} from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import { TbChevronLeft, TbChevronRight } from "react-icons/tb";
import { useIntl } from "react-intl";
import { fetchFilePreviewSource } from "../../services/share.service";
import { readPreviewBytes } from "../../utils/previewRange.util";

/** PDF.js asks for the required plaintext ranges; one canvas stays mounted. */
export default function ProgressivePdfPreview({
  shareId,
  fileId,
  e2eKey,
  onError,
}: {
  shareId: string;
  fileId: string;
  e2eKey?: string | null;
  onError: () => void;
}) {
  const intl = useIntl();
  const label = (id: string, defaultMessage: string) =>
    intl.formatMessage({
      id: `share.modal.file-preview.pdf.${id}`,
      defaultMessage,
    });
  const canvas = useRef<HTMLCanvasElement>(null);
  const [document, setDocument] = useState<
    import("pdfjs-dist").PDFDocumentProxy | null
  >(null);
  const [zoom, setZoom] = useState(1);
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    let task: import("pdfjs-dist").PDFDocumentLoadingTask | undefined;
    setDocument(null);
    setPage(1);
    setBusy(true);
    (async () => {
      const [pdfjs, source] = await Promise.all([
        import("pdfjs-dist"),
        fetchFilePreviewSource(shareId, fileId, e2eKey, controller.signal),
      ]);
      controller.signal.throwIfAborted();
      pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
      const transport = new pdfjs.PDFDataRangeTransport(
        source.size,
        await readPreviewBytes(
          source,
          0,
          Math.min(source.size, 64 * 1024),
          controller.signal,
        ),
        true,
      );
      transport.requestDataRange = (begin, end) => {
        readPreviewBytes(source, begin, end, controller.signal)
          .then((bytes) => {
            if (!controller.signal.aborted) transport.onDataRange(begin, bytes);
          })
          .catch(() => {
            if (!controller.signal.aborted) {
              controller.abort();
              void task?.destroy();
              onError();
            }
          });
      };
      transport.abort = () => controller.abort();
      task = pdfjs.getDocument({
        range: transport,
        disableAutoFetch: true,
        disableStream: true,
        rangeChunkSize: 64 * 1024,
        isEvalSupported: false,
      });
      const loaded = await task.promise;
      if (controller.signal.aborted) {
        await loaded.destroy();
        return;
      }
      setDocument(loaded);
    })().catch(() => {
      if (!controller.signal.aborted) onError();
    });
    return () => {
      controller.abort();
      void task?.destroy();
    };
  }, [shareId, fileId, e2eKey, onError]);
  useEffect(() => {
    if (!document) return;
    let cancelled = false;
    let render: import("pdfjs-dist").RenderTask | undefined;
    setBusy(true);
    (async () => {
      const pdfPage = await document.getPage(page);
      if (cancelled || !canvas.current) return;
      const base = pdfPage.getViewport({ scale: 1 });
      const width =
        canvas.current.closest<HTMLElement>("[data-document-viewport]")
          ?.clientWidth || 600;
      const scale = Math.min(
        (width / base.width) * zoom * Math.min(2, window.devicePixelRatio || 1),
        Math.sqrt(4_000_000 / (base.width * base.height)),
      );
      const viewport = pdfPage.getViewport({ scale });
      // The previous page stays on screen until the next one is drawn.
      const frame = window.document.createElement("canvas");
      frame.width = Math.ceil(viewport.width);
      frame.height = Math.ceil(viewport.height);
      const context = frame.getContext("2d");
      if (!context) throw new Error("PDF canvas unavailable");
      render = pdfPage.render({ canvasContext: context, viewport });
      await render.promise;
      pdfPage.cleanup();
      const target = canvas.current;
      if (cancelled || !target) return;
      target.width = frame.width;
      target.height = frame.height;
      target.getContext("2d")?.drawImage(frame, 0, 0);
    })()
      .catch(() => {
        if (!cancelled) onError();
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
      render?.cancel();
    };
  }, [document, page, onError, zoom]);
  return (
    <Stack>
      <Group justify="center">
        <Button
          variant="default"
          aria-label={label("previous-page", "Previous page")}
          disabled={!document || page <= 1 || busy}
          onClick={() => setPage((n) => n - 1)}
        >
          <TbChevronLeft size={18} />
        </Button>
        <NumberInput
          aria-label={label("page", "PDF page")}
          min={1}
          max={document?.numPages || 1}
          value={page}
          disabled={!document || busy}
          w={85}
          onChange={(value) => {
            if (
              typeof value === "number" &&
              document &&
              Number.isInteger(value) &&
              value >= 1 &&
              value <= document.numPages
            )
              setPage(value);
          }}
        />
        {document && <Text>/ {document.numPages}</Text>}
        <Button
          variant="default"
          aria-label={label("next-page", "Next page")}
          disabled={!document || page >= document.numPages || busy}
          onClick={() => setPage((n) => n + 1)}
        >
          <TbChevronRight size={18} />
        </Button>
      </Group>
      <ZoomablePreview key={fileId} onZoomChange={setZoom}>
        <div style={{ position: "relative", minHeight: 80 }}>
          <canvas
            ref={canvas}
            style={{
              width: "100%",
              height: "auto",
              display: "block",
            }}
          />
          {busy && (
            <Center style={{ position: "absolute", inset: 0 }}>
              <Loader />
            </Center>
          )}
        </div>
      </ZoomablePreview>
    </Stack>
  );
}
