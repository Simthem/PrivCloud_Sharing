import type { EmotionSx } from "@mantine/emotion";

// Augment Mantine component props to support the `sx` prop
// when using the @mantine/emotion emotionTransform in MantineProvider.
// Runtime support is provided by emotionTransform; this file adds types only.
declare module "@mantine/core" {
  // eslint-disable-next-line no-unused-vars
  interface BoxProps {
    sx?: EmotionSx | EmotionSx[];
  }
}
