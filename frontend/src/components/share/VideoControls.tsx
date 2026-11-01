import {
  ActionIcon,
  Box,
  Center,
  Group,
  Loader,
  Menu,
  Slider,
  Text,
  UnstyledButton,
} from "@mantine/core";
import { useEffect, useState, type ReactNode } from "react";
import {
  TbMaximize,
  TbMinimize,
  TbPictureInPicture,
  TbPlayerPauseFilled,
  TbPlayerPlayFilled,
  TbVolume,
  TbVolume3,
} from "react-icons/tb";
import { useIntl } from "react-intl";

import PreviewFullscreen from "./PreviewFullscreen";

const SEEK_STEP_SECONDS = 5;
const VOLUME_STEP = 0.1;
export const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

export const formatTime = (seconds: number) => {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, "0");
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}`
    : `${minutes}:${rest}`;
};

/** What the controls show, whichever player is behind them. */
export type PlayerState = {
  ready: boolean;
  playing: boolean;
  /** Playback waits for data or pictures. */
  busy: boolean;
  currentTime: number;
  duration: number;
  /** End of the data ready to play from the current position. */
  bufferedEnd: number;
  hasAudio: boolean;
  volume: number;
  muted: boolean;
  rate: number;
};

export type PlayerActions = {
  toggle: () => void;
  seek: (_time: number) => void;
  /** From the player's own position: repeated keys add up. */
  seekBy: (_seconds: number) => void;
  setVolume: (_volume: number) => void;
  toggleMute: () => void;
  setRate: (_rate: number) => void;
  /** Only for players the browser can show picture in picture. */
  pictureInPicture?: () => void;
};

const bufferedEndOf = (video: HTMLVideoElement) => {
  const { buffered, currentTime } = video;
  for (let i = 0; i < buffered.length; i++)
    if (
      buffered.start(i) <= currentTime + 0.5 &&
      buffered.end(i) >= currentTime
    )
      return buffered.end(i);
  return currentTime;
};

const stateOf = (video: HTMLVideoElement): PlayerState => ({
  ready: video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA,
  playing: !video.paused && !video.ended,
  busy:
    video.seeking ||
    (!video.paused &&
      !video.ended &&
      video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA),
  currentTime: video.currentTime,
  duration: Number.isFinite(video.duration) ? video.duration : 0,
  bufferedEnd: bufferedEndOf(video),
  hasAudio: true,
  volume: video.volume,
  muted: video.muted,
  rate: video.playbackRate,
});

const VIDEO_EVENTS = [
  "loadedmetadata",
  "loadeddata",
  "durationchange",
  "timeupdate",
  "progress",
  "play",
  "pause",
  "playing",
  "waiting",
  "seeking",
  "seeked",
  "ended",
  "volumechange",
  "ratechange",
  "canplay",
];

/** State and actions of a browser video element, for the controls below. */
export function useVideoElementPlayer(video: HTMLVideoElement | null) {
  const [state, setState] = useState<PlayerState | null>(null);
  useEffect(() => {
    if (!video) return;
    const update = () => setState(stateOf(video));
    for (const name of VIDEO_EVENTS) video.addEventListener(name, update);
    update();
    return () => {
      for (const name of VIDEO_EVENTS) video.removeEventListener(name, update);
    };
  }, [video]);
  const actions: PlayerActions = {
    toggle: () => {
      if (!video) return;
      if (video.paused || video.ended) void video.play().catch(() => undefined);
      else video.pause();
    },
    seek: (time) => {
      if (video && Number.isFinite(time))
        video.currentTime = Math.min(Math.max(0, time), video.duration || 0);
    },
    seekBy: (seconds) => {
      if (video)
        video.currentTime = Math.min(
          Math.max(0, video.currentTime + seconds),
          video.duration || 0,
        );
    },
    setVolume: (volume) => {
      if (!video) return;
      video.volume = volume;
      video.muted = volume === 0;
    },
    toggleMute: () => {
      if (!video) return;
      video.muted = !video.muted;
      if (!video.muted && video.volume === 0) video.volume = 1;
    },
    setRate: (rate) => {
      if (!video) return;
      video.playbackRate = rate;
      video.defaultPlaybackRate = rate;
    },
    pictureInPicture:
      typeof document !== "undefined" &&
      document.pictureInPictureEnabled &&
      video &&
      !video.disablePictureInPicture
        ? () => {
            if (document.pictureInPictureElement === video)
              void document.exitPictureInPicture().catch(() => undefined);
            else void video.requestPictureInPicture().catch(() => undefined);
          }
        : undefined,
  };
  return { state, actions };
}

/**
 * The same controls for every video preview, whichever way it is decoded:
 * position, volume, playback speed, picture in picture and full screen, with
 * the usual keyboard shortcuts.
 */
export default function VideoControls({
  state,
  actions,
  children,
}: {
  state: PlayerState | null;
  actions: PlayerActions;
  /** The picture: a video element or a canvas, sized by its maximum height. */
  children: (_maxHeight: string) => ReactNode;
}) {
  const intl = useIntl();
  const [scrub, setScrub] = useState<number | null>(null);
  const label = (id: string, defaultMessage: string) =>
    intl.formatMessage({
      id: `share.modal.file-preview.video.${id}`,
      defaultMessage,
    });
  const ready = !!state?.ready;
  const duration = state?.duration || 0;
  const current = scrub ?? state?.currentTime ?? 0;
  const volume = state?.muted ? 0 : (state?.volume ?? 1);

  return (
    <PreviewFullscreen>
      {({ fullscreen, toggleFullscreen }) => (
        <Box
          tabIndex={0}
          onKeyDown={(event) => {
            if (
              event.target instanceof Element &&
              event.target.closest("button, input, [role=slider], [role=menu]")
            )
              return;
            if (event.key === " " || event.key === "k") actions.toggle();
            else if (event.key === "ArrowLeft")
              actions.seekBy(-SEEK_STEP_SECONDS);
            else if (event.key === "ArrowRight")
              actions.seekBy(SEEK_STEP_SECONDS);
            else if (event.key === "ArrowUp")
              actions.setVolume(Math.min(1, volume + VOLUME_STEP));
            else if (event.key === "ArrowDown")
              actions.setVolume(Math.max(0, volume - VOLUME_STEP));
            else if (event.key === "m") actions.toggleMute();
            else if (event.key === "f") toggleFullscreen();
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
            onClick={() => ready && actions.toggle()}
            onDoubleClick={toggleFullscreen}
            style={{
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              minHeight: 200,
              flex: fullscreen ? 1 : undefined,
              cursor: ready ? "pointer" : "default",
            }}
          >
            {children(fullscreen ? "calc(100dvh - 90px)" : "65vh")}
            {(!ready || state?.busy) && (
              <Center
                pos="absolute"
                inset={0}
                style={{ pointerEvents: "none" }}
              >
                <Loader color="gray" />
              </Center>
            )}
          </Box>
          <Box px="sm" pt={8} pos="relative">
            {duration > 0 && (
              // What is ready to play, under the position slider.
              <Box
                pos="absolute"
                top={8}
                left="var(--mantine-spacing-sm)"
                h={4}
                bg="gray.7"
                style={{
                  marginTop: 4,
                  borderRadius: 2,
                  width: `calc((100% - 2 * var(--mantine-spacing-sm)) * ${Math.min(1, (state?.bufferedEnd ?? 0) / duration)})`,
                  pointerEvents: "none",
                }}
              />
            )}
            <Slider
              min={0}
              max={duration || 1}
              step={0.1}
              value={Math.min(current, duration || 1)}
              disabled={!ready || !duration}
              label={formatTime}
              onChange={setScrub}
              onChangeEnd={(value) => {
                actions.seek(value);
                setScrub(null);
              }}
              thumbLabel={label("seek", "Playback position")}
              color="gray"
              size="sm"
              styles={{ track: { background: "transparent" } }}
            />
          </Box>
          <Group gap={6} wrap="nowrap" px="sm" py={8} c="gray.3">
            <ActionIcon
              variant="subtle"
              color="gray"
              disabled={!ready}
              onClick={actions.toggle}
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
            {state?.hasAudio !== false && (
              <Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  onClick={actions.toggleMute}
                  aria-label={
                    state?.muted
                      ? label("unmute", "Unmute")
                      : label("mute", "Mute")
                  }
                >
                  {volume === 0 ? <TbVolume3 /> : <TbVolume />}
                </ActionIcon>
                <Slider
                  style={{ width: 80, flexShrink: 0 }}
                  min={0}
                  max={1}
                  step={0.05}
                  value={volume}
                  onChange={actions.setVolume}
                  label={(value) => `${Math.round(value * 100)}%`}
                  thumbLabel={label("volume", "Volume")}
                  color="gray"
                  size="sm"
                />
              </Group>
            )}
            <Menu position="top-end" withinPortal={!fullscreen}>
              <Menu.Target>
                <UnstyledButton
                  aria-label={label("speed", "Playback speed")}
                  px={6}
                  style={{
                    color: "inherit",
                    fontSize: 12,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {`${state?.rate ?? 1}×`}
                </UnstyledButton>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>{label("speed", "Playback speed")}</Menu.Label>
                {PLAYBACK_RATES.map((rate) => (
                  <Menu.Item
                    key={rate}
                    onClick={() => actions.setRate(rate)}
                    fw={rate === (state?.rate ?? 1) ? 700 : undefined}
                  >
                    {`${rate}×`}
                  </Menu.Item>
                ))}
              </Menu.Dropdown>
            </Menu>
            {actions.pictureInPicture && (
              <ActionIcon
                variant="subtle"
                color="gray"
                disabled={!ready}
                onClick={actions.pictureInPicture}
                aria-label={label("picture-in-picture", "Picture in picture")}
              >
                <TbPictureInPicture />
              </ActionIcon>
            )}
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
          </Group>
        </Box>
      )}
    </PreviewFullscreen>
  );
}
