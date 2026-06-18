// Token-bearing HTTP client for the Helio governance sideband.
//
// Bearer `HELIO_ADAPTER_TOKEN` on every call, never an `Origin` header, and **fail-closed**:
// `/evaluate` unreachable/timeout/non-2xx surfaces as `{ ok: false }`, never a proceed.

import { z } from 'zod'

/** Resolved client configuration. Mirrors the manifest `configSchema` in `openclaw.plugin.json`. */
export interface HelioClientConfig {
  readonly baseUrl: string
  readonly token: string
  readonly origin: string
  readonly evaluateTimeoutMs: number
}

/** Injectable dependencies (test seam). */
export interface HelioClientDeps {
  readonly fetch?: typeof fetch
}

/**
 * Request body for `POST /evaluate`. DTO: snake_case wire fields. `origin` is injected by the
 * client from config, so callers omit it.
 */
export interface EvaluateRequest {
  readonly tool: {
    readonly name: string
    readonly description?: string
    readonly input_schema?: Record<string, unknown>
    readonly annotations?: Record<string, unknown>
  }
  readonly arguments?: Record<string, unknown>
  readonly agent_id?: string
  readonly session_id?: string
  readonly metadata?: Record<string, unknown>
}

// Proxy responses are parsed with Zod (not asserted) — a malformed response fails closed.
const evaluateDecisionSchema = z.enum([
  'allow',
  'deny',
  'require_approval',
  'rate_limited',
  'spend_limited',
  'dry_run',
])

const evaluateResponseSchema = z
  .object({
    evaluation_id: z.string(),
    decision: evaluateDecisionSchema,
    reason: z.string().optional(),
    feedback: z.object({ message: z.string().optional() }).optional(),
    approval: z
      .object({
        id: z.string(),
        timeout_ms: z.number().optional(),
        resolve_path: z.string().optional(),
      })
      .optional(),
  })
  .readonly()

/** The `/evaluate` decision outcomes. */
export type EvaluateDecision = z.infer<typeof evaluateDecisionSchema>
/** Parsed `/evaluate` response. */
export type EvaluateResponse = z.infer<typeof evaluateResponseSchema>

/** Result of an evaluate call. Fail-closed: `{ ok: false }` whenever no valid decision was obtained. */
export type EvaluateOutcome =
  | { ok: true; response: EvaluateResponse }
  | { ok: false; reason: string }

/** A single evidence entry attached to a successful audit. DTO: snake_case wire fields. */
export interface AuditEvidenceEntry {
  readonly evidence_key: string
  readonly evidence_data: unknown
  readonly ttl_seconds?: number
}

/** Request body for `POST /audit`. */
export interface AuditRequest {
  readonly evaluation_id: string
  readonly status: 'success' | 'error' | 'not_executed'
  readonly error?: string
  readonly duration_ms?: number
  readonly result?: unknown
  readonly actual_amount?: number
  readonly evidence?: readonly AuditEvidenceEntry[]
}

/**
 * Result of an audit call. Best-effort: the tool already ran, so a failure is reported (for
 * telemetry/logging), never thrown. A 200 `already_finalized` replay is success, not an error.
 */
export type AuditOutcome = { ok: true } | { ok: false; reason: string }

/** Request body for `POST /install-scan`. DTO: snake_case wire fields. */
export interface InstallScanRequest {
  readonly package: {
    readonly name: string
    readonly version?: string
    readonly source: string
    readonly spec?: string
  }
  readonly metadata?: Record<string, unknown>
}

const installScanResponseSchema = z
  .object({
    evaluation_id: z.string(),
    decision: z.enum(['allow', 'deny']),
    reason: z.string().optional(),
    feedback: z.object({ message: z.string().optional() }).optional(),
  })
  .readonly()

/** Parsed `/install-scan` response. */
export type InstallScanResponse = z.infer<typeof installScanResponseSchema>

/** Result of an install-scan call. Fail-closed when the scan can't be obtained. */
export type InstallScanOutcome =
  | { ok: true; response: InstallScanResponse }
  | { ok: false; reason: string }

