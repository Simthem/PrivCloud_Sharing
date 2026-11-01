import "@mantine/core/styles/Menu.css";
import "@mantine/core/styles/Slider.css";
import { Center, Loader } from "@mantine/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { createProgressiveMediaUrl } from "../../utils/previewMedia.util";
import { fetchFilePreviewSource } from "../../services/share.service";
import {
  canUseMediaEngine,
  MediaEnginePlayback,
} from "../../utils/mediaEngine.util";
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

import VideoControls, {
  type PlayerActions,
  type PlayerState,
  useVideoElementPlayer,
} from "./VideoControls";

type Software = {
  track: Mp4VideoTrack;
  audioTrack: Mp4AudioTrack | null;
  source: PreviewByteSource;
};

/** What the preview shows, decided from the index of the file. */
type Plan =
  | { kind: "audio"; source: PreviewByteSource }
  | { kind: "software"; software: Software }
  /** Demuxed and, when needed, re-encoded on the device for MediaSource. */
  | { kind: "engine"; source: PreviewByteSource }
  | {
      kind: "native";
      source: PreviewByteSource;
      /** Taken over when the browser fails on a track it claimed to decode. */
      software: Software | null;
      /** Name of the indexed video codec, null when the file is no MP4. */
      codec: string | null;
    };

/**
 * The index names HEVC tracks fully and others by sample entry only: those
 * are asked about with a typical codec string, which every browser parses.
 */
const PROBE_CODECS: Record<string, string> = {
  avc1: "avc1.640028",
  avc3: "avc3.640028",
  mp4v: "mp4v.20.8",
  vp09: "vp09.00.40.08",
  av01: "av01.0.08M.08",
};

const browserDecodes = (codec: string) => {
  const type = `video/mp4; codecs="${PROBE_CODECS[codec] ?? codec}"`;
  return (
    (typeof MediaSource === "function" && MediaSource.isTypeSupported(type)) ||
    document.createElement("video").canPlayType(type) !== ""
  );
};

/**
 * Safari and the other WebKit browsers stall on media streamed by a service
 * worker (no picture, seeks that never end): MediaSource through the engine
 * plays there, by copying H.264 or HEVC without re-encoding them.
 */
const streamsThroughEngine = () =>
  /AppleWebKit/.test(navigator.userAgent) &&
  !/Chrome|Chromium|CriOS|Edg|Firefox|FxiOS/.test(navigator.userAgent);

/** Containers the browser plays by itself, tried before the engine. */
const browserContainer = (mimeType: string) =>
  (mimeType === "video/webm" || mimeType === "video/ogg") &&
  document.createElement("video").canPlayType(mimeType) !== "";

/**
 * Video preview. The index of an MP4 or QuickTime file is read first, which
 * costs a few small reads: an HEVC track the browser cannot decode is decoded
 * on the device, a file without pictures is played as sound, and the browser
 * player shows the rest. Every other format (AVI, Matroska, WMV, FLV, MPEG
 * streams, codecs the browser lacks...) goes through the media engine, which
 * hands the browser player a stream it can decode. Starting the browser
 * player on a track it cannot decode would download much of the file before
 * it gives up.
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
  const [plan, setPlan] = useState<Plan | null>(null);
  const [nativeMedia, setNativeMedia] = useState<string | null>(null);
  // Reads ahead of the browser player while it plays, none while paused.
  const playing = useRef<((_on: boolean) => void) | null>(null);
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
      const engine = canUseMediaEngine();
      const webkit = engine && streamsThroughEngine();
      const native = {
        kind: "native" as const,
        source: opened,
        software: null,
        codec: null,
      };
      // Not an MP4 or QuickTime file: the engine reads every other container.
      if (!index)
        return setPlan(
          engine && (webkit || !browserContainer(mimeType))
            ? { kind: "engine", source: opened }
            : native,
        );
      if (!index.video) return setPlan({ kind: "audio", source: opened });
      if (webkit) return setPlan({ kind: "engine", source: opened });
      const software =
        HEVC_FORMATS.has(index.video.format) && canDecodeVideoInSoftware()
          ? { track: index.video, audioTrack: index.audio, source: opened }
          : null;
      const decodes = browserDecodes(index.video.codec);
      if (software && !decodes) return setPlan({ kind: "software", software });
      // Pictures or sound (PCM, AC-3...) the browser player would not play.
      if (engine && (!decodes || (index.hasAudio && !index.audio)))
        return setPlan({ kind: "engine", source: opened });
      setPlan({
        ...native,
        software,
        codec: videoCodecName(index.video.format),
      });
    })().catch(() => {
      if (!signal.aborted) unsupported.current(null);
    });
    return () => controller.abort();
  }, [shareId, fileId, e2eKey, source, mimeType]);

  const browserSource =
    plan?.kind === "native" || plan?.kind === "audio" ? plan.source : null;
  useEffect(() => {
    if (!browserSource) return;
    const controller = new AbortController();
    let release: (() => void) | undefined;
    setNativeMedia(null);
    createProgressiveMediaUrl(browserSource, mimeType, controller.signal)
      .then((media) => {
        release = media.release;
        if (controller.signal.aborted) release();
        else {
          playing.current = media.playing;
          setNativeMedia(media.url);
        }
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
      playing.current = null;
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

  if (
    !plan ||
    ((plan.kind === "native" || plan.kind === "audio") && !nativeMedia)
  )
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
          onPlay={() => playing.current?.(true)}
          onPause={() => playing.current?.(false)}
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
  if (plan.kind === "engine")
    return (
      <EngineVideoPlayer
        source={plan.source}
        mimeType={mimeType}
        onError={() => unsupported.current(null)}
      />
    );
  const undecodable = () => {
    if (plan.software) setPlan({ kind: "software", software: plan.software });
    else if (canUseMediaEngine())
      setPlan({ kind: "engine", source: plan.source });
    else unsupported.current(plan.codec);
  };
  return (
    <VideoElementPlayer
      src={nativeMedia!}
      onPlaying={(on) => playing.current?.(on)}
      onLoadedMetadata={(video) => {
        // Sound without pictures: the browser skipped a video track it cannot
        // decode (Theora in Chrome, HEVC...).
        if (!video.videoWidth) undecodable();
      }}
      onError={(code) => {
        if (
          code === MediaError.MEDIA_ERR_DECODE ||
          code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
        )
          undecodable();
        else unsupported.current(null);
      }}
    />
  );
}

/** A browser video element under the shared controls. */
function VideoElementPlayer({
  src,
  onVideo,
  onPlaying,
  onLoadedMetadata,
  onError,
}: {
  src?: string;
  onVideo?: (_video: HTMLVideoElement | null) => void;
  onPlaying?: (_on: boolean) => void;
  onLoadedMetadata?: (_video: HTMLVideoElement) => void;
  onError?: (_code: number | undefined) => void;
}) {
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const { state, actions } = useVideoElementPlayer(video);
  const attach = useCallback(
    (element: HTMLVideoElement | null) => {
      setVideo(element);
      onVideo?.(element);
    },
    [onVideo],
  );
  return (
    <VideoControls state={state} actions={actions}>
      {(maxHeight) => (
        <video
          ref={attach}
          src={src}
          width="100%"
          playsInline
          preload="metadata"
          style={{
            display: "block",
            maxHeight,
            minHeight: 0,
            objectFit: "contain",
          }}
          onPlay={() => onPlaying?.(true)}
          onPause={() => onPlaying?.(false)}
          onLoadedMetadata={(event) => onLoadedMetadata?.(event.currentTarget)}
          onError={(event) => onError?.(event.currentTarget.error?.code)}
        />
      )}
    </VideoControls>
  );
}

