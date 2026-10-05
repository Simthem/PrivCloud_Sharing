import type { QueryClient } from "@tanstack/react-query";
import type { PendingUpload } from "../types/share.type";

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
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["pendingUploads"] }),
    queryClient.invalidateQueries({ queryKey: ["myShares"] }),
    queryClient.invalidateQueries({ queryKey: ["share", shareId] }),
  ]);
}
