import { mapSession } from '../session/mapping.js'
import type { AuditEvidenceEntry, AuditRequest, HelioClient } from '../client/helio-client.js'
import type { EvidenceConfig, EvidenceRule } from '../config.js'
import type { CorrelationRegistry } from '../correlation/registry.js'
import type { PluginHookAfterToolCallEvent, PluginHookToolContext } from '../types.js'

export interface AfterToolCallDeps {
  readonly client: HelioClient
  readonly registry: CorrelationRegistry
  /** Success-only evidence-extraction rules, keyed by tool name. Absent → no evidence. */
  readonly evidence?: EvidenceConfig
}

// Walk `result` by explicit path segments. Returns `found: false` if the path runs off the object
// or through a non-object — a missing value must skip the entry, never emit `undefined`.
function extractByPath(root: unknown, path: readonly string[]): { found: boolean; value: unknown } {
  let current: unknown = root
  for (const segment of path) {
    if (typeof current !== 'object' || current === null) return { found: false, value: undefined }
    current = (current as Record<string, unknown>)[segment]
    if (current === undefined) return { found: false, value: undefined }
  }
  return { found: true, value: current }
}

// `result` and extracted evidence are tool-controlled and may not be JSON-encodable (BigInt,
// circular refs, throwing getters). The client serializes the body with JSON.stringify and a throw
// there is caught as a failed POST — losing the audit for a call that ran. Snapshot each risky field
// to a stable plain-JSON clone *once* here, so the value the client later re-serializes is exactly
// what we validated — no second, possibly-divergent evaluation of a hostile/non-deterministic getter
// or proxy (TOCTOU). On failure the field is dropped; the always-serializable core
// (evaluation_id/status/error/duration_ms) still finalizes.
function safeJsonSnapshot<T>(value: T): { ok: true; value: T } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(JSON.stringify(value)) as T }
  } catch {
    return { ok: false }
  }
}

// The sideband rejects request bodies over 1 MiB (docs/adapter-api.md) with 413. Keep headroom so a
// near-limit body can't tip over and lose the audit for a call that ran.
const MAX_AUDIT_BODY_BYTES = 1_048_576 - 16_384

function bodyBytes(req: AuditRequest): number {
  return new TextEncoder().encode(JSON.stringify(req)).length
}

// Truncate `str` to at most `maxBytes` UTF-8 bytes without splitting a multi-byte code point (back
// off the cut while it lands on a continuation byte, 0b10xxxxxx).
function truncateUtf8(str: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(str)
  if (bytes.length <= maxBytes) return str
  let end = maxBytes
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1
  return new TextDecoder().decode(bytes.subarray(0, end))
}

