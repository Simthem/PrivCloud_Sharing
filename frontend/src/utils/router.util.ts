import teamService from "../services/team.service";
import type { CurrentUser } from "../types/user.type";
import {
  finalizePostAuthRedirectPath,
  getRememberedPostAuthRedirectPath,
  safeRedirectPath,
} from "./authRedirect.util";

export { safeRedirectPath } from "./authRedirect.util";

export async function resolvePostAuthRedirectPath(
  path?: string | null,
  user?: CurrentUser | null,
) {
  const requestedPath = path ?? getRememberedPostAuthRedirectPath();
  const safePath = safeRedirectPath(requestedPath ?? undefined);
  const isDefaultDestination =
    !requestedPath || safePath === "/" || safePath === "/upload";

  if (!isDefaultDestination) return finalizePostAuthRedirectPath(safePath);
  if (!user?.hasTeamMembership && !user?.teamId) {
    return finalizePostAuthRedirectPath("/upload");
  }

  try {
    const status = await teamService.getTeamStatus();
    if (status.ownedTeamId) {
      return finalizePostAuthRedirectPath(`/team/${status.ownedTeamId}`);
    }
    if (status.teamId) {
      return finalizePostAuthRedirectPath(`/team/${status.teamId}`);
    }
    if (status.teams.length === 1) {
      return finalizePostAuthRedirectPath(`/team/${status.teams[0].teamId}`);
    }
    if (status.teams.length > 1) {
      return finalizePostAuthRedirectPath("/team");
    }
  } catch {
    // Fall back to the team id already returned by /users/me.
  }

  return finalizePostAuthRedirectPath(
    user?.teamId ? `/team/${user.teamId}` : "/upload",
  );
}
