/** Byte progress is provisional until every worker and retry has settled. */
export function hasSettledUpload(
  files: { uploadingProgress?: number }[],
  workersFinished: boolean,
) {
  return (
    workersFinished &&
    files.length > 0 &&
    files.every(
      (file) =>
        (file.uploadingProgress ?? 0) >= 100 || file.uploadingProgress === -1,
    )
  );
}

/** Recover the saved share if only its final HTTP acknowledgement was lost. */
export async function finalizeUpload<T>(
  complete: () => Promise<T>,
  recoverCompleted: () => Promise<T>,
  expectedShareId?: string,
): Promise<T> {
  const confirmed = (value: T): boolean => {
    if (!expectedShareId) return true;
    const share = value as { id?: unknown; uploadPending?: unknown } | null;
    return (
      !!share &&
      typeof share === "object" &&
      share.id === expectedShareId &&
      share.uploadPending === false
    );
  };
  let completion: T;
  try {
    completion = await complete();
  } catch (error) {
    const response = (
      error as { response?: { status?: number; data?: { message?: unknown } } }
    )?.response;
    const alreadyCompleted =
      response?.status === 400 &&
      response.data?.message === "Share already completed";
    const acknowledgementMayBeLost =
      !response || response.status === 408 || (response.status ?? 0) >= 500;
    if (alreadyCompleted || (expectedShareId && acknowledgementMayBeLost)) {
      try {
        const recovered = await recoverCompleted();
        if (confirmed(recovered)) return recovered;
      } catch {
        // Preserve the original error when recovery cannot prove completion.
      }
    }
    throw error;
  }
  if (confirmed(completion)) return completion;
  // A proxy can return HTML with HTTP 200. Only this owner's saved state can
  // recover an unconfirmed acknowledgement, never byte progress or file count.
  const recovered = await recoverCompleted();
  if (confirmed(recovered)) return recovered;
  throw new Error("UPLOAD_COMPLETION_UNCONFIRMED");
}