// Fit the audit body under the size budget by shedding fields in priority order so a call that ran
// always finalizes rather than 413-ing into a false `evaluation_expired`. The truly unsheddable
// minimal core (evaluation_id/status/duration_ms) is tiny and bounded; everything else degrades:
// drop the (unbounded) `result`, then trim `evidence` from the end, then — since `error` is optional
// in the wire contract — truncate an oversized `error` (UTF-8 safe, with a marker) and finally omit
// it entirely.
function fitToBudget(
  base: AuditRequest,
  error: string | undefined,
  result: { value: unknown } | undefined,
  evidence: readonly AuditEvidenceEntry[],
): AuditRequest {
  const build = (
    err: string | undefined,
    includeResult: boolean,
    ev: readonly AuditEvidenceEntry[],
  ): AuditRequest => ({
    ...base,
    ...(err !== undefined ? { error: err } : {}),
    ...(includeResult && result !== undefined ? { result: result.value } : {}),
    ...(ev.length > 0 ? { evidence: ev } : {}),
  })
  const fits = (req: AuditRequest): boolean => bodyBytes(req) <= MAX_AUDIT_BODY_BYTES

  let candidate = build(error, true, evidence)
  if (fits(candidate)) return candidate

  candidate = build(error, false, evidence)
  if (fits(candidate)) return candidate

  let kept = evidence.slice(0, -1)
  while (kept.length > 0) {
    candidate = build(error, false, kept)
    if (fits(candidate)) return candidate
    kept = kept.slice(0, -1)
  }

  candidate = build(error, false, [])
  if (fits(candidate) || error === undefined) return candidate

  // Only an oversized `error` remains. Keep the largest UTF-8-safe prefix (with a marker) that fits;
  // omitting it (best = no error) always fits since the minimal core is tiny.
  const marker = '...[truncated]'
  const totalBytes = new TextEncoder().encode(error).length
  let best = build(undefined, false, [])
  let lo = 0
  let hi = totalBytes
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const trial = build(truncateUtf8(error, mid) + marker, false, [])
    if (fits(trial)) {
      best = trial
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return best
}

// Apply a tool's rules to `result`, dropping any rule whose path is absent. Success-only: the
// caller must not invoke this for an error/not-executed outcome.
function extractEvidence(
  rules: readonly EvidenceRule[],
  result: unknown,
): readonly AuditEvidenceEntry[] {
  const entries: AuditEvidenceEntry[] = []
  for (const rule of rules) {
    const { found, value } = extractByPath(result, rule.path)
    if (!found) continue
    entries.push({
      evidence_key: rule.key,
      evidence_data: value,
      ...(rule.ttlSeconds !== undefined ? { ttl_seconds: rule.ttlSeconds } : {}),
    })
  }
  return entries
}

// after_tool_call → POST /audit. The host ignores the return value (observational), so this is
// best-effort: a failed audit is never thrown across the hook. A 200 `already_finalized` replay
// (terminal-at-evaluate) is treated as success by the client, so we audit unconditionally.
export function createAfterToolCallHook(deps: AfterToolCallDeps) {
  const { client, registry } = deps

  return async (event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext): Promise<void> => {
    const session = mapSession(ctx)

    // Claim the evaluation_id bound by the matching before_tool_call. A miss means there is no id
    // to audit — the before-hook released the slot for a terminal decision, or it was never bound
    // (e.g. fail-closed block). Nothing to do; the pending evaluation expires server-side.
    const evaluationId = registry.claim({
      session,
      toolName: event.toolName,
      ...(event.toolCallId !== undefined ? { toolCallId: event.toolCallId } : {}),
      ...(event.runId !== undefined ? { runId: event.runId } : {}),
    })
    if (evaluationId === undefined) return

    const isError = event.error !== undefined
    // Evidence is success-only (a failed tool must not ground later calls) and config-driven.
    // `event.result` is tool-controlled `unknown`, so a hostile property access (throwing getter /
    // proxy) during the path walk must never escape this observational hook — degrade to auditing
    // without evidence so the audit record (and its counter commit) for a call that ran is kept.
    let evidence: readonly AuditEvidenceEntry[] = []
    if (!isError) {
      try {
        evidence = extractEvidence(deps.evidence?.[event.toolName] ?? [], event.result)
      } catch {
        evidence = []
      }
    }

    const result = event.result !== undefined ? safeJsonSnapshot(event.result) : undefined

    // Snapshot evidence per entry so one unserializable extracted value drops only its own entry,
    // not the valid grounding facts beside it.
    const safeEvidence: AuditEvidenceEntry[] = []
    for (const entry of evidence) {
      const snapshot = safeJsonSnapshot(entry)
      if (snapshot.ok) safeEvidence.push(snapshot.value)
    }

    const base: AuditRequest = {
      evaluation_id: evaluationId,
      status: isError ? 'error' : 'success',
      ...(event.durationMs !== undefined ? { duration_ms: event.durationMs } : {}),
    }
    const request = fitToBudget(
      base,
      event.error,
      result?.ok ? { value: result.value } : undefined,
      safeEvidence,
    )

    // Best-effort: the client never throws (it returns an outcome), but guard anyway so an
    // unexpected failure can never escape an observational hook.
    try {
      await client.audit(request)
    } catch {
      // Swallowed deliberately — the call already ran; a lost audit surfaces server-side as an
      // `evaluation_expired` record, which Helio monitors as a tamper/bypass signal.
    }
  }
}
