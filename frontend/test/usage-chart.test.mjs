import assert from "node:assert/strict";
import test from "node:test";
import {
  axisMaximum,
  buildPathSegments,
  closeAreaPath,
  isolatedPointIndexes,
  nearestIndex,
  niceCeiling,
  pickTickIndexes,
  toPlottableBytes,
} from "../src/components/admin/stats/usageChart.util.ts";

const x = (index) => index * 10;
const y = (value) => 100 - value;

const point = (value, estimated = false) => ({ value, estimated });

test("rounds values up to readable steps", () => {
  assert.equal(niceCeiling(0), 1);
  assert.equal(niceCeiling(-5), 1);
  assert.equal(niceCeiling(1), 1);
  assert.equal(niceCeiling(2.4), 2.5);
  assert.equal(niceCeiling(4.25), 5);
  assert.equal(niceCeiling(0.25), 0.25);
  assert.equal(niceCeiling(1_200_000_000), 1_500_000_000);
});

test("gives counting axes whole, distinct gridlines", () => {
  // Every tick of an integral axis has to be a different whole number, or a
  // young platform draws an axis reading 1, 1, 1, 0, 0.
  for (const rawMax of [0, 1, 2, 3, 5, 9, 17, 42, 250, 1_000, 12_345]) {
    const max = axisMaximum(rawMax, 4, true);
    const ticks = [0, 1, 2, 3, 4].map((division) => (max / 4) * division);

    assert.ok(max >= rawMax, `${rawMax} must fit under its axis`);
    assert.ok(
      ticks.every(Number.isInteger),
      `${rawMax} produced fractional ticks: ${ticks}`,
    );
    assert.equal(new Set(ticks).size, ticks.length, `${rawMax} repeats a tick`);
    // The curve has to use its axis, not hide in the bottom of it.
    assert.ok(max <= Math.max(4, rawMax * 2), `${rawMax} wastes its axis`);
  }
});

test("fits a byte axis tightly without forcing whole steps", () => {
  assert.equal(axisMaximum(1_200_000_000, 4, false), 1_200_000_000);
  assert.equal(axisMaximum(0, 4, false), 4);
});

test("never draws a line through days without data", () => {
  const segments = buildPathSegments(
    [point(1), point(2), point(null), point(4), point(5)],
    x,
    y,
  );

  assert.equal(segments.length, 2);
  assert.equal(segments[0].d, "M 0.00 99.00 L 10.00 98.00");
  assert.equal(segments[1].d, "M 30.00 96.00 L 40.00 95.00");
});

test("splits rebuilt history into its own dashed path without leaving a hole", () => {
  const segments = buildPathSegments(
    [point(1, true), point(2, true), point(3), point(4)],
    x,
    y,
  );

  assert.deepEqual(
    segments.map((segment) => segment.estimated),
    [true, true, false],
  );
  assert.equal(segments[1].d, "M 10.00 98.00 L 20.00 97.00");
  assert.ok(segments[2].d.startsWith("M 20.00 97.00"));
});

test("dashes the weaker side of a recorded-to-rebuilt transition", () => {
  const segments = buildPathSegments(
    [point(1), point(2), point(3, true), point(4, true)],
    x,
    y,
  );

  assert.deepEqual(
    segments.map((segment) => segment.estimated),
    [false, true, true],
  );
  assert.equal(segments[1].d, "M 10.00 98.00 L 20.00 97.00");
});

test("reports days that have no neighbour to connect to", () => {
  assert.deepEqual(
    isolatedPointIndexes([point(1), point(null), point(3), point(null)]),
    [0, 2],
  );
  assert.deepEqual(isolatedPointIndexes([point(1), point(2)]), []);
  // A lone point produces no path, which is why it has to be reported.
  assert.equal(buildPathSegments([point(1)], x, y).length, 0);
});

test("closes an area only when the run encloses one", () => {
  const [segment] = buildPathSegments([point(1), point(2)], x, y);
  assert.equal(
    closeAreaPath(segment, 100),
    "M 0.00 99.00 L 10.00 98.00 L 10.00 100.00 L 0.00 100.00 Z",
  );
  assert.equal(closeAreaPath({ d: "M 0.00 99.00", estimated: false }, 100), null);
});

test("spreads date ticks and keeps both ends", () => {
  assert.deepEqual(pickTickIndexes(3, 7), [0, 1, 2]);
  assert.deepEqual(pickTickIndexes(0, 7), []);
  const ticks = pickTickIndexes(185, 7);
  assert.equal(ticks[0], 0);
  assert.equal(ticks[ticks.length - 1], 184);
  assert.equal(ticks.length, 7);
});

test("maps a pointer to the nearest day and stays inside the series", () => {
  assert.equal(nearestIndex(56, 56, 300, 101), 0);
  assert.equal(nearestIndex(356, 56, 300, 101), 100);
  assert.equal(nearestIndex(206, 56, 300, 101), 50);
  // Pointer events fire outside the plotting area too.
  assert.equal(nearestIndex(-999, 56, 300, 101), 0);
  assert.equal(nearestIndex(9_999, 56, 300, 101), 100);
  assert.equal(nearestIndex(120, 56, 300, 1), 0);
});

test("keeps byte totals plottable and rejects unusable ones", () => {
  assert.equal(toPlottableBytes(null), null);
  assert.equal(toPlottableBytes("0"), 0);
  assert.equal(toPlottableBytes("1500000000"), 1_500_000_000);
  assert.equal(toPlottableBytes("not-a-number"), null);
});
