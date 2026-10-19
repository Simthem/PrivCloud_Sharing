import { Button, Group, Text } from "@mantine/core";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useIntl } from "react-intl";

/** Visual zoom works on the existing decrypted image/canvas, with bounded PDF rendering. */
export default function ZoomablePreview({
  children,
  onZoomChange,
}: {
  children: ReactNode;
  onZoomChange?: (_zoom: number) => void;
}) {
  const intl = useIntl();
  const viewport = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const frame = useRef(0);
  const callback = useRef(onZoomChange);
  callback.current = onZoomChange;
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const change = (value: number, x?: number, y?: number) => {
    const node = viewport.current;
    if (!node) return;
    const next = Math.max(0.25, Math.min(4, value));
    const bounds = node.getBoundingClientRect();
    const anchorX = x === undefined ? node.clientWidth / 2 : x - bounds.left;
    const anchorY = y === undefined ? node.clientHeight / 2 : y - bounds.top;
    const left =
      ((node.scrollLeft + anchorX) * next) / zoomRef.current - anchorX;
    const top = ((node.scrollTop + anchorY) * next) / zoomRef.current - anchorY;
    zoomRef.current = next;
    setZoom(next);
    callback.current?.(next);
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      node.scrollLeft = left;
      node.scrollTop = top;
    });
  };
  const wheelZoom = useRef(change);
  wheelZoom.current = change;
  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      wheelZoom.current(
        zoomRef.current * Math.exp(-event.deltaY * 0.005),
        event.clientX,
        event.clientY,
      );
    };
    node.addEventListener("wheel", wheel, { passive: false });
    return () => node.removeEventListener("wheel", wheel);
  }, []);
  const label = (id: string, defaultMessage: string) =>
    intl.formatMessage({
      id: `share.modal.file-preview.zoom.${id}`,
      defaultMessage,
    });
  return (
    <div>
      <Group gap="xs" justify="center" mb="xs" wrap="nowrap">
        <Button
          variant="default"
          size="xs"
          aria-label={label("out", "Zoom out")}
          disabled={zoom <= 0.25}
          onClick={() => change(zoom / 1.25)}
        >
          −
        </Button>
        <Text
          size="sm"
          aria-live="polite"
          style={{ minWidth: 46, textAlign: "center" }}
        >
          {Math.round(zoom * 100)}%
        </Text>
        <Button
          variant="default"
          size="xs"
          aria-label={label("in", "Zoom in")}
          disabled={zoom >= 4}
          onClick={() => change(zoom * 1.25)}
        >
          +
        </Button>
        <Button variant="default" size="xs" onClick={() => change(1)}>
          {label("reset", "Fit")}
        </Button>
      </Group>
      <div
        ref={viewport}
        data-document-viewport
        tabIndex={0}
        aria-label={label("viewport", "Document: pinch to zoom, drag to move")}
        style={{
          maxHeight: "65vh",
          overflow: "auto",
          touchAction: "none",
          overscrollBehavior: "contain",
          cursor: zoom > 1 ? "grab" : "auto",
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "+" || event.key === "=")
            change(zoomRef.current * 1.25);
          else if (event.key === "-") change(zoomRef.current / 1.25);
          else if (event.key === "0") change(1);
          else return;
          event.preventDefault();
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          pointers.current.set(event.pointerId, {
            x: event.clientX,
            y: event.clientY,
          });
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const previous = pointers.current.get(event.pointerId),
            node = viewport.current;
          if (!previous || !node) return;
          const other = Array.from(pointers.current.entries()).find(
            ([id]) => id !== event.pointerId,
          )?.[1];
          const current = { x: event.clientX, y: event.clientY };
          pointers.current.set(event.pointerId, current);
          if (other) {
            const before = Math.hypot(
              previous.x - other.x,
              previous.y - other.y,
            );
            if (before > 8)
              change(
                (zoomRef.current *
                  Math.hypot(current.x - other.x, current.y - other.y)) /
                  before,
                (other.x + current.x) / 2,
                (other.y + current.y) / 2,
              );
          } else {
            node.scrollLeft -= current.x - previous.x;
            node.scrollTop -= current.y - previous.y;
          }
        }}
        onLostPointerCapture={(event) =>
          pointers.current.delete(event.pointerId)
        }
        onPointerUp={(event) => pointers.current.delete(event.pointerId)}
        onPointerCancel={(event) => pointers.current.delete(event.pointerId)}
      >
        <div
          style={{
            width: `${zoom * 100}%`,
            marginInline: zoom < 1 ? "auto" : undefined,
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
