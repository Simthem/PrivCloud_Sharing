import "@mantine/core/styles/Slider.css";
import {
  ActionIcon,
  Box,
  Center,
  Group,
  Loader,
  Slider,
  Text,
} from "@mantine/core";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  TbMaximize,
  TbMinimize,
  TbPlayerPauseFilled,
  TbPlayerPlayFilled,
  TbVolume,
  TbVolume3,
} from "react-icons/tb";
import { useIntl } from "react-intl";
import { createProgressiveMediaUrl } from "../../utils/previewMedia.util";
import { fetchFilePreviewSource } from "../../services/share.service";
import {
  HEVC_FORMATS,
  type Mp4AudioTrack,
  type Mp4VideoTrack,
  readMp4Index,
  videoCodecName,
} from "../../utils/mp4Index.util";
import {
  type PreviewByteSource,
  readPreviewBytes,
} from "../../utils/previewRange.util";
import {
  canDecodeVideoInSoftware,
  type SoftwarePlaybackState,
  SoftwareVideoPlayback,
} from "../../utils/softwareVideoPlayback.util";

import PreviewFullscreen from "./PreviewFullscreen";

const SEEK_STEP_SECONDS = 5;

const formatTime = (seconds: number) => {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, "0");
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}`
    : `${minutes}:${rest}`;
};

type Software = {
  track: Mp4VideoTrack;
  audioTrack: Mp4AudioTrack | null;
  source: PreviewByteSource;
};

/** What the preview shows, decided from the index of the file. */
type Plan =
  | { kind: "audio"; source: PreviewByteSource }
  | { kind: "software"; software: Software }
  | {
      kind: "native";
      source: PreviewByteSource;
      /** Taken over when the browser fails on a track it claimed to decode. */
      software: Software | null;
      /** Name of the indexed video codec, null when the file is no MP4. */
      codec: string | null;
    };

const browserDecodes = (codec: string) => {
  const type = `video/mp4; codecs="${codec}"`;
  return (
    (typeof MediaSource === "function" && MediaSource.isTypeSupported(type)) ||
    document.createElement("video").canPlayType(type) !== ""
  );
};

/**
 * Video preview. The index of an MP4 or QuickTime file is read first, which
 * costs a few small reads: an HEVC track the browser cannot decode is decoded
 * on the device, a file without pictures is played as sound, and the browser
 * player shows the rest. Starting the browser player on HEVC it cannot decode
 * would download much of the file before it gives up.
 */
export default function VideoPlayer({
  shareId,
  fileId,
  e2eKey,
  source,
  mediaSrc,
  mimeType,
  onUnsupported,
}: {
  shareId: string;
  fileId: string;
  e2eKey?: string | null;
  /** The source behind `mediaSrc`, when the page already opened one. */
  source: PreviewByteSource | null;
  /** The file as a media URL. */
  mediaSrc: string;
  mimeType: string;
  /** Codec name when known, null when the file could not be read. */
  onUnsupported: (_codec: string | null) => void;
}) {
  const intl = useIntl();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [nativeMedia, setNativeMedia] = useState<string | null>(null);
  const unsupported = useRef(onUnsupported);
  unsupported.current = onUnsupported;

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    setPlan(null);
    (async () => {
      const opened =
        source ??
        (await fetchFilePreviewSource(shareId, fileId, e2eKey, signal));
      const index = await readMp4Index(
        (start, end, readSignal) =>
          readPreviewBytes(opened, start, end, readSignal),
        opened.size,
        signal,
      ).catch(() => null);
      if (signal.aborted) return;
      // Not an MP4 or QuickTime file: the browser player decides alone.
      if (!index)
        return setPlan({
          kind: "native",
          source: opened,
          software: null,
          codec: null,
        });
      if (!index.video) return setPlan({ kind: "audio", source: opened });
      const software =
        HEVC_FORMATS.has(index.video.format) && canDecodeVideoInSoftware()
          ? { track: index.video, audioTrack: index.audio, source: opened }
          : null;
      setPlan(
        software && !browserDecodes(index.video.codec)
          ? { kind: "software", software }
          : {
              kind: "native",
              source: opened,
              software,
              codec: videoCodecName(index.video.format),
            },
      );
    })().catch(() => {
      if (!signal.aborted) unsupported.current(null);
    });
    return () => controller.abort();
  }, [shareId, fileId, e2eKey, source]);

  const browserSource = plan && plan.kind !== "software" ? plan.source : null;
  useEffect(() => {
    if (!browserSource) return;
    const controller = new AbortController();
    let release: (() => void) | undefined;
    setNativeMedia(null);
    createProgressiveMediaUrl(browserSource, mimeType, controller.signal)
      .then((media) => {
        release = media.release;
        if (controller.signal.aborted) release();
        else setNativeMedia(media.url);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        // Ordinary web files can still use the authenticated cookie API when
        // service workers are unavailable. Never expose an E2E key in a URL.
        if (!e2eKey && mediaSrc) setNativeMedia(mediaSrc);
        else unsupported.current(null);
      });
    return () => {
      controller.abort();
      release?.();
    };
  }, [browserSource, mimeType, mediaSrc, e2eKey]);

  const failed = useCallback(() => {
    unsupported.current(
      plan?.kind === "software"
        ? videoCodecName(plan.software.track.format)
        : null,
    );
  }, [plan]);

  if (!plan || (plan.kind !== "software" && !nativeMedia))
    return (
      <Center mih={200}>
        <Loader />
      </Center>
    );
  if (plan.kind === "audio")
    return (
      <Center mih={120}>
        <audio
          src={nativeMedia!}
          controls
          preload="metadata"
          style={{ width: "100%" }}
          onError={() => unsupported.current(null)}
        />
      </Center>
    );
  if (plan.kind === "software")
    return (
      <SoftwareVideoPlayer
        track={plan.software.track}
        source={plan.software.source}
        audioTrack={plan.software.audioTrack}
        onError={failed}
      />
    );
  const undecodable = () =>
    plan.software
      ? setPlan({ kind: "software", software: plan.software })
      : unsupported.current(plan.codec);
  return (
    <PreviewFullscreen>
      {({ fullscreen, toggleFullscreen }) => (
        <Box
          style={{
            height: fullscreen ? "100%" : undefined,
            position: "relative",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
          }}
        >
          <video
            src={nativeMedia!}
            width="100%"
            controls
            playsInline
            preload="metadata"
            style={{
              maxHeight: fullscreen ? "calc(100dvh - 48px)" : "65vh",
              minHeight: 0,
              objectFit: "contain",
            }}
            onLoadedMetadata={(event) => {
              // Sound without pictures, although the index found a video track.
              if (plan.codec && !event.currentTarget.videoWidth) undecodable();
            }}
            onError={(event) => {
              const code = event.currentTarget.error?.code;
              if (
                code === MediaError.MEDIA_ERR_DECODE ||
                code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
              )
                undecodable();
              else unsupported.current(null);
            }}
          />
          <Group justify="flex-end" p={4}>
            <ActionIcon
              variant="subtle"
              color="gray"
              onClick={toggleFullscreen}
              aria-label={intl.formatMessage({
                id: fullscreen
                  ? "share.modal.file-preview.video.exit-fullscreen"
                  : "share.modal.file-preview.video.fullscreen",
              })}
            >
              {fullscreen ? <TbMinimize /> : <TbMaximize />}
            </ActionIcon>
          </Group>
        </Box>
      )}
    </PreviewFullscreen>
  );
}

function SoftwareVideoPlayer({
  track,
  audioTrack,
  source,
  onError,
}: {
  track: Mp4VideoTrack;
  audioTrack: Mp4AudioTrack | null;
  source: PreviewByteSource;
  onError: () => void;
}) {
  const intl = useIntl();
  const canvas = useRef<HTMLCanvasElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const player = useRef<SoftwareVideoPlayback | null>(null);
  const failed = useRef(onError);
  failed.current = onError;
  const [state, setState] = useState<SoftwarePlaybackState | null>(null);
  const [scrub, setScrub] = useState<number | null>(null);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);

  useEffect(() => {
    if (!canvas.current) return;
    let playback: SoftwareVideoPlayback;
    try {
      playback = new SoftwareVideoPlayback({
        track,
        audioTrack,
        read: (start, end, signal) =>
          readPreviewBytes(source, start, end, signal),
        size: source.size,
        canvas: canvas.current,
        audio: audio.current,
        onChange: setState,
        onError: () => failed.current(),
      });
    } catch {
      failed.current();
      return;
    }
    player.current = playback;
    return () => {
      playback.destroy();
      player.current = null;
    };
  }, [track, audioTrack, source]);

  const toggle = () => {
    if (!player.current || !state) return;
    if (state.playing) player.current.pause();
    else player.current.play();
  };
  const seekBy = (seconds: number) => {
    if (player.current)
      player.current.seek(player.current.currentTime + seconds);
  };
  const toggleMute = () => {
    if (!audio.current) return;
    audio.current.muted = !muted;
    setMuted(!muted);
  };
  const changeVolume = (value: number) => {
    if (!audio.current) return;
    audio.current.volume = value;
    audio.current.muted = value === 0;
  };
  const label = (id: string, defaultMessage: string) =>
    intl.formatMessage({
      id: `share.modal.file-preview.video.${id}`,
      defaultMessage,
    });

  const duration = state?.duration || 0;
  const current = scrub ?? state?.currentTime ?? 0;
  const busy = !state?.ready || (state.waiting && state.playing);

  return (
    <PreviewFullscreen>
      {({ fullscreen, toggleFullscreen }) => (
        <Box
          tabIndex={0}
          onKeyDown={(event) => {
            if (
              event.target instanceof Element &&
              event.target.closest("button, input, [role=slider]")
            )
              return;
            if (event.key === " " || event.key === "k") toggle();
            else if (event.key === "ArrowLeft") seekBy(-SEEK_STEP_SECONDS);
            else if (event.key === "ArrowRight") seekBy(SEEK_STEP_SECONDS);
            else return;
            event.preventDefault();
          }}
          style={{
            display: "flex",
            height: fullscreen ? "100%" : undefined,
            flexDirection: "column",
            justifyContent: "center",
            background: "#000",
            borderRadius: fullscreen ? 0 : 8,
            overflow: "hidden",
            outline: "none",
          }}
        >
          <Box
            pos="relative"
            onClick={toggle}
            style={{
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              minHeight: 200,
              flex: fullscreen ? 1 : undefined,
              cursor: state?.ready ? "pointer" : "default",
            }}
          >
            <canvas
              ref={canvas}
              // Sized like the native video element: full width, picture
              // contained within the height limit.
              style={{
                display: "block",
                width: "100%",
                height: "auto",
                maxHeight: fullscreen ? "calc(100dvh - 90px)" : "65vh",
                objectFit: "contain",
              }}
            />
            {busy && (
              <Center pos="absolute" inset={0}>
                <Loader color="gray" />
              </Center>
            )}
          </Box>
          {audioTrack && (
            <audio
              ref={audio}
              hidden
              onVolumeChange={(event) => {
                setVolume(event.currentTarget.volume);
                setMuted(event.currentTarget.muted);
              }}
            />
          )}
          <Box px="sm" pt={8}>
            <Slider
              min={0}
              max={duration || 1}
              step={0.1}
              value={Math.min(current, duration || 1)}
              disabled={!state?.ready}
              label={formatTime}
              onChange={setScrub}
              onChangeEnd={(value) => {
                player.current?.seek(value);
                setScrub(null);
              }}
              thumbLabel={label("seek", "Playback position")}
              color="gray"
              size="sm"
            />
          </Box>
          <Group gap={6} wrap="nowrap" px="sm" py={8} c="gray.3">
            <ActionIcon
              variant="subtle"
              color="gray"
              disabled={!state?.ready}
              onClick={toggle}
              aria-label={
                state?.playing ? label("pause", "Pause") : label("play", "Play")
              }
            >
              {state?.playing ? (
                <TbPlayerPauseFilled />
              ) : (
                <TbPlayerPlayFilled />
              )}
            </ActionIcon>
            <Text size="xs" style={{ fontVariantNumeric: "tabular-nums" }}>
              {formatTime(current)} / {formatTime(duration)}
            </Text>
            <Box style={{ flex: 1 }} />
            {audioTrack && (
              <Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  onClick={toggleMute}
                  aria-label={
                    muted ? label("unmute", "Unmute") : label("mute", "Mute")
                  }
                >
                  {muted || volume === 0 ? <TbVolume3 /> : <TbVolume />}
                </ActionIcon>
                <Slider
                  style={{ width: 80, flexShrink: 0 }}
                  min={0}
                  max={1}
                  step={0.05}
                  value={muted ? 0 : volume}
                  onChange={changeVolume}
                  label={(value) => `${Math.round(value * 100)}%`}
                  thumbLabel={label("volume", "Volume")}
                  color="gray"
                  size="sm"
                />
              </Group>
            )}
            {
              <ActionIcon
                variant="subtle"
                color="gray"
                onClick={toggleFullscreen}
                aria-label={
                  fullscreen
                    ? label("exit-fullscreen", "Exit full screen")
                    : label("fullscreen", "Full screen")
                }
              >
                {fullscreen ? <TbMinimize /> : <TbMaximize />}
              </ActionIcon>
            }
          </Group>
        </Box>
      )}
    </PreviewFullscreen>
  );
}
