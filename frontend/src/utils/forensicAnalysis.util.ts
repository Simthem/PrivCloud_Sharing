import type { MarkAnalysis, Pixels } from "./forensicMark.util"
import { COPY_TOKEN, type CopyMarkCandidate } from "./visibleCopyMark.util"

export type ForensicAnalysis = MarkAnalysis & {
  visibleMarkIds?: string[]
  minimumScore?: number
  fragmentHypotheses?: number
}
import {
  isMarkId,
  MARK_DETECTION_THRESHOLD,
  MARK_MIN_SCORE_GAP,
  MARK_TILE,
} from "./forensicMark.util"

const DEDICATED_WORKER_MESSAGE_ORIGIN = ""

export function isForensicAnalysis(
  value: ForensicAnalysis,
  ids: Set<string>,
): boolean {
  const detection = (candidate: MarkAnalysis["best"]): boolean =>
    Boolean(
      candidate &&
      ids.has(candidate.markId) &&
      Number.isFinite(candidate.score) &&
      candidate.score >= MARK_DETECTION_THRESHOLD &&
      Number.isFinite(candidate.scale) &&
      candidate.scale > 0 &&
      Number.isFinite(candidate.falseMatchLog10) &&
      candidate.falseMatchLog10 <= 0,
    )
  if (
    !value ||
    (value.minimumScore !== undefined &&
      ![8, 10].includes(value.minimumScore)) ||
    (value.fragmentHypotheses !== undefined &&
      value.fragmentHypotheses !== 181) ||
    (value.minimumScore === 10) !== (value.fragmentHypotheses === 181) ||
    (value.visibleMarkIds !== undefined &&
      (!Array.isArray(value.visibleMarkIds) ||
        value.visibleMarkIds.length > ids.size ||
        value.visibleMarkIds.some((id) => !ids.has(id)) ||
        new Set(value.visibleMarkIds).size !== value.visibleMarkIds.length)) ||
    !["match", "inconclusive", "ambiguous_multiple_sources"].includes(
      value.status,
    ) ||
    !Number.isFinite(value.rotation) ||
    Math.abs(value.rotation) > 360 ||
    !Number.isFinite(value.topScore) ||
    !Number.isFinite(value.runnerUpScore) ||
    value.runnerUpScore < 0 ||
    value.topScore < value.runnerUpScore ||
    !Array.isArray(value.scales) ||
    value.scales.length > 16 ||
    value.scales.some((scale) => !Number.isFinite(scale) || scale <= 0) ||
    !Array.isArray(value.compatible) ||
    value.compatible.length > ids.size ||
    value.compatible.some((candidate) => !detection(candidate)) ||
    new Set(value.compatible.map((candidate) => candidate.markId)).size !==
      value.compatible.length ||
    (value.status === "match") !== Boolean(value.best)
  )
    return false
  if (value.status === "ambiguous_multiple_sources")
    return value.compatible.length > 1
  if (value.status === "inconclusive") return value.compatible.length <= 1
  return (
    detection(value.best) &&
    value.best!.score >= (value.minimumScore ?? MARK_DETECTION_THRESHOLD) &&
    value.compatible.length === 1 &&
    value.compatible[0].markId === value.best!.markId &&
    value.best!.score === value.topScore &&
    value.runnerUpScore < MARK_DETECTION_THRESHOLD &&
    value.topScore - value.runnerUpScore >= MARK_MIN_SCORE_GAP
  )
}

/** One local worker per analysis. No keys or images are sent over the network. */
export async function createForensicAnalyzer(
  candidates: CopyMarkCandidate[],
  signal: AbortSignal,
  onPhase?: (_phase: "fragment") => void,
) {
  signal.throwIfAborted()
  const ids = new Set(candidates.map((candidate) => candidate.markId))
  if (
    candidates.length > 1000 ||
    ids.size !== candidates.length ||
    candidates.some(
      (candidate) =>
        !isMarkId(candidate.markId) ||
        (candidate.robust !== undefined &&
          typeof candidate.robust !== "boolean") ||
        (candidate.visibleToken !== undefined &&
          (!COPY_TOKEN.test(candidate.visibleToken) ||
            candidate.visibleToken.slice(4, 36) !== candidate.markId)) ||
        !(candidate.pattern instanceof Float32Array) ||
        candidate.pattern.length !== MARK_TILE * MARK_TILE ||
        !candidate.pattern.every(
          (value) => Number.isFinite(value) && Math.abs(value) <= 1,
        ),
    )
  )
    throw new Error("Invalid or oversized forensic candidates")
  const worker = new Worker(
    new URL("./forensicAnalysis.worker.ts", import.meta.url),
  )
  let id = 0
  let pending: {
    id: number
    resolve: (_value: ForensicAnalysis) => void
    reject: (_reason: unknown) => void
  } | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    worker.onmessage = null
    worker.terminate()
    clearTimeout(timer)
    signal.removeEventListener("abort", close)
    pending?.reject(new DOMException("Analysis stopped", "AbortError"))
    pending = null
  }
  signal.addEventListener("abort", close, { once: true })
  worker.addEventListener("error", close)
  worker.onmessage = (event: MessageEvent) => {
    if (event.origin !== DEDICATED_WORKER_MESSAGE_ORIGIN) return
    if (
      !event.isTrusted ||
      event.source !== null ||
      event.ports.length ||
      event.currentTarget !== worker ||
      closed ||
      !pending
    )
      return
    const reply = event.data
    if (!reply || typeof reply !== "object" || reply.id !== pending.id) return
    if (reply.type === "phase" && reply.phase === "fragment") {
      onPhase?.("fragment")
      return
    }
    if (reply.type === "error") {
      close()
      return
    }
    if (reply.type !== "ready" && reply.type !== "result") return
    if (reply.type === "result") {
      const value = reply.result as ForensicAnalysis
      if (!isForensicAnalysis(value, ids)) {
        close()
        return
      }
    }
    clearTimeout(timer)
    const current = pending
    pending = null
    current.resolve(reply.result)
  }
  const request = (
    type: string,
    payload: object,
    transfer: Transferable[] = [],
  ) =>
    new Promise<ForensicAnalysis>((resolve, reject) => {
      if (closed || pending) {
        reject(new Error("Analysis worker unavailable"))
        return
      }
      pending = { id: ++id, resolve, reject }
      timer = setTimeout(close, 120_000)
      worker.postMessage({ id, type, ...payload }, transfer)
    })
  try {
    await request("init", { candidates }, [
      ...new Set(
        candidates.map((candidate) => candidate.pattern.buffer as ArrayBuffer),
      ),
    ])
    return {
      analyse: (pixels: Pixels) =>
        request("analyse", { pixels }, [pixels.data.buffer as ArrayBuffer]),
      close,
    }
  } catch (error) {
    close()
    throw error
  }
}
