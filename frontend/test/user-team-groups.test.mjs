import assert from "node:assert/strict";
import test from "node:test";
import { groupUsersByTeam } from "../src/utils/userTeamGroups.util.ts";

const user = (id, teams) => ({
  id,
  username: id,
  email: `${id}@example.test`,
  isAdmin: false,
  teams,
});
const team = (id, role, name = id) => ({ id, name, role });
const outline = (rows) =>
  rows.map((row) =>
    "user" in row
      ? `${row.indented ? "  " : ""}${row.user.id}`
      : `# ${row.heading ?? "-"} (${row.count})`,
  );

test("members are listed under the owner of their team", () => {
  const rows = groupUsersByTeam([
    user("solo"),
    user("mia", [team("zeta", "MEMBER")]),
    user("adam", [team("zeta", "ADMIN")]),
    user("olga", [team("zeta", "OWNER")]),
    user("otto", [team("alpha", "OWNER")]),
    user("lone", []),
  ]);
  assert.deepEqual(outline(rows), [
    "# alpha (1)",
    "otto",
    "# zeta (3)",
    "olga",
    "  adam",
    "  mia",
    "# - (2)",
    "solo",
    "lone",
  ]);
});

test("members of one role keep the order they came in", () => {
  const rows = groupUsersByTeam([
    user("m2", [team("t", "MEMBER")]),
    user("m1", [team("t", "MEMBER")]),
    user("own", [team("t", "OWNER")]),
  ]);
  assert.deepEqual(outline(rows), ["# t (3)", "own", "  m2", "  m1"]);
});

test("an account of several teams appears in each with its own row key", () => {
  const rows = groupUsersByTeam([
    user("ann", [team("a", "OWNER"), team("b", "MEMBER")]),
    user("ben", [team("b", "OWNER")]),
  ]);
  assert.deepEqual(outline(rows), [
    "# a (1)",
    "ann",
    "# b (2)",
    "ben",
    "  ann",
  ]);
  assert.equal(new Set(rows.map(({ key }) => key)).size, rows.length);
});

test("teams sharing a name stay apart, an older server groups by name", () => {
  const twins = groupUsersByTeam([
    user("x", [team("id-1", "OWNER", "Studio")]),
    user("y", [team("id-2", "OWNER", "Studio")]),
  ]);
  assert.deepEqual(outline(twins), ["# Studio (1)", "x", "# Studio (1)", "y"]);
  const legacy = groupUsersByTeam([
    user("x", [{ name: "Studio", role: "OWNER" }]),
    user("y", [{ name: "Studio", role: "MEMBER" }]),
  ]);
  assert.deepEqual(outline(legacy), ["# Studio (2)", "x", "  y"]);
});

test("a list without any team has no heading", () => {
  assert.deepEqual(outline(groupUsersByTeam([user("a"), user("b")])), [
    "a",
    "b",
  ]);
});
