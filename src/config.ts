import { z } from 'zod'

/**
 * One success-only evidence-extraction rule. `path` addresses a value inside `event.result` by
 * explicit segments (e.g. `['url', 'host']`) — array form, not a dotted string, so a key that
 * itself contains a `.` is unambiguous and there is no escaping to get wrong. The extracted value
 * is sent as `evidence_data` under `evidence_key: key`; a missing path skips the entry.
 */
export interface EvidenceRule {
  readonly key: string
  readonly path: readonly string[]
  readonly ttlSeconds?: number
}

/** Evidence-extraction rules keyed by tool name (extraction is tool-shape-specific). */
export type EvidenceConfig = Readonly<Record<string, readonly EvidenceRule[]>>

// Resolved adapter configuration. Mirrors the manifest `configSchema` in openclaw.plugin.json.
export interface AdapterConfig {
  helioBaseUrl: string
  tokenEnv: string
  origin: string
  evaluateTimeoutMs: number
  evidence: EvidenceConfig
}

export const DEFAULT_CONFIG: AdapterConfig = {
  helioBaseUrl: 'http://127.0.0.1:3200',
  tokenEnv: 'HELIO_ADAPTER_TOKEN',
  origin: 'openclaw',
  evaluateTimeoutMs: 2000,
  evidence: {},
}

// Runtime validation of operator-supplied plugin config. Mirrors the manifest `configSchema`
// (openclaw.plugin.json) as defense-in-depth — the host may validate too, but the adapter does not
// trust that. Each field defaults to DEFAULT_CONFIG when omitted; a present-but-invalid value fails.
const evidenceRuleSchema = z
  .object({
    key: z.string().min(1),
    path: z.array(z.string()).min(1),
    ttlSeconds: z.number().int().min(1).optional(),
  })
  .strict()

const adapterConfigSchema = z.object({
  helioBaseUrl: z
    .string()
    .refine((s) => URL.canParse(s), 'must be a valid URL')
    .default(DEFAULT_CONFIG.helioBaseUrl),
  tokenEnv: z.string().min(1).default(DEFAULT_CONFIG.tokenEnv),
  origin: z
    .string()
    .regex(/^[a-z0-9_-]{1,64}$/)
    .default(DEFAULT_CONFIG.origin),
  evaluateTimeoutMs: z.number().int().min(1).default(DEFAULT_CONFIG.evaluateTimeoutMs),
  evidence: z.record(z.string(), z.array(evidenceRuleSchema)).default({}),
})

/** Result of resolving plugin config. Fail-closed: the caller blocks all calls when `ok` is false. */
export type ParseConfigResult =
  | { readonly ok: true; readonly config: AdapterConfig }
  | { readonly ok: false; readonly error: string }

/**
 * Validate the host-provided plugin config (`api.pluginConfig`) into a resolved `AdapterConfig`.
 * `undefined`/`null` means no operator config → all defaults. Returns `{ ok: false }` (never throws)
 * on invalid input so the caller can fail closed by registering blocking hooks.
 */
export function parseConfig(raw: unknown): ParseConfigResult {
  const input = raw === undefined || raw === null ? {} : raw
  const parsed = adapterConfigSchema.safeParse(input)
  if (!parsed.success) {
    const error = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    return { ok: false, error }
  }

  const d = parsed.data
  // Rebuild evidence entries explicitly so optional `ttlSeconds` honors exactOptionalPropertyTypes.
  const evidence: Record<string, EvidenceRule[]> = {}
  for (const [toolName, rules] of Object.entries(d.evidence)) {
    evidence[toolName] = rules.map((rule) => ({
      key: rule.key,
      path: rule.path,
      ...(rule.ttlSeconds !== undefined ? { ttlSeconds: rule.ttlSeconds } : {}),
    }))
  }

  return {
    ok: true,
    config: {
      helioBaseUrl: d.helioBaseUrl,
      tokenEnv: d.tokenEnv,
      origin: d.origin,
      evaluateTimeoutMs: d.evaluateTimeoutMs,
      evidence,
    },
  }
}
