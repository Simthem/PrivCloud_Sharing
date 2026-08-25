import { useEffect } from "react";

const INSTALLED_KEY = "privcloud_pwa_installed";
const MANIFEST_HREF = "/manifest.json";

const PwaInstallPrompt = () => {
  useEffect(() => {
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined;
    let idleId: number | undefined;

    const appendManifest = () => {
      if (document.querySelector('link[rel="manifest"]')) return;

      const link = document.createElement("link");
      link.rel = "manifest";
      link.href = MANIFEST_HREF;
      document.head.appendChild(link);
    };

    const scheduleManifest = () => {
      if ("requestIdleCallback" in window) {
        idleId = window.requestIdleCallback(appendManifest, { timeout: 4000 });
      } else {
        timeoutId = globalThis.setTimeout(appendManifest, 2500);
      }
    };

    if (document.readyState === "complete") {
      scheduleManifest();
    } else {
      window.addEventListener("load", scheduleManifest, { once: true });
    }

    const handleAppInstalled = () => {
      localStorage.setItem(INSTALLED_KEY, "1");
    };

    window.addEventListener("appinstalled", handleAppInstalled);

    return () => {
      window.removeEventListener("load", scheduleManifest);
      if (timeoutId !== undefined) globalThis.clearTimeout(timeoutId);
      if (idleId !== undefined) window.cancelIdleCallback?.(idleId);
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, []);

  return null;
};

export default PwaInstallPrompt;
