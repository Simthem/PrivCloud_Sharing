/**
 * Geometry and scaling behind the administration usage chart.
 *
 * The component owns the rendering; everything that can be reasoned about
 * without a DOM lives here so it stays testable.
 */

export type UsageMetricKey = "users" | "shares" | "views" | "storage";

export type ChartPoint = {
  value: number | null;
  /** The value was rebuilt from surviving creation records, not recorded. */
  estimated: boolean;
};

export type PathSegment = {
  d: string;
  estimated: boolean;
};

const NICE_STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 7.5, 8, 10];

/**
 * Round a value up to the next readable step. The ladder is deliberately fine:
 * a coarse one leaves a curve sitting in the bottom third of its own axis.
 * A flat-zero series still gets a height of 1 so its line has somewhere to sit.
 */
export function niceCeiling(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;

  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  const normalized = value / magnitude;
  const step =
    NICE_STEPS.find((candidate) => normalized <= candidate) ??
    NICE_STEPS[NICE_STEPS.length - 1];

  return step * magnitude;
}

/**
 * Axis maximum for a series, derived from the tick spacing rather than the
 * other way round, so every gridline lands on a round value.
 *
 * `integral` series - users and shares - additionally get a whole-number step.
 * Without it a platform with three users draws an axis labelled 1, 1, 1, 0, 0:
 * the ticks are real, they are just unreadable once rounded for display.
 */
export function axisMaximum(
  rawMax: number,
  divisions: number,
  integral: boolean,
): number {
  const step = niceCeiling(rawMax / divisions);

  return (integral ? Math.max(1, Math.ceil(step)) : step) * divisions;
}

/**
 * Turn a series into SVG paths, cutting paths at missing values and whenever
 * the evidence changes between recorded and rebuilt data.
 *
 * Two things break a run apart. A missing value opens a real gap: the chart
 * must not draw a line through days it knows nothing about. A change of
 * `estimated` starts a new path so the rebuilt part of the curve can be dashed.
 * The short joining segment is always dashed when either endpoint is rebuilt;
 * otherwise a recorded-to-rebuilt transition would briefly look authoritative.
 */
export function buildPathSegments(
  points: ChartPoint[],
  x: (_index: number) => number,
  y: (_value: number) => number,
): PathSegment[] {
  const segments: PathSegment[] = [];
  let current: string[] = [];
  let currentEstimated = false;

  const flush = () => {
    // A single point draws nothing as a path; the component renders those as
    // standalone dots so an isolated day stays visible.
    if (current.length > 1) {
      segments.push({ d: current.join(" "), estimated: currentEstimated });
    }
    current = [];
  };

  points.forEach((point, index) => {
    if (point.value === null) {
      flush();
      return;
    }

    const coordinates = `${x(index).toFixed(2)} ${y(point.value).toFixed(2)}`;
    const command = `${current.length === 0 ? "M" : "L"} ${coordinates}`;

    if (current.length === 0) {
      currentEstimated = point.estimated;
      current.push(command);
      return;
    }

    if (point.estimated !== currentEstimated) {
      const previousCoordinates = current[current.length - 1].replace(
        /^[ML] /,
        "",
      );
      flush();
      segments.push({
        d: `M ${previousCoordinates} L ${coordinates}`,
        estimated: true,
      });
      current.push(`M ${coordinates}`);
      currentEstimated = point.estimated;
      return;
    }

    current.push(command);
  });

  flush();
  return segments;
}

/** Days that carry a value but no neighbour to connect to. */
export function isolatedPointIndexes(points: ChartPoint[]): number[] {
  return points.reduce<number[]>((isolated, point, index) => {
    if (point.value === null) return isolated;

    const hasNeighbour =
      points[index - 1]?.value != null || points[index + 1]?.value != null;

    if (!hasNeighbour) isolated.push(index);
    return isolated;
  }, []);
}

/**
 * Close the area under a line so a single-series chart can be filled like the
 * rest of the interface. Returns null when the run is too short to enclose.
 */
export function closeAreaPath(
  segment: PathSegment,
  baselineY: number,
): string | null {
  const commands = segment.d.split(" L ");
  if (commands.length < 2) return null;

  const first = commands[0].replace("M ", "").split(" ");
  const last = commands[commands.length - 1].split(" ");

  return `${segment.d} L ${last[0]} ${baselineY.toFixed(2)} L ${first[0]} ${baselineY.toFixed(
    2,
  )} Z`;
}

/** Evenly spread at most `desired` tick positions over `count` slots. */
export function pickTickIndexes(count: number, desired: number): number[] {
  if (count <= 0) return [];
  if (count <= desired) {
    return Array.from({ length: count }, (_, index) => index);
  }

  const step = (count - 1) / (desired - 1);
  const indexes = Array.from({ length: desired }, (_, index) =>
    Math.round(index * step),
  );

  return Array.from(new Set(indexes));
}

/** Index of the day under a pointer at `offsetX` inside the plotting area. */
export function nearestIndex(
  offsetX: number,
  plotLeft: number,
  plotWidth: number,
  count: number,
): number {
  if (count <= 1) return 0;

  const ratio = (offsetX - plotLeft) / plotWidth;
  return Math.min(count - 1, Math.max(0, Math.round(ratio * (count - 1))));
}

/**
 * Byte totals travel as strings because they outgrow a double. Plotting needs a
 * number, and the precision lost past 2^53 bytes (9 PB) cannot move a pixel.
 */
export function toPlottableBytes(value: string | null): number | null {
  if (value === null) return null;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
