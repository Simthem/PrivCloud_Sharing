import { useRef, useState, useCallback } from "react";
import {
  ActionIcon,
  Box,
  Paper,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { TbEraser, TbUpload } from "react-icons/tb";

export type SignatureMode = "draw" | "type" | "upload";

interface SignaturePadProps {
  onSignatureChange: (_dataUrl: string | null) => void;
  onModeChange?: (_mode: SignatureMode) => void;
  width?: number;
  height?: number;
}

const SignaturePad = ({
  onSignatureChange,
  onModeChange,
  width = 400,
  height = 160,
}: SignaturePadProps) => {
  const [mode, setMode] = useState<SignatureMode>("draw");
  const [typedText, setTypedText] = useState("");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isDrawing = useRef(false);

  // --- Helpers: get coordinates from mouse or touch event --------
  const getCoords = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();
      if ("touches" in e) {
        const touch = e.touches[0] || e.changedTouches[0];
        return {
          x: touch.clientX - rect.left,
          y: touch.clientY - rect.top,
        };
      }
      return {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };
    },
    [],
  );

  // --- Draw mode -------------------------------------------------
  const startDraw = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      // Prevent page scroll while drawing on mobile
      if ("touches" in e) e.preventDefault();
      isDrawing.current = true;
      const { x, y } = getCoords(e);
      ctx.beginPath();
      ctx.moveTo(x, y);
    },
    [getCoords],
  );

  const draw = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
      if (!isDrawing.current) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      if ("touches" in e) e.preventDefault();
      const { x, y } = getCoords(e);
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.strokeStyle = "#1a1a2e";
      ctx.lineTo(x, y);
      ctx.stroke();
    },
    [getCoords],
  );

  const endDraw = useCallback(
    (e?: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
      if ("touches" in (e || {})) (e as React.TouchEvent)?.preventDefault?.();
      isDrawing.current = false;
      const canvas = canvasRef.current;
      if (canvas) {
        onSignatureChange(canvas.toDataURL("image/png"));
      }
    },
    [onSignatureChange],
  );

  const clearCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    onSignatureChange(null);
  }, [onSignatureChange]);

  // --- Type mode -------------------------------------------------
  const handleTypedChange = useCallback(
    (val: string) => {
      setTypedText(val);
      if (!val.trim()) {
        onSignatureChange(null);
        return;
      }
      // Render text to canvas-like data URL
      const offscreen = document.createElement("canvas");
      offscreen.width = width;
      offscreen.height = height;
      const ctx = offscreen.getContext("2d");
      if (!ctx) return;
      ctx.font = `italic 32px "Dancing Script", "Segoe Script", cursive`;
      ctx.fillStyle = "#1a1a2e";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(val, width / 2, height / 2);
      onSignatureChange(offscreen.toDataURL("image/png"));
    },
    [onSignatureChange, width, height],
  );

  // --- Upload mode -----------------------------------------------
  const handleFileUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (!file.type.startsWith("image/")) return;
      if (file.size > 2_000_000) return; // max 2MB

      const reader = new FileReader();
      reader.onload = () => {
        onSignatureChange(reader.result as string);
      };
      reader.readAsDataURL(file);
    },
    [onSignatureChange],
  );

  return (
    <Stack gap="sm">
      <SegmentedControl
        value={mode}
        onChange={(val) => {
          const newMode = val as SignatureMode;
          setMode(newMode);
          onSignatureChange(null);
          onModeChange?.(newMode);
        }}
        data={[
          { label: "Dessiner", value: "draw" },
          { label: "Saisir", value: "type" },
          { label: "Importer", value: "upload" },
        ]}
        size="sm"
      />

      <Paper
        withBorder
        p="xs"
        style={{
          width: "100%",
          maxWidth: width,
          height: height + 20,
          position: "relative",
          background: "#fafafa",
          touchAction: "none",
        }}
      >
        {mode === "draw" && (
          <>
            <canvas
              ref={canvasRef}
              width={width - 16}
              height={height}
              style={{
                cursor: "crosshair",
                display: "block",
                width: "100%",
                height: "100%",
                touchAction: "none",
              }}
              onMouseDown={startDraw}
              onMouseMove={draw}
              onMouseUp={endDraw}
              onMouseLeave={endDraw}
              onTouchStart={startDraw}
              onTouchMove={draw}
              onTouchEnd={endDraw}
              onTouchCancel={endDraw}
            />
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              style={{ position: "absolute", top: 4, right: 4 }}
              onClick={clearCanvas}
              title="Effacer"
            >
              <TbEraser size={16} />
            </ActionIcon>
          </>
        )}

        {mode === "type" && (
          <Box
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
            }}
          >
            <TextInput
              placeholder="Votre signature"
              value={typedText}
              onChange={(e) => handleTypedChange(e.currentTarget.value)}
              size="lg"
              style={{ fontFamily: "\"Dancing Script\", cursive", width: "80%" }}
              styles={{
                input: {
                  fontFamily: "\"Dancing Script\", \"Segoe Script\", cursive",
                  fontSize: 28,
                  textAlign: "center",
                },
              }}
            />
          </Box>
        )}

        {mode === "upload" && (
          <Box
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
              gap: 8,
            }}
          >
            <TbUpload size={24} />
            <Text size="sm" c="dimmed">
              Image PNG/JPG (max 2 Mo)
            </Text>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={handleFileUpload}
              style={{ marginTop: 8 }}
            />
          </Box>
        )}
      </Paper>
    </Stack>
  );
};

export default SignaturePad;
