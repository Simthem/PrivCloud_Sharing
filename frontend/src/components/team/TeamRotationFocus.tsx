import { Box } from "@mantine/core";
import { useRouter } from "next/router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import useTranslate from "../../hooks/useTranslate.hook";
import styles from "./TeamDashboard.module.css";

export default function TeamRotationFocus({
  ready,
  children,
}: {
  ready: boolean;
  children: ReactNode;
}) {
  const router = useRouter();
  const t = useTranslate();
  const region = useRef<HTMLDivElement>(null);
  const [highlighted, setHighlighted] = useState(false);
  const targetRequested = router.isReady && router.asPath.split("#")[1] === "e2e-rotation";
  const teamPath = router.asPath.split(/[?#]/, 1)[0];

  useEffect(() => {
    if (!ready || !targetRequested) {
      setHighlighted(false);
      return;
    }
    setHighlighted(true);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    region.current?.scrollIntoView({
      behavior: reducedMotion ? "auto" : "smooth",
      block: "center",
    });
    region.current?.focus({ preventScroll: true });
    const timer = window.setTimeout(() => setHighlighted(false), 4000);
    return () => window.clearTimeout(timer);
  }, [ready, targetRequested, teamPath]);

  return (
    <Box
      ref={region}
      id={ready ? "e2e-rotation" : undefined}
      className={[styles.rotationTarget, highlighted && styles.rotationHighlight].filter(Boolean).join(" ")}
      role="region"
      aria-label={t("team.settings.rotation.title")}
      tabIndex={-1}
    >
      {children}
    </Box>
  );
}
