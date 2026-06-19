import teamService from "../services/team.service";
import type { CurrentUser } from "../types/user.type";

export function safeRedirectPath(path: string | undefined) {
  if (!path) return "/";

  // Block protocol-relative URLs (//evil.com) and absolute URLs
  if (/^\/\//.test(path) || /^https?:/i.test(path)) return "/";

  if (!path.startsWith("/")) return "/";

  return path;
}

export async function resolvePostAuthRedirectPath(
  path?: string | null,
  user?: CurrentUser | null,
) {
  const safePath = safeRedirectPath(path ?? undefined);
  const isDefaultDestination =
    !path || safePath === "/" || safePath === "/upload";

  if (!isDefaultDestination) return safePath;
  if (!user?.hasTeamMembership && !user?.teamId) return "/upload";

  try {
    const status = await teamService.getTeamStatus();
    if (status.ownedTeamId) return `/team/${status.ownedTeamId}`;
    if (status.teamId) return `/team/${status.teamId}`;
    if (status.teams.length === 1) return `/team/${status.teams[0].teamId}`;
    if (status.teams.length > 1) return "/team";
  } catch {
    // Fall back to the team id already returned by /users/me.
  }

  return user?.teamId ? `/team/${user.teamId}` : "/upload";
}
