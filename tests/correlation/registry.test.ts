import { describe, expect, it } from 'vitest'
import { CorrelationRegistry } from '../../src/correlation/registry.js'

describe('CorrelationRegistry', () => {
  it('binds and claims an evaluation by toolCallId', () => {
    const reg = new CorrelationRegistry()

    const r = reg.reserve({ toolCallId: 'tc-1', session: 'oc:s1', toolName: 'send' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    reg.bind(r.ticket, 'eval-1')

    expect(reg.claim({ toolCallId: 'tc-1', session: 'oc:s1', toolName: 'send' })).toBe('eval-1')
  })

  it('binds and claims by runId when no toolCallId is present', () => {
    const reg = new CorrelationRegistry()
    const r = reg.reserve({ runId: 'run-1', session: 'oc:s1', toolName: 'send' })
    if (!r.ok) throw new Error('reserve failed')
    reg.bind(r.ticket, 'eval-2')

    expect(reg.claim({ runId: 'run-1', session: 'oc:s1', toolName: 'send' })).toBe('eval-2')
  })

  it('prefers toolCallId over runId for the correlation key', () => {
    const reg = new CorrelationRegistry()
    const r = reg.reserve({
      toolCallId: 'tc-1',
      runId: 'run-1',
      session: 'oc:s1',
      toolName: 'send',
    })
    if (!r.ok) throw new Error('reserve failed')
    reg.bind(r.ticket, 'eval-3')

    expect(
      reg.claim({ toolCallId: 'tc-1', runId: 'run-1', session: 'oc:s1', toolName: 'send' }),
    ).toBe('eval-3')
  })

  it('binds and claims via the no-ID lane keyed by (session, toolName)', () => {
    const reg = new CorrelationRegistry()
    const r = reg.reserve({ session: 'oc:s1', toolName: 'send' })
    if (!r.ok) throw new Error('reserve failed')
    reg.bind(r.ticket, 'eval-4')

    expect(reg.claim({ session: 'oc:s1', toolName: 'send' })).toBe('eval-4')
  })

  it('claim removes the entry — a second claim returns undefined', () => {
    const reg = new CorrelationRegistry()
    const r = reg.reserve({ toolCallId: 'tc-1', session: 'oc:s1', toolName: 'send' })
    if (!r.ok) throw new Error('reserve failed')
    reg.bind(r.ticket, 'eval-1')
    reg.claim({ toolCallId: 'tc-1', session: 'oc:s1', toolName: 'send' })

    expect(reg.claim({ toolCallId: 'tc-1', session: 'oc:s1', toolName: 'send' })).toBeUndefined()
  })

  describe('no-ID lane fail-closed on ambiguity', () => {
    it('rejects a second concurrent untracked call for the same (session, toolName)', () => {
      const reg = new CorrelationRegistry()

      const first = reg.reserve({ session: 'oc:s1', toolName: 'send' })
      const second = reg.reserve({ session: 'oc:s1', toolName: 'send' })

      expect(first.ok).toBe(true)
      expect(second).toEqual({ ok: false, reason: 'ambiguous' })
      expect(reg.stats.ambiguityBlocks).toBe(1)
      expect(reg.stats.noIdLaneUses).toBe(1)
    })

    it('does not treat different sessions or tools as ambiguous', () => {
      const reg = new CorrelationRegistry()
      expect(reg.reserve({ session: 'oc:s1', toolName: 'send' }).ok).toBe(true)
      expect(reg.reserve({ session: 'oc:s2', toolName: 'send' }).ok).toBe(true)
      expect(reg.reserve({ session: 'oc:s1', toolName: 'other' }).ok).toBe(true)
    })

    it('frees the no-ID slot after release, allowing a fresh reserve', () => {
      const reg = new CorrelationRegistry()
      const r = reg.reserve({ session: 'oc:s1', toolName: 'send' })
      if (!r.ok) throw new Error('reserve failed')
      reg.release(r.ticket)

      expect(reg.reserve({ session: 'oc:s1', toolName: 'send' }).ok).toBe(true)
    })

    it('does not apply the ambiguity block to the toolCallId lane (per-call ids → full concurrency)', () => {
      const reg = new CorrelationRegistry()
      expect(reg.reserve({ toolCallId: 'tc-1', session: 'oc:s1', toolName: 'send' }).ok).toBe(true)
      expect(reg.reserve({ toolCallId: 'tc-2', session: 'oc:s1', toolName: 'send' }).ok).toBe(true)
    })
  })

  describe('runId lane fail-closed on ambiguity (runId is per-turn, not per-call)', () => {
    it('blocks a second call with the same runId and no toolCallId', () => {
      const reg = new CorrelationRegistry()

      const first = reg.reserve({ runId: 'run-1', session: 'oc:s1', toolName: 'send' })
      const second = reg.reserve({ runId: 'run-1', session: 'oc:s1', toolName: 'send' })

      expect(first.ok).toBe(true)
      expect(second).toEqual({ ok: false, reason: 'ambiguous' })
      expect(reg.stats.ambiguityBlocks).toBe(1)
    })

    it('does not block distinct runIds', () => {
      const reg = new CorrelationRegistry()
      expect(reg.reserve({ runId: 'run-1', session: 'oc:s1', toolName: 'send' }).ok).toBe(true)
      expect(reg.reserve({ runId: 'run-2', session: 'oc:s1', toolName: 'send' }).ok).toBe(true)
    })

    it('frees the runId slot after claim, allowing the next sequential call in the turn', () => {
      const reg = new CorrelationRegistry()
      const r = reg.reserve({ runId: 'run-1', session: 'oc:s1', toolName: 'send' })
      if (!r.ok) throw new Error('reserve failed')
      reg.bind(r.ticket, 'eval-1')
      reg.claim({ runId: 'run-1', session: 'oc:s1', toolName: 'send' })

      expect(reg.reserve({ runId: 'run-1', session: 'oc:s1', toolName: 'send' }).ok).toBe(true)
    })
  })

  describe('TTL eviction', () => {
    it('evicts an unclaimed entry after the TTL and frees its no-ID slot', () => {
      let clock = 0
      const reg = new CorrelationRegistry({ ttlMs: 1000, now: () => clock })
      const r = reg.reserve({ session: 'oc:s1', toolName: 'send' })
      if (!r.ok) throw new Error('reserve failed')
      reg.bind(r.ticket, 'eval-1')

      clock = 1001
      expect(reg.claim({ session: 'oc:s1', toolName: 'send' })).toBeUndefined()
      expect(reg.reserve({ session: 'oc:s1', toolName: 'send' }).ok).toBe(true)
    })
  })
})
