import { describe, expect, it, vi } from 'vitest'
import { createAfterToolCallHook } from './after-tool-call.js'
import { CorrelationRegistry } from '../correlation/registry.js'
import type { AuditOutcome, HelioClient } from '../client/helio-client.js'
import type { PluginHookAfterToolCallEvent, PluginHookToolContext } from '../types.js'

function makeClient(auditImpl?: HelioClient['audit']) {
  const audit = vi.fn<HelioClient['audit']>(auditImpl ?? (() => Promise.resolve({ ok: true })))
  const client: HelioClient = {
    evaluate: vi.fn<HelioClient['evaluate']>(() => Promise.resolve({ ok: false, reason: 'n/a' })),
    audit,
    installScan: vi.fn<HelioClient['installScan']>(() =>
      Promise.resolve({ ok: false, reason: 'n/a' }),
    ),
    resolveApproval: vi.fn<HelioClient['resolveApproval']>(() => Promise.resolve({ ok: true })),
  }
  return { client, audit }
}

// Pre-bind an evaluation in the registry so a matching after_tool_call can claim it.
function bind(
  registry: CorrelationRegistry,
  evaluationId: string,
  meta: Parameters<CorrelationRegistry['reserve']>[0],
) {
  const reservation = registry.reserve(meta)
  if (!reservation.ok) throw new Error('test setup: reserve failed')
  registry.bind(reservation.ticket, evaluationId)
}

const event = (over: Partial<PluginHookAfterToolCallEvent> = {}): PluginHookAfterToolCallEvent => ({
  toolName: 'send_message',
  params: { channel: '#general', text: 'hi' },
  ...over,
})

const ctx = (over: Partial<PluginHookToolContext> = {}): PluginHookToolContext => ({
  toolName: 'send_message',
  ...over,
})

describe('after_tool_call', () => {
  it('claims the evaluation_id and posts a success audit with result + duration', async () => {
    const { client, audit } = makeClient()
    const registry = new CorrelationRegistry()
    bind(registry, 'eval-1', { session: 'oc:s1', toolName: 'send_message', toolCallId: 'tc-1' })
    const hook = createAfterToolCallHook({ client, registry })

    await hook(
      event({ toolCallId: 'tc-1', result: { ok: true }, durationMs: 412 }),
      ctx({ sessionId: 's1', toolCallId: 'tc-1' }),
    )

    expect(audit).toHaveBeenCalledWith({
      evaluation_id: 'eval-1',
      status: 'success',
      duration_ms: 412,
      result: { ok: true },
    })
  })

  it('posts an error audit carrying the error message when event.error is set', async () => {
    const { client, audit } = makeClient()
    const registry = new CorrelationRegistry()
    bind(registry, 'eval-2', { session: 'oc:s1', toolName: 'send_message', toolCallId: 'tc-2' })
    const hook = createAfterToolCallHook({ client, registry })

    await hook(
      event({ toolCallId: 'tc-2', error: 'boom', durationMs: 7 }),
      ctx({ sessionId: 's1', toolCallId: 'tc-2' }),
    )

    expect(audit).toHaveBeenCalledWith({
      evaluation_id: 'eval-2',
      status: 'error',
      error: 'boom',
      duration_ms: 7,
    })
  })

  it('omits optional fields that are absent on the event', async () => {
    const { client, audit } = makeClient()
    const registry = new CorrelationRegistry()
    bind(registry, 'eval-3', { session: 'oc:s1', toolName: 'send_message', toolCallId: 'tc-3' })
    const hook = createAfterToolCallHook({ client, registry })

    await hook(event({ toolCallId: 'tc-3' }), ctx({ sessionId: 's1', toolCallId: 'tc-3' }))

    expect(audit).toHaveBeenCalledWith({ evaluation_id: 'eval-3', status: 'success' })
  })

  it('does not post when there is no correlated evaluation to audit (claim miss)', async () => {
    const { client, audit } = makeClient()
    const registry = new CorrelationRegistry()
    const hook = createAfterToolCallHook({ client, registry })

    await hook(
      event({ toolCallId: 'never-bound' }),
      ctx({ sessionId: 's1', toolCallId: 'never-bound' }),
    )

    expect(audit).not.toHaveBeenCalled()
  })

  it('claims the slot so a replayed after_tool_call no longer audits', async () => {
    const { client, audit } = makeClient()
    const registry = new CorrelationRegistry()
    bind(registry, 'eval-4', { session: 'oc:s1', toolName: 'send_message', toolCallId: 'tc-4' })
    const hook = createAfterToolCallHook({ client, registry })

    await hook(event({ toolCallId: 'tc-4' }), ctx({ sessionId: 's1', toolCallId: 'tc-4' }))
    await hook(event({ toolCallId: 'tc-4' }), ctx({ sessionId: 's1', toolCallId: 'tc-4' }))

    expect(audit).toHaveBeenCalledTimes(1)
  })

  it('never throws across the hook even when the audit call rejects (best-effort)', async () => {
    const { client } = makeClient((): Promise<AuditOutcome> => Promise.reject(new Error('network')))
    const registry = new CorrelationRegistry()
    bind(registry, 'eval-5', { session: 'oc:s1', toolName: 'send_message', toolCallId: 'tc-5' })
    const hook = createAfterToolCallHook({ client, registry })

    await expect(
      hook(event({ toolCallId: 'tc-5' }), ctx({ sessionId: 's1', toolCallId: 'tc-5' })),
    ).resolves.toBeUndefined()
  })
})

