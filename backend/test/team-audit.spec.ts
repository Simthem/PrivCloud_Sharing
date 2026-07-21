import "reflect-metadata";
import assert from "node:assert/strict";
import {
  buildTeamAuditSummary,
  getScheduledAuditWindow,
} from "src/team/team-audit.util";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("team audit");

testCase("creates deterministic weekly and monthly reporting windows", () => {
  const weekly = getScheduledAuditWindow(
    "WEEKLY",
    new Date("2026-07-13T07:15:00.000Z"),
  );
  assert.equal(weekly?.start.toISOString(), "2026-07-06T00:00:00.000Z");
  assert.equal(weekly?.end.toISOString(), "2026-07-13T00:00:00.000Z");
  assert.equal(
    getScheduledAuditWindow("WEEKLY", new Date("2026-07-14T07:15:00.000Z")),
    null,
  );

  const monthly = getScheduledAuditWindow(
    "MONTHLY",
    new Date("2026-08-01T07:15:00.000Z"),
  );
  assert.equal(monthly?.start.toISOString(), "2026-07-01T00:00:00.000Z");
  assert.equal(monthly?.end.toISOString(), "2026-08-01T00:00:00.000Z");
});

testCase("summarizes compliance events and flags actionable anomalies", () => {
  const createdAt = new Date("2026-07-12T10:00:00.000Z");
  const logs = [
    { action: "UPLOAD", actorEmail: "alice@example.com", createdAt },
    { action: "E2E_SHARE", actorEmail: "alice@example.com", createdAt },
    { action: "BULK_DELETE", actorEmail: "admin@example.com", createdAt },
    ...Array.from({ length: 50 }, () => ({
      action: "DOWNLOAD",
      actorEmail: "alice@example.com",
      createdAt,
    })),
  ];

  const summary = buildTeamAuditSummary(logs, {
    current: 2,
    pending: 1,
    missing: 1,
  });

  assert.equal(summary.totals.uploads, 1);
  assert.equal(summary.totals.downloads, 50);
  assert.equal(summary.totals.e2eShares, 1);
  assert.equal(summary.totals.deletions, 1);
  assert.equal(summary.topActors[0].email, "alice@example.com");
  assert.equal(summary.anomalies.some((item) => item.code === "DOWNLOAD_BURST"), true);
  assert.equal(summary.anomalies.some((item) => item.code === "BULK_DELETE"), true);
  assert.equal(summary.anomalies.some((item) => item.code === "TEAM_KEY_INCOMPLETE"), true);
});

void run();
