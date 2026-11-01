import type { MantineTransition } from "@mantine/core";

/**
 * Shared motion of the interface. Elements decelerate into place and leave a
 * little faster than they came, as on phones. Mantine skips its transitions
 * for users who ask their system for reduced motion (respectReducedMotion in
 * the theme), and global.style.tsx drops its CSS animations for them too.
 */
export const MOTION_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";

// Menus, selects and popovers grow out of the control that opened them. Their
// transform origin follows their placement (global.style.tsx).
const POPOVER_TRANSITION: MantineTransition = {
  in: { opacity: 1, transform: "scale(1)" },
  out: { opacity: 0, transform: "scale(0.96)" },
  transitionProperty: "opacity, transform",
};

// Dialogs rise slightly while they fade in.
const MODAL_TRANSITION: MantineTransition = {
  in: { opacity: 1, transform: "translateY(0) scale(1)" },
  out: { opacity: 0, transform: "translateY(12px) scale(0.98)" },
  transitionProperty: "opacity, transform",
};

export const POPOVER_TRANSITION_PROPS = {
  transition: POPOVER_TRANSITION,
  duration: 180,
  exitDuration: 120,
  timingFunction: MOTION_EASING,
};

export const MODAL_TRANSITION_PROPS = {
  transition: MODAL_TRANSITION,
  duration: 240,
  exitDuration: 160,
  timingFunction: MOTION_EASING,
};

// Drawers keep the slide Mantine picks from their side.
export const DRAWER_TRANSITION_PROPS = {
  duration: 280,
  exitDuration: 200,
  timingFunction: MOTION_EASING,
};

export const COLLAPSE_DURATION = 240;