/** Request body for `POST /approval/:id/resolve`. */
export interface ApprovalResolveRequest {
  readonly resolution: 'approved' | 'denied' | 'timeout' | 'cancelled'
  readonly resolved_by?: string
  readonly reason?: string
  readonly scope?: 'once' | 'always'
}

/** Result of an approval-resolve call. */
export type ResolveApprovalOutcome = { ok: true } | { ok: false; reason: string }

/** Token-bearing client for the four Helio governance sideband endpoints. */
export interface HelioClient {
  /** `POST /evaluate` — decide a tool call. Fails closed when no valid decision is obtained. */
  evaluate(req: EvaluateRequest): Promise<EvaluateOutcome>
  /** `POST /audit` — record the outcome. Best-effort; a 200 `already_finalized` replay is success. */
  audit(req: AuditRequest): Promise<AuditOutcome>
  /** `POST /install-scan` — evaluate a package/skill install. Fails closed. */
  installScan(req: InstallScanRequest): Promise<InstallScanOutcome>
  /** `POST /approval/:id/resolve` — record a natively-handled approval resolution. */
  resolveApproval(approvalId: string, req: ApprovalResolveRequest): Promise<ResolveApprovalOutcome>
}

export function createHelioClient(
  config: HelioClientConfig,
  deps: HelioClientDeps = {},
): HelioClient {
  const fetchImpl = deps.fetch ?? fetch

  // Bearer adapter token on every call; deliberately no `Origin` header
  // (Helio's browser-forgery guard rejects it).
  function postJson(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    const init: RequestInit = {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }
    if (signal) init.signal = signal
    return fetchImpl(`${config.baseUrl}${path}`, init)
  }

  // Run a gating governance call (evaluate, install-scan) bounded by `evaluateTimeoutMs` so a hung
  // proxy fails closed promptly rather than stalling the hook indefinitely. The signal covers the
  // whole operation (fetch + body read), so a stall mid-stream also aborts.
  async function bounded<T>(op: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, config.evaluateTimeoutMs)
    try {
      return await op(controller.signal)
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    async evaluate(req) {
      try {
        return await bounded(async (signal): Promise<EvaluateOutcome> => {
          const res = await postJson('/evaluate', { origin: config.origin, ...req }, signal)
          if (!res.ok) {
            return { ok: false, reason: `Helio /evaluate returned ${String(res.status)}` }
          }
          const parsed = evaluateResponseSchema.safeParse(await res.json())
          if (!parsed.success) {
            return { ok: false, reason: 'Helio returned a malformed /evaluate response' }
          }
          return { ok: true, response: parsed.data }
        })
      } catch {
        return { ok: false, reason: 'Helio governance unavailable' }
      }
    },

    async audit(req) {
      // Any 2xx is success, including a 200 `already_finalized` replay.
      try {
        const res = await postJson('/audit', req)
        return res.ok
          ? { ok: true }
          : { ok: false, reason: `Helio /audit returned ${String(res.status)}` }
      } catch {
        return { ok: false, reason: 'Helio /audit unreachable' }
      }
    },

    async installScan(req) {
      // Fail closed: if the scan can't be obtained (incl. a timeout), the install is blocked by
      // the hook. Bounded like /evaluate so a hung proxy can't stall the install indefinitely.
      try {
        return await bounded(async (signal): Promise<InstallScanOutcome> => {
          const res = await postJson('/install-scan', { origin: config.origin, ...req }, signal)
          if (!res.ok) {
            return { ok: false, reason: `Helio /install-scan returned ${String(res.status)}` }
          }
          const parsed = installScanResponseSchema.safeParse(await res.json())
          if (!parsed.success) {
            return { ok: false, reason: 'Helio returned a malformed /install-scan response' }
          }
          return { ok: true, response: parsed.data }
        })
      } catch {
        return { ok: false, reason: 'Helio governance unavailable' }
      }
    },

    async resolveApproval(approvalId, req) {
      try {
        const res = await postJson(`/approval/${encodeURIComponent(approvalId)}/resolve`, req)
        return res.ok
          ? { ok: true }
          : { ok: false, reason: `Helio /approval resolve returned ${String(res.status)}` }
      } catch {
        return { ok: false, reason: 'Helio /approval resolve unreachable' }
      }
    },
  }
}