describe('after_tool_call evidence extraction', () => {
  it('attaches success-only evidence extracted from result by configured key paths', async () => {
    const { client, audit } = makeClient()
    const registry = new CorrelationRegistry()
    bind(registry, 'eval-e1', { session: 'oc:s1', toolName: 'send_email', toolCallId: 'tc-1' })
    const hook = createAfterToolCallHook({
      client,
      registry,
      evidence: {
        send_email: [
          { key: 'recipient', path: ['to'], ttlSeconds: 300 },
          { key: 'message_id', path: ['id'] },
        ],
      },
    })

    await hook(
      event({ toolName: 'send_email', toolCallId: 'tc-1', result: { to: 'a@b.com', id: 'm1' } }),
      ctx({ toolName: 'send_email', sessionId: 's1', toolCallId: 'tc-1' }),
    )

    expect(audit).toHaveBeenCalledWith({
      evaluation_id: 'eval-e1',
      status: 'success',
      result: { to: 'a@b.com', id: 'm1' },
      evidence: [
        { evidence_key: 'recipient', evidence_data: 'a@b.com', ttl_seconds: 300 },
        { evidence_key: 'message_id', evidence_data: 'm1' },
      ],
    })
  })

  it('walks nested paths and skips rules whose path is absent or runs through a non-object', async () => {
    const { client, audit } = makeClient()
    const registry = new CorrelationRegistry()
    bind(registry, 'eval-e2', { session: 'oc:s1', toolName: 'http_request', toolCallId: 'tc-2' })
    const hook = createAfterToolCallHook({
      client,
      registry,
      evidence: {
        http_request: [
          { key: 'host', path: ['url', 'host'] },
          { key: 'absent', path: ['url', 'missing'] },
          { key: 'through_scalar', path: ['status', 'deep'] },
        ],
      },
    })

    await hook(
      event({
        toolName: 'http_request',
        toolCallId: 'tc-2',
        result: { url: { host: 'example.com' }, status: 200 },
      }),
      ctx({ toolName: 'http_request', sessionId: 's1', toolCallId: 'tc-2' }),
    )

    const body = audit.mock.calls[0]?.[0]
    expect(body?.evidence).toEqual([{ evidence_key: 'host', evidence_data: 'example.com' }])
  })

  it('does not attach evidence on an error outcome (success-only)', async () => {
    const { client, audit } = makeClient()
    const registry = new CorrelationRegistry()
    bind(registry, 'eval-e3', { session: 'oc:s1', toolName: 'send_email', toolCallId: 'tc-3' })
    const hook = createAfterToolCallHook({
      client,
      registry,
      evidence: { send_email: [{ key: 'recipient', path: ['to'] }] },
    })

    await hook(
      event({
        toolName: 'send_email',
        toolCallId: 'tc-3',
        error: 'smtp down',
        result: { to: 'a@b.com' },
      }),
      ctx({ toolName: 'send_email', sessionId: 's1', toolCallId: 'tc-3' }),
    )

    expect(audit).toHaveBeenCalledWith({
      evaluation_id: 'eval-e3',
      status: 'error',
      error: 'smtp down',
      result: { to: 'a@b.com' },
    })
  })

  it('omits the evidence field entirely when no rule matches the tool', async () => {
    const { client, audit } = makeClient()
    const registry = new CorrelationRegistry()
    bind(registry, 'eval-e4', { session: 'oc:s1', toolName: 'send_message', toolCallId: 'tc-4' })
    const hook = createAfterToolCallHook({
      client,
      registry,
      evidence: { send_email: [{ key: 'recipient', path: ['to'] }] },
    })

    await hook(
      event({ toolCallId: 'tc-4', result: { to: 'a@b.com' } }),
      ctx({ sessionId: 's1', toolCallId: 'tc-4' }),
    )

    expect(audit).toHaveBeenCalledWith({
      evaluation_id: 'eval-e4',
      status: 'success',
      result: { to: 'a@b.com' },
    })
  })

  it('omits evidence when the result is absent even though rules are configured', async () => {
    const { client, audit } = makeClient()
    const registry = new CorrelationRegistry()
    bind(registry, 'eval-e5', { session: 'oc:s1', toolName: 'send_email', toolCallId: 'tc-5' })
    const hook = createAfterToolCallHook({
      client,
      registry,
      evidence: { send_email: [{ key: 'recipient', path: ['to'] }] },
    })

    await hook(
      event({ toolName: 'send_email', toolCallId: 'tc-5' }),
      ctx({ toolName: 'send_email', sessionId: 's1', toolCallId: 'tc-5' }),
    )

    expect(audit).toHaveBeenCalledWith({ evaluation_id: 'eval-e5', status: 'success' })
  })

  it('degrades to auditing without evidence when extraction throws (hostile result value)', async () => {
    const { client, audit } = makeClient()
    const registry = new CorrelationRegistry()
    bind(registry, 'eval-e6', { session: 'oc:s1', toolName: 'send_email', toolCallId: 'tc-6' })
    const hook = createAfterToolCallHook({
      client,
      registry,
      evidence: { send_email: [{ key: 'recipient', path: ['to'] }] },
    })

    // A tool-controlled result whose property access throws (getter/proxy) must not escape the
    // observational hook — the audit still posts, just without evidence.
    const hostile: Record<string, unknown> = {}
    Object.defineProperty(hostile, 'to', {
      enumerable: true,
      get() {
        throw new Error('hostile getter')
      },
    })

    await expect(
      hook(
        event({ toolName: 'send_email', toolCallId: 'tc-6', result: hostile }),
        ctx({ toolName: 'send_email', sessionId: 's1', toolCallId: 'tc-6' }),
      ),
    ).resolves.toBeUndefined()

    const body = audit.mock.calls[0]?.[0]
    expect(body?.evaluation_id).toBe('eval-e6')
    expect(body?.status).toBe('success')
    expect(body && 'evidence' in body).toBe(false)
  })

  it('omits a non-JSON-serializable result so the audit still finalizes (no lost audit)', async () => {
    const { client, audit } = makeClient()
    const registry = new CorrelationRegistry()
    bind(registry, 'eval-e7', { session: 'oc:s1', toolName: 'send_message', toolCallId: 'tc-7' })
    const hook = createAfterToolCallHook({ client, registry }) // no evidence rules

    // A result the real client's JSON.stringify cannot encode (BigInt) must not reach the client as
    // a body it would choke on — that throw is caught client-side and the POST never goes out,
    // losing the audit for a call that ran. The adapter drops the unserializable field instead.
    await hook(
      event({ toolCallId: 'tc-7', result: { ok: true, big: 10n }, durationMs: 9 }),
      ctx({ sessionId: 's1', toolCallId: 'tc-7' }),
    )

    const body = audit.mock.calls[0]?.[0]
    expect(body?.evaluation_id).toBe('eval-e7')
    expect(body?.status).toBe('success')
    expect(body?.duration_ms).toBe(9)
    expect(body && 'result' in body).toBe(false)
    expect(() => JSON.stringify(body)).not.toThrow()
  })

  it('drops only the unserializable field, keeping serializable evidence', async () => {
    const { client, audit } = makeClient()
    const registry = new CorrelationRegistry()
    bind(registry, 'eval-e8', { session: 'oc:s1', toolName: 'send_email', toolCallId: 'tc-8' })
    const hook = createAfterToolCallHook({
      client,
      registry,
      evidence: { send_email: [{ key: 'recipient', path: ['to'] }] },
    })

    // `result` carries an unserializable field (`junk`) that no rule extracts, while the extracted
    // evidence (`to`) is a plain string. The result drops; the serializable evidence is kept.
    await hook(
      event({ toolName: 'send_email', toolCallId: 'tc-8', result: { to: 'a@b.com', junk: 10n } }),
      ctx({ toolName: 'send_email', sessionId: 's1', toolCallId: 'tc-8' }),
    )

    const body = audit.mock.calls[0]?.[0]
    expect(body && 'result' in body).toBe(false)
    expect(body?.evidence).toEqual([{ evidence_key: 'recipient', evidence_data: 'a@b.com' }])
    expect(() => JSON.stringify(body)).not.toThrow()
  })

  it('hands the client a stable snapshot, not the live result (no serialize-twice TOCTOU)', async () => {
    const { client, audit } = makeClient()
    const registry = new CorrelationRegistry()
    bind(registry, 'eval-e9', { session: 'oc:s1', toolName: 'send_message', toolCallId: 'tc-9' })
    const hook = createAfterToolCallHook({ client, registry })

    // A non-deterministic getter: serializable on the FIRST read, throws on the SECOND. A
    // probe-then-resend design passes the probe and throws on the client's later JSON.stringify,
    // losing the audit. Snapshotting once must hand the client a plain value it can re-serialize.
    let reads = 0
    const flaky: Record<string, unknown> = {}
    Object.defineProperty(flaky, 'x', {
      enumerable: true,
      get() {
        reads += 1
        if (reads > 1) throw new Error('second read throws')
        return 'ok'
      },
    })

    await hook(
      event({ toolCallId: 'tc-9', result: flaky }),
      ctx({ sessionId: 's1', toolCallId: 'tc-9' }),
    )

    const body = audit.mock.calls[0]?.[0]
    expect(body?.result).toEqual({ x: 'ok' })
    // The body the client receives must survive (re-)serialization — i.e. it is not the live getter.
    expect(() => JSON.stringify(body)).not.toThrow()
  })

  it('filters evidence per entry, keeping good entries when one is unserializable', async () => {
    const { client, audit } = makeClient()
    const registry = new CorrelationRegistry()
    bind(registry, 'eval-e10', { session: 'oc:s1', toolName: 'send_email', toolCallId: 'tc-10' })
    const hook = createAfterToolCallHook({
      client,
      registry,
      evidence: {
        send_email: [
          { key: 'recipient', path: ['to'] },
          { key: 'count', path: ['big'] },
        ],
      },
    })

    // `big` extracts a BigInt (unserializable) — that one entry drops; `recipient` survives.
    await hook(
      event({ toolName: 'send_email', toolCallId: 'tc-10', result: { to: 'a@b.com', big: 10n } }),
      ctx({ toolName: 'send_email', sessionId: 's1', toolCallId: 'tc-10' }),
    )

    const body = audit.mock.calls[0]?.[0]
    expect(body?.evidence).toEqual([{ evidence_key: 'recipient', evidence_data: 'a@b.com' }])
    expect(() => JSON.stringify(body)).not.toThrow()
  })

  // The sideband rejects bodies over 1 MiB (docs/adapter-api.md), so an oversized optional field
  // must not 413 the mandatory audit for a call that ran. Drop result first, then trim evidence.
  const overOneMiB = 'x'.repeat(1_100_000)

  it('drops an oversized result before evidence so the audit body fits the budget', async () => {
    const { client, audit } = makeClient()
    const registry = new CorrelationRegistry()
    bind(registry, 'eval-e11', { session: 'oc:s1', toolName: 'send_email', toolCallId: 'tc-11' })
    const hook = createAfterToolCallHook({
      client,
      registry,
      evidence: { send_email: [{ key: 'recipient', path: ['to'] }] },
    })

    // result is > 1 MiB; the extracted evidence is tiny. Dropping result alone brings it under budget.
    await hook(
      event({
        toolName: 'send_email',
        toolCallId: 'tc-11',
        result: { to: 'a@b.com', blob: overOneMiB },
      }),
      ctx({ toolName: 'send_email', sessionId: 's1', toolCallId: 'tc-11' }),
    )

    const body = audit.mock.calls[0]?.[0]
    expect(body?.evaluation_id).toBe('eval-e11')
    expect(body?.status).toBe('success')
    expect(body && 'result' in body).toBe(false)
    expect(body?.evidence).toEqual([{ evidence_key: 'recipient', evidence_data: 'a@b.com' }])
    expect(new TextEncoder().encode(JSON.stringify(body)).length).toBeLessThanOrEqual(1_048_576)
  })

  it('trims oversized evidence down to the core so the audit still finalizes', async () => {
    const { client, audit } = makeClient()
    const registry = new CorrelationRegistry()
    bind(registry, 'eval-e12', { session: 'oc:s1', toolName: 'send_email', toolCallId: 'tc-12' })
    const hook = createAfterToolCallHook({
      client,
      registry,
      evidence: { send_email: [{ key: 'blob', path: ['big'] }] },
    })

    // The single evidence entry is itself > 1 MiB; after dropping result, evidence must be trimmed
    // too, leaving the always-serializable core to finalize.
    await hook(
      event({ toolName: 'send_email', toolCallId: 'tc-12', result: { big: overOneMiB } }),
      ctx({ toolName: 'send_email', sessionId: 's1', toolCallId: 'tc-12' }),
    )

    const body = audit.mock.calls[0]?.[0]
    expect(body?.evaluation_id).toBe('eval-e12')
    expect(body?.status).toBe('success')
    expect(body && 'result' in body).toBe(false)
    expect(body && 'evidence' in body).toBe(false)
    expect(new TextEncoder().encode(JSON.stringify(body)).length).toBeLessThanOrEqual(1_048_576)
  })

  it('truncates an oversized error so the core audit still finalizes under budget', async () => {
    const { client, audit } = makeClient()
    const registry = new CorrelationRegistry()
    bind(registry, 'eval-e13', { session: 'oc:s1', toolName: 'send_message', toolCallId: 'tc-13' })
    const hook = createAfterToolCallHook({ client, registry })

    // `error` is optional in the wire contract, so an oversized error message must not keep the
    // body over budget and 413 the audit — it is truncated (UTF-8 safe, with a marker) to fit.
    await hook(
      event({ toolCallId: 'tc-13', error: 'e'.repeat(1_200_000), durationMs: 3 }),
      ctx({ sessionId: 's1', toolCallId: 'tc-13' }),
    )

    const body = audit.mock.calls[0]?.[0]
    expect(body?.evaluation_id).toBe('eval-e13')
    expect(body?.status).toBe('error')
    expect(body?.duration_ms).toBe(3)
    expect(typeof body?.error).toBe('string')
    expect(body?.error?.endsWith('...[truncated]')).toBe(true)
    expect(new TextEncoder().encode(JSON.stringify(body)).length).toBeLessThanOrEqual(1_048_576)
  })

  it('does not split a multi-byte code point when truncating an oversized error', async () => {
    const { client, audit } = makeClient()
    const registry = new CorrelationRegistry()
    bind(registry, 'eval-e14', { session: 'oc:s1', toolName: 'send_message', toolCallId: 'tc-14' })
    const hook = createAfterToolCallHook({ client, registry })

    // '😀' is 4 UTF-8 bytes; a naive byte cut could leave a lone surrogate / replacement char.
    await hook(
      event({ toolCallId: 'tc-14', error: '😀'.repeat(400_000) }),
      ctx({ sessionId: 's1', toolCallId: 'tc-14' }),
    )

    const body = audit.mock.calls[0]?.[0]
    const error = body?.error ?? ''
    expect(error.endsWith('...[truncated]')).toBe(true)
    // The kept prefix is whole emoji only — no U+FFFD replacement char from a split sequence.
    expect(error).not.toContain('�')
    expect(new TextEncoder().encode(JSON.stringify(body)).length).toBeLessThanOrEqual(1_048_576)
  })
})
