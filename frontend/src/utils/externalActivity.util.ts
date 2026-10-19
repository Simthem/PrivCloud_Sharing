// Team activity entries written for external contractors (see the
// teamExternal backend module), labelled in the activity tab.
const EXTERNAL_ACTIVITY_KEYS: Record<string, string> = {
  EXTERNAL_INVITE: "team.dashboard.activity.externalInvite",
  EXTERNAL_JOIN: "team.dashboard.activity.externalJoin",
  EXTERNAL_REVOKE: "team.dashboard.activity.externalRevoke",
  EXTERNAL_PREVIEW_SHARE: "team.dashboard.activity.externalPreviewShare",
  EXTERNAL_PREVIEW_VIEW: "team.dashboard.activity.externalPreviewView",
  EXTERNAL_PREVIEW_DELETE: "team.dashboard.activity.externalPreviewDelete",
};

export function externalActivityLabel(
  action: string,
  t: (_id: string) => string,
): string {
  const key = EXTERNAL_ACTIVITY_KEYS[action];
  return key ? t(key) : action;
}
