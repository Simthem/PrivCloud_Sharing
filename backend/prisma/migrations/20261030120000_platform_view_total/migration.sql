-- Platform view total for the administration statistics. It was the sum of
-- Share.views, which leaves with its share: a user deleting a share before
-- it expired took its views out of the chart.
--
-- Triggers add every view, so the total does not depend on the code that
-- counts it.
CREATE TABLE "PlatformViewTotal" (
    "id" INTEGER NOT NULL PRIMARY KEY DEFAULT 1 CHECK ("id" = 1),
    "views" INTEGER NOT NULL DEFAULT 0
);

-- Views of shares already deleted are gone from Share. The daily snapshots
-- still hold the largest total ever recorded, a floor the platform total
-- cannot be below, so the chart does not drop on upgrade.
INSERT INTO "PlatformViewTotal" ("id", "views")
SELECT 1, MAX(
    (SELECT COALESCE(SUM("views"), 0) FROM "Share"),
    (SELECT COALESCE(MAX("totalViews"), 0) FROM "UsageSnapshot")
);

CREATE TRIGGER "Share_views_platform_total_insert"
AFTER INSERT ON "Share"
WHEN NEW."views" > 0
BEGIN
  UPDATE "PlatformViewTotal"
  SET "views" = "views" + NEW."views"
  WHERE "id" = 1;
END;

CREATE TRIGGER "Share_views_platform_total_update"
AFTER UPDATE OF "views" ON "Share"
WHEN NEW."views" > OLD."views"
BEGIN
  UPDATE "PlatformViewTotal"
  SET "views" = "views" + (NEW."views" - OLD."views")
  WHERE "id" = 1;
END;
