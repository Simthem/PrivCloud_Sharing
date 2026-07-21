export type TeamAuditLogInput = {
  action: string;
  actorEmail: string;
  fileName?: string | null;
  createdAt: Date;
};

export type TeamAuditAnomaly = {
  code: string;
  severity: "INFO" | "WARNING";
  description: string;
};

export type TeamAuditSummary = {
  totals: {
    events: number;
    uploads: number;
    downloads: number;
    e2eShares: number;
    deletions: number;
    permissionChanges: number;
    invitations: number;
    membersAdded: number;
    membersRemoved: number;
    keyRotations: number;
    guestLinksCreated: number;
    guestLinksRevoked: number;
  };
  topActors: Array<{ email: string; events: number }>;
  recentEvents: Array<{
    action: string;
    actorEmail: string;
    target: string | null;
    createdAt: string;
  }>;
  anomalies: TeamAuditAnomaly[];
  keyHealth: { current: number; pending: number; missing: number };
};

const ACTIONS = {
  uploads: new Set(["UPLOAD"]),
  downloads: new Set(["DOWNLOAD"]),
  e2eShares: new Set(["E2E_SHARE", "SHARE"]),
  deletions: new Set(["FILE_DELETE", "BULK_DELETE", "FOLDER_DELETE"]),
  permissionChanges: new Set([
    "ROLE_CHANGE",
    "PERMISSIONS_CHANGE",
    "FOLDER_ACCESS_CHANGE",
    "FILE_ACCESS_CHANGE",
  ]),
  invitations: new Set(["INVITE"]),
  membersAdded: new Set(["MEMBER_JOIN"]),
  membersRemoved: new Set(["MEMBER_REMOVE"]),
  keyRotations: new Set(["KEY_ROTATED"]),
  guestLinksCreated: new Set(["GUEST_LINK_CREATE"]),
  guestLinksRevoked: new Set(["GUEST_LINK_REVOKE"]),
} as const;

const countActions = (logs: TeamAuditLogInput[], actions: Set<string>) =>
  logs.reduce((count, log) => count + (actions.has(log.action) ? 1 : 0), 0);

export function buildTeamAuditSummary(
  logs: TeamAuditLogInput[],
  keyHealth: TeamAuditSummary["keyHealth"],
): TeamAuditSummary {
  const actors = new Map<string, number>();
  const downloads = new Map<string, number>();
  const permissionChanges = new Map<string, number>();

  for (const log of logs) {
    const actor = log.actorEmail || "unknown";
    actors.set(actor, (actors.get(actor) || 0) + 1);
    if (log.action === "DOWNLOAD") {
      downloads.set(actor, (downloads.get(actor) || 0) + 1);
    }
    if (ACTIONS.permissionChanges.has(log.action)) {
      permissionChanges.set(actor, (permissionChanges.get(actor) || 0) + 1);
    }
  }

  const anomalies: TeamAuditAnomaly[] = [];
  for (const [email, count] of downloads) {
    if (count >= 50) {
      anomalies.push({
        code: "DOWNLOAD_BURST",
        severity: "WARNING",
        description: `${count} téléchargements par ${email} sur la période`,
      });
    }
  }
  for (const [email, count] of permissionChanges) {
    if (count >= 10) {
      anomalies.push({
        code: "PERMISSION_CHURN",
        severity: "WARNING",
        description: `${count} changements de droits par ${email} sur la période`,
      });
    }
  }

  const anonymousDownloads = downloads.get("anonymous") || 0;
  if (anonymousDownloads >= 10) {
    anomalies.push({
      code: "ANONYMOUS_DOWNLOADS",
      severity: "WARNING",
      description: `${anonymousDownloads} téléchargements anonymes sur la période`,
    });
  }
  if (logs.some((log) => log.action === "BULK_DELETE")) {
    anomalies.push({
      code: "BULK_DELETE",
      severity: "INFO",
      description: "Une suppression groupée a été effectuée sur la période",
    });
  }
  if (keyHealth.pending > 0 || keyHealth.missing > 0) {
    anomalies.push({
      code: "TEAM_KEY_INCOMPLETE",
      severity: "WARNING",
      description: `${keyHealth.pending} clé(s) en attente et ${keyHealth.missing} clé(s) manquante(s)`,
    });
  }

  return {
    totals: {
      events: logs.length,
      uploads: countActions(logs, ACTIONS.uploads),
      downloads: countActions(logs, ACTIONS.downloads),
      e2eShares: countActions(logs, ACTIONS.e2eShares),
      deletions: countActions(logs, ACTIONS.deletions),
      permissionChanges: countActions(logs, ACTIONS.permissionChanges),
      invitations: countActions(logs, ACTIONS.invitations),
      membersAdded: countActions(logs, ACTIONS.membersAdded),
      membersRemoved: countActions(logs, ACTIONS.membersRemoved),
      keyRotations: countActions(logs, ACTIONS.keyRotations),
      guestLinksCreated: countActions(logs, ACTIONS.guestLinksCreated),
      guestLinksRevoked: countActions(logs, ACTIONS.guestLinksRevoked),
    },
    topActors: [...actors.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([email, events]) => ({ email, events })),
    recentEvents: [...logs]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 20)
      .map((log) => ({
        action: log.action,
        actorEmail: log.actorEmail,
        target: log.fileName || null,
        createdAt: log.createdAt.toISOString(),
      })),
    anomalies,
    keyHealth,
  };
}

export function getScheduledAuditWindow(
  frequency: string,
  now = new Date(),
): { start: Date; end: Date } | null {
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );

  if (frequency === "DAILY") {
    return { start: new Date(end.getTime() - 86_400_000), end };
  }
  if (frequency === "WEEKLY") {
    if (now.getUTCDay() !== 1) return null;
    return { start: new Date(end.getTime() - 7 * 86_400_000), end };
  }
  if (frequency === "MONTHLY") {
    if (now.getUTCDate() !== 1) return null;
    return {
      start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)),
      end,
    };
  }
  return null;
}
