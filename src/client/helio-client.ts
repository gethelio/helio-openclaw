import type { AdapterConfig } from '../config.js'

// Token-bearing HTTP client for the Helio governance sideband.
//
// Contract (TODO, TDD): Bearer `HELIO_ADAPTER_TOKEN` on every call, never an `Origin` header,
// and **fail-closed** — `/evaluate` unreachable/timeout/5xx surfaces as a block, never a proceed.
export interface HelioClient {
  readonly config: AdapterConfig
  // TODO: evaluate(), audit(), installScan(), resolveApproval().
}

export function createHelioClient(config: AdapterConfig): HelioClient {
  return { config }
}
