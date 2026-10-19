import type { QueryClient } from "@tanstack/react-query";
import type { PendingUpload } from "../types/share.type";
import { getAllTeamFolderContentQueryKeys } from "./teamQuery.util";

/** Remove the acknowledged upload before a slow, older listing can reappear. */
export async function synchronizeCompletedUpload(
  queryClient: QueryClient,
  shareId: string,
): Promise<void> {
  await queryClient.cancelQueries({ queryKey: ["pendingUploads"] });
  queryClient.setQueriesData<PendingUpload[]>(
    { queryKey: ["pendingUploads"] },
    (uploads) => uploads?.filter((upload) => upload.id !== shareId),
  );
  // Refresh listings in the background. Their response time must not delay
  // acknowledgement of a share already durably completed by the server.
  // A native completion only knows the share id, so every team's folder views
  // are marked stale: the ones on screen refetch, the others on their next
  // mount instead of serving the cached count for the rest of their staleTime.
  void Promise.all([
    queryClient.invalidateQueries({ queryKey: ["pendingUploads"] }),
    queryClient.invalidateQueries({ queryKey: ["myShares"] }),
    queryClient.invalidateQueries({ queryKey: ["share", shareId] }),
    ...getAllTeamFolderContentQueryKeys().map((queryKey) =>
      queryClient.invalidateQueries({ queryKey }),
    ),
  ]).catch(() => {
    // Invalidated queries retry through their normal observers on the next read.
  });
}

/** Reconcile only after the owner DELETE endpoint acknowledges removal. */
export async function synchronizeRemovedShare(
  queryClient: QueryClient,
  shareId: string,
): Promise<void> {
  await Promise.all([
    queryClient.cancelQueries({ queryKey: ["share", shareId] }),
    queryClient.cancelQueries({ queryKey: ["myShares"] }),
  ]);
  queryClient.removeQueries({ queryKey: ["share", shareId] });
  queryClient.setQueriesData<Array<{ id: string }>>(
    { queryKey: ["myShares"] },
    (shares) => shares?.filter((share) => share.id !== shareId),
  );
  await synchronizeCompletedUpload(queryClient, shareId);
}
