import type User from "../types/user.type";

export type UserRow =
  | { key: string; heading: string | null; count: number }
  | { key: string; user: User; role?: string; indented: boolean };

const ROLES = ["OWNER", "ADMIN", "MEMBER"];

const rank = (role: string) =>
  ROLES.includes(role) ? ROLES.indexOf(role) : ROLES.length;

/** Members follow the owner of their team, accounts without a team come last. */
export function groupUsersByTeam(users: User[]): UserRow[] {
  const teams = new Map<
    string,
    { name: string; members: { user: User; role: string }[] }
  >();
  const alone: User[] = [];
  for (const user of users) {
    if (!user.teams?.length) {
      alone.push(user);
      continue;
    }
    for (const { id, name, role } of user.teams) {
      const key = id ?? name;
      const team = teams.get(key) ?? { name, members: [] };
      team.members.push({ user, role });
      teams.set(key, team);
    }
  }

  const rows: UserRow[] = [];
  const sorted = [...teams].sort(([, a], [, b]) =>
    a.name.localeCompare(b.name, undefined, {
      sensitivity: "base",
      numeric: true,
    }),
  );
  for (const [id, { name, members }] of sorted) {
    rows.push({ key: `team:${id}`, heading: name, count: members.length });
    members.sort((a, b) => rank(a.role) - rank(b.role));
    for (const { user, role } of members) {
      rows.push({
        key: `${id}:${user.id}`,
        user,
        role,
        indented: role !== "OWNER",
      });
    }
  }
  if (alone.length && teams.size) {
    rows.push({ key: "alone", heading: null, count: alone.length });
  }
  for (const user of alone) {
    rows.push({ key: user.id, user, indented: false });
  }
  return rows;
}
