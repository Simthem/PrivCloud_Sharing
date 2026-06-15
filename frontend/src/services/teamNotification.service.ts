/**
 * Team Notification Service - API calls for team notifications.
 */

import api from "./api.service";

export interface TeamNotification {
  id: string;
  type: string;
  title: string;
  isRead: boolean;
  createdAt: string;
  actorId?: string;
  metadata?: string;
  encryptedMetadata?: string;
  team?: { id: string; name: string; slug: string };
  teamFile?: { id: string; name: string };
  folder?: { id: string; name: string };
}

export interface NotificationResponse {
  notifications: TeamNotification[];
  total: number;
  unreadCount: number;
}

/**
 * Get team notifications for the current user.
 */
export const getTeamNotifications = async (opts?: {
  teamId?: string;
  unreadOnly?: boolean;
  limit?: number;
  offset?: number;
  signal?: AbortSignal;
}): Promise<NotificationResponse> => {
  const params = new URLSearchParams();
  if (opts?.teamId) params.set("teamId", opts.teamId);
  if (opts?.unreadOnly) params.set("unreadOnly", "true");
  if (opts?.limit) params.set("limit", String(opts.limit));
  if (opts?.offset) params.set("offset", String(opts.offset));
  const query = params.toString();
  return (
    await api.get(`team-notifications${query ? `?${query}` : ""}`, {
      signal: opts?.signal,
      timeout: 10000,
      headers: {
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
    })
  ).data;
};

/**
 * Get unread notification count (for badge).
 */
export const getUnreadNotificationCount = async (
  teamId?: string,
  signal?: AbortSignal,
): Promise<{ count: number }> => {
  const params = teamId ? `?teamId=${teamId}` : "";
  return (
    await api.get(`team-notifications/unread-count${params}`, {
      signal,
      timeout: 8000,
      headers: {
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
    })
  ).data;
};

/**
 * Mark a single notification as read.
 */
export const markNotificationRead = async (
  notificationId: string,
): Promise<void> => {
  await api.patch(`team-notifications/${notificationId}/read`);
};

/**
 * Mark all notifications as read.
 */
export const markAllNotificationsRead = async (
  teamId?: string,
): Promise<{ markedCount: number }> => {
  const params = teamId ? `?teamId=${teamId}` : "";
  return (await api.post(`team-notifications/mark-all-read${params}`)).data;
};

/**
 * Delete all notifications for the current user.
 */
export const deleteAllNotifications = async (
  teamId?: string,
): Promise<{ deletedCount: number }> => {
  const params = teamId ? `?teamId=${teamId}` : "";
  return (await api.delete(`team-notifications${params}`)).data;
};
