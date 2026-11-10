import teamService from "../services/team.service";
import type { CurrentUser } from "../types/user.type";
import {
  finalizePostAuthRedirectPath,
  getRememberedPostAuthRedirectPath,
  safeRedirectPath,
} from "./authRedirect.util";

export { safeRedirectPath } from "./authRedirect.util";

// A remembered target can only be read once, and the app shell, the homepage
// and the provider return all resolve the landing page at the same moment.
const SHARED_TARGET_WINDOW_MS = 5_000;
let sharedTarget: { path: string; until: number } | null = null;

export async function resolvePostAuthRedirectPath(
  path?: string | null,
  user?: CurrentUser | null,
) {
  if (path == null && sharedTarget && Date.now() < sharedTarget.until) {
    return sharedTarget.path;
  }
  const requestedPath = path ?? getRememberedPostAuthRedirectPath();
  const safePath = safeRedirectPath(requestedPath ?? undefined);
  const isDefaultDestination =
    !requestedPath || safePath === "/" || safePath === "/upload";

  if (!isDefaultDestination) {
    const target = finalizePostAuthRedirectPath(safePath);
    if (path == null) {
      sharedTarget = {
        path: target,
        until: Date.now() + SHARED_TARGET_WINDOW_MS,
      };
    }
    return target;
  }
  if (!user?.hasTeamMembership && !user?.teamId) {
    return finalizePostAuthRedirectPath(
      user?.hasExternalAccess ? "/external" : "/upload",
    );
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
