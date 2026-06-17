// Token-bearing HTTP client for the Helio governance sideband.
//
// Bearer `HELIO_ADAPTER_TOKEN` on every call, never an `Origin` header, and **fail-closed**:
// `/evaluate` unreachable/timeout/non-2xx surfaces as `{ ok: false }`, never a proceed.

import { z } from 'zod'

export interface HelioClientConfig {
  baseUrl: string
  token: string
  origin: string
  evaluateTimeoutMs: number
}

export interface HelioClientDeps {
  fetch?: typeof fetch
}

export interface EvaluateRequest {
  tool: {
    name: string
    description?: string
    input_schema?: Record<string, unknown>
    annotations?: Record<string, unknown>
  }
  arguments?: Record<string, unknown>
  agent_id?: string
  session_id?: string
  metadata?: Record<string, unknown>
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

const evaluateResponseSchema = z.object({
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

export type EvaluateDecision = z.infer<typeof evaluateDecisionSchema>
export type EvaluateResponse = z.infer<typeof evaluateResponseSchema>

export type EvaluateOutcome =
  | { ok: true; response: EvaluateResponse }
  | { ok: false; reason: string }

export interface AuditEvidenceEntry {
  evidence_key: string
  evidence_data: unknown
  ttl_seconds?: number
}

export interface AuditRequest {
  evaluation_id: string
  status: 'success' | 'error' | 'not_executed'
  error?: string
  duration_ms?: number
  result?: unknown
  actual_amount?: number
  evidence?: AuditEvidenceEntry[]
}

// Audit is best-effort: the tool already ran, so a failure is reported (for telemetry/logging),
// never thrown. A 200 `already_finalized` replay is success, not an error.
export type AuditOutcome = { ok: true } | { ok: false; reason: string }

export interface InstallScanRequest {
  package: { name: string; version?: string; source: string; spec?: string }
  metadata?: Record<string, unknown>
}

const installScanResponseSchema = z.object({
  evaluation_id: z.string(),
  decision: z.enum(['allow', 'deny']),
  reason: z.string().optional(),
  feedback: z.object({ message: z.string().optional() }).optional(),
})

export type InstallScanResponse = z.infer<typeof installScanResponseSchema>

export type InstallScanOutcome =
  | { ok: true; response: InstallScanResponse }
  | { ok: false; reason: string }

export interface ApprovalResolveRequest {
  resolution: 'approved' | 'denied' | 'timeout' | 'cancelled'
  resolved_by?: string
  reason?: string
  scope?: 'once' | 'always'
}

export type ResolveApprovalOutcome = { ok: true } | { ok: false; reason: string }

export interface HelioClient {
  evaluate(req: EvaluateRequest): Promise<EvaluateOutcome>
  audit(req: AuditRequest): Promise<AuditOutcome>
  installScan(req: InstallScanRequest): Promise<InstallScanOutcome>
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

  return {
    async evaluate(req) {
      // Bound the call so a hung proxy fails closed promptly rather than stalling the turn.
      const controller = new AbortController()
      const timer = setTimeout(() => {
        controller.abort()
      }, config.evaluateTimeoutMs)
      try {
        const res = await postJson(
          '/evaluate',
          { origin: config.origin, ...req },
          controller.signal,
        )
        if (!res.ok) {
          return { ok: false, reason: `Helio /evaluate returned ${String(res.status)}` }
        }
        const parsed = evaluateResponseSchema.safeParse(await res.json())
        if (!parsed.success) {
          return { ok: false, reason: 'Helio returned a malformed /evaluate response' }
        }
        return { ok: true, response: parsed.data }
      } catch {
        return { ok: false, reason: 'Helio governance unavailable' }
      } finally {
        clearTimeout(timer)
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
      // Fail closed: if the scan can't be obtained, the install is blocked by the hook.
      try {
        const res = await postJson('/install-scan', { origin: config.origin, ...req })
        if (!res.ok) {
          return { ok: false, reason: `Helio /install-scan returned ${String(res.status)}` }
        }
        const parsed = installScanResponseSchema.safeParse(await res.json())
        if (!parsed.success) {
          return { ok: false, reason: 'Helio returned a malformed /install-scan response' }
        }
        return { ok: true, response: parsed.data }
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
