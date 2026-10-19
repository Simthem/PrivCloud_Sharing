import type { MarkAnalysis, MarkDetection } from "./forensicMark.util"

export type ForensicDecision =
  | {
      kind: "match"
      detection: MarkDetection
      page?: number
      minimumScore?: number
    }
  | { kind: "ambiguous"; compatibleCount: number }
  | { kind: "none" }
  | { kind: "visible_marker"; markId: string }

/** Combine every analysed page, including plausible signals without a winner. */
export function forensicDecision(
  results: {
    analysis: MarkAnalysis & {
      visibleMarkIds?: string[]
      minimumScore?: number
    }
    page?: number
  }[],
): ForensicDecision {
  const ids = new Set(
    results.flatMap((result) => [
      ...result.analysis.compatible.map((candidate) => candidate.markId),
      ...(result.analysis.visibleMarkIds ?? []),
    ]),
  )
  if (
    ids.size > 1 ||
    results.some(
      (result) => result.analysis.status === "ambiguous_multiple_sources",
    )
  )
    return { kind: "ambiguous", compatibleCount: ids.size }
  const matches = results
    .filter(
      (result) => result.analysis.status === "match" && result.analysis.best,
    )
    .sort(
      (left, right) => right.analysis.best!.score - left.analysis.best!.score,
    )
  return matches.length
    ? {
        kind: "match",
        detection: matches[0].analysis.best!,
        page: matches[0].page,
        ...(matches[0].analysis.minimumScore
          ? { minimumScore: matches[0].analysis.minimumScore }
          : {}),
      }
    : ids.size === 1 &&
        results.some((result) => result.analysis.visibleMarkIds?.length)
      ? { kind: "visible_marker", markId: [...ids][0] }
      : { kind: "none" }
}
