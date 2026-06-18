/**
 * Correlates a `before_tool_call` evaluation with its later `after_tool_call`, binding an
 * `evaluation_id` by the key chain `toolCallId` → `runId` → a no-ID lane keyed by
 * `(session, toolName)`. Only `toolCallId` is a per-call-unique key (full concurrency). `runId`
 * is *per-turn* (shared by every tool call in one agent turn) and the no-ID lane is keyed by
 * `(session, toolName)`; both can collide, so both are fail-closed on ambiguity — a concurrent
 * second call is rejected, not mis-bound. Unclaimed entries are evicted after a bounded TTL so a
 * stuck slot can't leak or block forever.
 */
export interface CorrelationMeta {
  readonly toolCallId?: string
  readonly runId?: string
  readonly session: string
  readonly toolName: string
}

export type ReserveResult = { ok: true; ticket: string } | { ok: false; reason: 'ambiguous' }

export interface CorrelationRegistryOptions {
  /** How long an unclaimed entry lives before eviction (default 10 minutes, matching Helio). */
  readonly ttlMs?: number
  /** Clock injection for tests. */
  readonly now?: () => number
}

/** Telemetry counters: no-ID-lane usage and ambiguity blocks. */
export interface CorrelationStats {
  readonly noIdLaneUses: number
  readonly ambiguityBlocks: number
}

interface PendingEntry {
  evaluationId: string | undefined
  expiresAt: number
}

// 'toolCall' is per-call-unique (full concurrency); 'run' and 'none' can collide → fail closed.
type Lane = 'toolCall' | 'run' | 'none'

function keyOf(meta: CorrelationMeta): { key: string; lane: Lane } {
  if (meta.toolCallId !== undefined) return { key: `tc:${meta.toolCallId}`, lane: 'toolCall' }
  if (meta.runId !== undefined) return { key: `run:${meta.runId}`, lane: 'run' }
  // JSON-encode the pair so `(session, toolName)` is unambiguous across odd names.
  return { key: `noid:${JSON.stringify([meta.session, meta.toolName])}`, lane: 'none' }
}

export class CorrelationRegistry {
  private readonly pending = new Map<string, PendingEntry>()
  private readonly ttlMs: number
  private readonly now: () => number
  private lastSweepAt: number
  private noIdLaneUses = 0
  private ambiguityBlocks = 0

  constructor(options: CorrelationRegistryOptions = {}) {
    this.ttlMs = options.ttlMs ?? 600_000
    this.now = options.now ?? Date.now
    this.lastSweepAt = this.now()
  }

  /** Number of pending (reserved, not-yet-claimed) entries — telemetry + leak guard. */
  get size(): number {
    return this.pending.size
  }

  /** Reserve a slot before calling `/evaluate`. Rejects a concurrent non-unique-keyed call. */
  reserve(meta: CorrelationMeta): ReserveResult {
    const { key, lane } = keyOf(meta)

    // Lazy per-key eviction only reclaims a key that is touched again; a per-call-unique key
    // (toolCallId) whose after_tool_call never arrives is never re-touched and would leak. Sweep
    // expired entries periodically (at most once per ttl) so memory stays bounded without a timer.
    this.maybeSweep()

    const existing = this.pending.get(key)
    if (existing && this.isExpired(existing)) this.pending.delete(key)

    // Only the toolCallId lane is keyed by a per-call-unique id; runId (per-turn) and the no-ID
    // lane can collide, so a live entry there means we cannot disambiguate → fail closed.
    if (lane !== 'toolCall' && this.pending.has(key)) {
      this.ambiguityBlocks++
      return { ok: false, reason: 'ambiguous' }
    }

    this.pending.set(key, { evaluationId: undefined, expiresAt: this.now() + this.ttlMs })
    if (lane === 'none') this.noIdLaneUses++
    return { ok: true, ticket: key }
  }

  /** Bind the resolved `evaluation_id` to a reserved slot (after `/evaluate` returns). */
  bind(ticket: string, evaluationId: string): void {
    const entry = this.pending.get(ticket)
    if (entry) entry.evaluationId = evaluationId
  }

  /** Release a reserved slot (e.g. when `/evaluate` failed closed) so the lane frees up. */
  release(ticket: string): void {
    this.pending.delete(ticket)
  }

  /** Claim the `evaluation_id` for an `after_tool_call`. Returns undefined if unknown/expired. */
  claim(meta: CorrelationMeta): string | undefined {
    const { key } = keyOf(meta)
    const entry = this.pending.get(key)
    if (!entry) return undefined
    this.pending.delete(key)
    if (this.isExpired(entry)) return undefined
    return entry.evaluationId
  }

  get stats(): CorrelationStats {
    return { noIdLaneUses: this.noIdLaneUses, ambiguityBlocks: this.ambiguityBlocks }
  }

  private isExpired(entry: PendingEntry): boolean {
    return this.now() >= entry.expiresAt
  }

  // Evict all expired entries, but at most once per TTL window so the O(n) scan is amortized away
  // under load. Growth only happens via reserve(), so sweeping there bounds the map.
  private maybeSweep(): void {
    const now = this.now()
    if (now - this.lastSweepAt < this.ttlMs) return
    for (const [key, entry] of this.pending) {
      if (now >= entry.expiresAt) this.pending.delete(key)
    }
    this.lastSweepAt = now
  }
}
