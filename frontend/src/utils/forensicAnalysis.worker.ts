import { detectMark, type Pixels } from "./forensicMark.util"
import {
  canAnalyseFragment,
  detectFragmentCopyMark,
} from "./fragmentCopyMark.util"
import {
  combineCopyAnalyses,
  detectRobustCopyMark,
} from "./robustCopyMark.util"
import {
  detectVisibleCopyMarks,
  type CopyMarkCandidate,
} from "./visibleCopyMark.util"

const scope = self as unknown as {
  onmessage: ((_event: MessageEvent) => void) | null
  postMessage: (_value: unknown) => void
}
let candidates: CopyMarkCandidate[] = []
scope.onmessage = (event) => {
  if (
    !event.isTrusted ||
    event.origin !== "" ||
    event.source !== null ||
    event.ports.length
  )
    return
  const message = event.data
  if (
    !message ||
    typeof message !== "object" ||
    !Number.isSafeInteger(message.id)
  )
    return
  try {
    if (
      message.type === "init" &&
      Object.keys(message).length === 3 &&
      Array.isArray(message.candidates)
    ) {
      if (message.candidates.length > 1000)
        throw new Error("Candidate budget exceeded")
      candidates = message.candidates
      scope.postMessage({ id: message.id, type: "ready" })
    } else if (
      message.type === "analyse" &&
      Object.keys(message).length === 3
    ) {
      const pixels = message.pixels as Pixels
      const analyses = [detectMark(pixels, candidates)]
      const robust = detectRobustCopyMark(
        pixels,
        candidates.filter((candidate) => candidate.robust === true),
      )
      if (robust) analyses.push(robust)
      const first = combineCopyAnalyses(analyses)
      if (
        first.status === "inconclusive" &&
        canAnalyseFragment(pixels, candidates.length)
      ) {
        scope.postMessage({ id: message.id, type: "phase", phase: "fragment" })
        const fragment = detectFragmentCopyMark(pixels, candidates)
        if (fragment) analyses.push(fragment)
      }
      scope.postMessage({
        id: message.id,
        type: "result",
        result: {
          ...combineCopyAnalyses(analyses),
          visibleMarkIds: detectVisibleCopyMarks(pixels, candidates),
        },
      })
    }
  } catch {
    scope.postMessage({ id: message.id, type: "error" })
  }
}
