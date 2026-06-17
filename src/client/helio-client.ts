// Token-bearing HTTP client for the Helio governance sideband.
//
// Bearer `HELIO_ADAPTER_TOKEN` on every call, never an `Origin` header, and **fail-closed**:
// `/evaluate` unreachable/timeout/non-2xx surfaces as `{ ok: false }`, never a proceed.

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

export type EvaluateDecision =
  | 'allow'
  | 'deny'
  | 'require_approval'
  | 'rate_limited'
  | 'spend_limited'
  | 'dry_run'

export interface EvaluateResponse {
  evaluation_id: string
  decision: EvaluateDecision
  reason?: string
  feedback?: { message?: string }
  approval?: { id: string; timeout_ms?: number; resolve_path?: string }
}

export type EvaluateOutcome =
  | { ok: true; response: EvaluateResponse }
  | { ok: false; reason: string }

export interface HelioClient {
  evaluate(req: EvaluateRequest): Promise<EvaluateOutcome>
}

export function createHelioClient(
  config: HelioClientConfig,
  deps: HelioClientDeps = {},
): HelioClient {
  const fetchImpl = deps.fetch ?? fetch

  return {
    async evaluate(req) {
      // Bound the call so a hung proxy fails closed promptly rather than stalling the turn.
      const controller = new AbortController()
      const timer = setTimeout(() => {
        controller.abort()
      }, config.evaluateTimeoutMs)
      try {
        const res = await fetchImpl(`${config.baseUrl}/evaluate`, {
          method: 'POST',
          // Bearer adapter token on every call; deliberately no `Origin` header
          // (Helio's browser-forgery guard rejects it).
          headers: {
            authorization: `Bearer ${config.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(req),
          signal: controller.signal,
        })
        if (!res.ok) {
          return { ok: false, reason: `Helio /evaluate returned ${String(res.status)}` }
        }
        const response = (await res.json()) as EvaluateResponse
        return { ok: true, response }
      } catch {
        return { ok: false, reason: 'Helio governance unavailable' }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
