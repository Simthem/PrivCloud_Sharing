import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { forensicDecision } from "../src/utils/forensicDecision.util.ts"
import { isForensicAnalysis } from "../src/utils/forensicAnalysis.util.ts"

const ids = ["1".repeat(32), "2".repeat(32)]
const detection = (markId, score) => ({ markId, score, scale: 1, falseMatchLog10: -10 })
const matched = (markId = ids[0]) => ({
  best: detection(markId, 26), compatible: [detection(markId, 26)],
  status: "match", topScore: 26, runnerUpScore: 5, scales: [1], rotation: 0,
})
const ambiguous = () => ({
  ...matched(), best: null, status: "ambiguous_multiple_sources", runnerUpScore: 23,
  compatible: [detection(ids[0], 26), detection(ids[1], 23)],
})

test("forensic worker messages retain an explicit origin and sender gate", async () => {
  const source = await readFile(
    new URL("../src/utils/forensicAnalysis.util.ts", import.meta.url),
    "utf8",
  )
  assert.doesNotMatch(source, /addEventListener\(["']message["']/)
  assert.match(
    source,
    /event\.origin !== DEDICATED_WORKER_MESSAGE_ORIGIN/,
  )
  assert.match(source, /event\.currentTarget !== worker/)
  assert.match(source, /event\.source !== null/)
  assert.match(source, /!event\.isTrusted/)
})

test("one ambiguous page prevents a unique whole-file result regardless of page order", () => {
  for (const results of [
    [{ analysis: matched(), page: 1 }, { analysis: ambiguous(), page: 2 }],
    [{ analysis: ambiguous(), page: 1 }, { analysis: matched(), page: 2 }],
    [{ analysis: matched(ids[0]), page: 1 }, { analysis: matched(ids[1]), page: 2 }],
  ]) assert.deepEqual(forensicDecision(results), { kind: "ambiguous", compatibleCount: 2 })
})

test("a plausible competing page without a winner also prevents a unique whole-file result", () => {
  const weak = { ...matched(ids[1]), best: null, status: "inconclusive", topScore: 8.2, runnerUpScore: 7.9,
    compatible: [detection(ids[1], 8.2)] }
  assert.deepEqual(forensicDecision([{ analysis: matched() }, { analysis: weak }]), { kind: "ambiguous", compatibleCount: 2 })
  assert.equal(forensicDecision([{ analysis: matched(), page: 3 }, { analysis: matched(), page: 4 }]).kind, "match")
  assert.deepEqual(forensicDecision([]), { kind: "none" })
})

test("worker replies cannot label several plausible patterns as a unique match", () => {
  const known = new Set(ids)
  assert.equal(isForensicAnalysis(matched(), known), true)
  assert.equal(isForensicAnalysis(ambiguous(), known), true)
  for (const result of [
    { ...ambiguous(), status: "match", best: detection(ids[0], 26) },
    { ...matched(), runnerUpScore: 8.1 },
    { ...ambiguous(), compatible: [detection(ids[0], 26)] },
    { ...ambiguous(), compatible: [detection(ids[0], 26), detection(ids[0], 23)] },
    { ...matched(), best: detection("3".repeat(32), 26) },
    { ...matched(), scales: [Number.NaN] },
    { ...matched(), topScore: Number.POSITIVE_INFINITY },
  ]) assert.equal(isForensicAnalysis(result, known), false)
})

test("fragment replies retain the stronger decision threshold and all plausible sources", () => {
  const known = new Set(ids)
  const result = { ...matched(), minimumScore: 10, fragmentHypotheses: 181 }
  assert.equal(isForensicAnalysis(result, known), true)
  assert.equal(forensicDecision([{ analysis: result }]).minimumScore, 10)
  assert.equal(isForensicAnalysis({ ...result, minimumScore: 8 }, known), false)
  assert.equal(isForensicAnalysis({ ...result, fragmentHypotheses: undefined }, known), false)
  assert.equal(isForensicAnalysis({ ...result, best: detection(ids[0], 9), topScore: 9, compatible: [detection(ids[0], 9)] }, known), false)
  assert.deepEqual(forensicDecision([{ analysis: result }, { analysis: { ...matched(ids[1]), status: "inconclusive", best: null, topScore: 8.2, compatible: [detection(ids[1], 8.2)] } }]), { kind: "ambiguous", compatibleCount: 2 })
})
