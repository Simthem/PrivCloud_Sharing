import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useIntl } from "react-intl";

/** A stable portal keeps playback alive when a WebView needs an overlay fallback. */
export default function PreviewFullscreen({
  children,
}: {
  children: (_state: {
    fullscreen: boolean;
    toggleFullscreen: () => void;
  }) => ReactNode;
}) {
  const intl = useIntl();
  const dialogLabel = intl.formatMessage({
    id: "share.modal.file-preview.video.fullscreen",
    defaultMessage: "Full screen",
  });
  const placeholder = useRef<HTMLDivElement>(null);
  const [host] = useState(() =>
    typeof document === "undefined" ? null : document.createElement("div"),
  );
  const [fullscreen, setFullscreen] = useState(false);
  const [overlay, setOverlay] = useState(false);
  const pending = useRef(false);
  useLayoutEffect(() => {
    if (!host) return;
    placeholder.current?.appendChild(host);
    return () => {
      host.remove();
    };
  }, [host]);
  useEffect(() => {
    if (!host) return;
    const change = () => setFullscreen(document.fullscreenElement === host);
    const escape = (event: KeyboardEvent) => {
      // Capacitor translates Android Back to Escape. Consume it before the
      // surrounding preview modal so Back leaves fullscreen first.
      if (event.key === "Escape" && document.fullscreenElement === host) {
        event.preventDefault();
        event.stopImmediatePropagation();
        void document.exitFullscreen().catch(() => undefined);
      }
    };
    document.addEventListener("keydown", escape, true);
    document.addEventListener("fullscreenchange", change);
    return () => {
      document.removeEventListener("keydown", escape, true);
      document.removeEventListener("fullscreenchange", change);
      if (document.fullscreenElement === host)
        void document.exitFullscreen().catch(() => undefined);
    };
  }, [host]);
  useLayoutEffect(() => {
    if (!host || !overlay) return;
    const mount = placeholder.current;
    const overflow = document.body.style.overflow;
    const focus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    document.body.style.overflow = "hidden";
    document.body.appendChild(host);
    host.setAttribute("role", "dialog");
    host.setAttribute("aria-label", dialogLabel);
    host.setAttribute("aria-modal", "true");
    const exit = () => {
      setOverlay(false);
      setFullscreen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        exit();
      }
      if (event.key === "Tab") {
        const controls = Array.from(
          host.querySelectorAll<HTMLElement>(
            'button:not(:disabled), [tabindex="0"], video[controls]',
          ),
        );
        const first = controls[0],
          last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", key, true);
    host.querySelector<HTMLElement>("button")?.focus();
    return () => {
      document.removeEventListener("keydown", key, true);
      document.body.style.overflow = overflow;
      host.removeAttribute("role");
      host.removeAttribute("aria-label");
      host.removeAttribute("aria-modal");
      if (mount?.isConnected) mount.appendChild(host);
      focus?.focus();
    };
  }, [host, overlay, dialogLabel]);
  useLayoutEffect(() => {
    if (!host) return;
    Object.assign(host.style, {
      position: overlay ? "fixed" : "relative",
      inset: overlay ? "0" : "",
      zIndex: overlay ? "10000" : "",
      width: "100%",
      height: fullscreen ? "100%" : "auto",
      background: "#000",
      padding: overlay
        ? "env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)"
        : "",
      boxSizing: "border-box",
    });
  }, [host, fullscreen, overlay]);
  const toggleFullscreen = async () => {
    if (!host || pending.current) return;
    if (overlay) {
      setOverlay(false);
      setFullscreen(false);
      return;
    }
    if (document.fullscreenElement === host) {
      await document.exitFullscreen().catch(() => undefined);
      return;
    }
    pending.current = true;
    try {
      if (typeof host.requestFullscreen !== "function")
        throw new Error("Fullscreen unavailable");
      await host.requestFullscreen();
      setFullscreen(true);
    } catch {
      setOverlay(true);
      setFullscreen(true);
    } finally {
      pending.current = false;
    }
  };
  return (
    <>
      <div ref={placeholder} />
      {host &&
        createPortal(
          children({
            fullscreen,
            toggleFullscreen: () => {
              void toggleFullscreen();
            },
          }),
          host,
        )}
    </>
  );
}