/** Formats and codecs the browser lacks, through the media engine. */
function EngineVideoPlayer({
  source,
  mimeType,
  onError,
}: {
  source: PreviewByteSource;
  mimeType: string;
  onError: () => void;
}) {
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const failed = useRef(onError);
  failed.current = onError;
  useEffect(() => {
    if (!video) return;
    let playback: MediaEnginePlayback;
    try {
      playback = new MediaEnginePlayback(video, source, mimeType, () =>
        failed.current(),
      );
    } catch {
      failed.current();
      return;
    }
    return () => playback.destroy();
  }, [video, source, mimeType]);
  return <VideoElementPlayer onVideo={setVideo} />;
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
  const canvas = useRef<HTMLCanvasElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const player = useRef<SoftwareVideoPlayback | null>(null);
  const failed = useRef(onError);
  failed.current = onError;
  const [playback, setPlayback] = useState<SoftwarePlaybackState | null>(null);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [rate, setRate] = useState(1);

  useEffect(() => {
    if (!canvas.current) return;
    let created: SoftwareVideoPlayback;
    try {
      created = new SoftwareVideoPlayback({
        track,
        audioTrack,
        read: (start, end, signal) =>
          readPreviewBytes(source, start, end, signal),
        size: source.size,
        canvas: canvas.current,
        audio: audio.current,
        onChange: setPlayback,
        onError: () => failed.current(),
      });
    } catch {
      failed.current();
      return;
    }
    player.current = created;
    return () => {
      created.destroy();
      player.current = null;
    };
  }, [track, audioTrack, source]);

  const state: PlayerState | null = playback && {
    ready: playback.ready,
    playing: playback.playing,
    busy: playback.waiting && playback.playing,
    currentTime: playback.currentTime,
    duration: playback.duration,
    bufferedEnd: playback.currentTime,
    hasAudio: !!audioTrack,
    volume,
    muted,
    rate,
  };
  const actions: PlayerActions = {
    toggle: () => {
      if (!player.current || !playback) return;
      if (playback.playing) player.current.pause();
      else player.current.play();
    },
    seek: (time) => player.current?.seek(time),
    seekBy: (seconds) => {
      if (player.current)
        player.current.seek(player.current.currentTime + seconds);
    },
    setVolume: (value) => {
      if (!audio.current) return;
      audio.current.volume = value;
      audio.current.muted = value === 0;
    },
    toggleMute: () => {
      if (!audio.current) return;
      audio.current.muted = !audio.current.muted;
      if (!audio.current.muted && audio.current.volume === 0)
        audio.current.volume = 1;
    },
    setRate: (value) => {
      player.current?.setPlaybackRate(value);
      setRate(value);
    },
  };

  return (
    <>
      <VideoControls state={state} actions={actions}>
        {(maxHeight) => (
          <canvas
            ref={canvas}
            // Sized like the browser video element: full width, picture
            // contained within the height limit.
            style={{
              display: "block",
              width: "100%",
              height: "auto",
              maxHeight,
              objectFit: "contain",
            }}
          />
        )}
      </VideoControls>
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
    </>
  );
}
