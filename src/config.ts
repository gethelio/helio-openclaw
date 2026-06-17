// Resolved adapter configuration. Mirrors the manifest `configSchema` in openclaw.plugin.json.
export interface AdapterConfig {
  helioBaseUrl: string
  tokenEnv: string
  origin: string
  evaluateTimeoutMs: number
}

export const DEFAULT_CONFIG: AdapterConfig = {
  helioBaseUrl: 'http://127.0.0.1:3200',
  tokenEnv: 'HELIO_ADAPTER_TOKEN',
  origin: 'openclaw',
  evaluateTimeoutMs: 2000,
}

// TODO: validate the raw plugin config against the manifest schema and resolve the
// bearer token from `process.env[tokenEnv]`. Real validation lands with the config.ts TDD.
export function parseConfig(_raw: unknown): AdapterConfig {
  return { ...DEFAULT_CONFIG }
}
