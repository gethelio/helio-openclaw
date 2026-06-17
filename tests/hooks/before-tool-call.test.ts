import { describe, expect, it, vi } from 'vitest'
import { createBeforeToolCallHook } from '../../src/hooks/before-tool-call.js'
import { CorrelationRegistry } from '../../src/correlation/registry.js'
import type { EvaluateOutcome, HelioClient } from '../../src/client/helio-client.js'
import type { PluginHookBeforeToolCallEvent, PluginHookToolContext } from '../../src/types.js'

function setup(outcome: EvaluateOutcome) {
  const evaluate = vi.fn<HelioClient['evaluate']>(() => Promise.resolve(outcome))
  const resolveApproval = vi.fn<HelioClient['resolveApproval']>(() => Promise.resolve({ ok: true }))
  const client: HelioClient = {
    evaluate,
    audit: vi.fn<HelioClient['audit']>(() => Promise.resolve({ ok: true })),
    installScan: vi.fn<HelioClient['installScan']>(() =>
      Promise.resolve({ ok: false, reason: 'n/a' }),
    ),
    resolveApproval,
  }
  const registry = new CorrelationRegistry()
  const hook = createBeforeToolCallHook({ client, registry, origin: 'openclaw' })
  return { hook, registry, evaluate, resolveApproval }
}

const event = (
  over: Partial<PluginHookBeforeToolCallEvent> = {},
): PluginHookBeforeToolCallEvent => ({
  toolName: 'send_message',
  params: { channel: '#general', text: 'hi' },
  ...over,
})

const ctx = (over: Partial<PluginHookToolContext> = {}): PluginHookToolContext => ({
  toolName: 'send_message',
  ...over,
})

describe('before_tool_call', () => {
  it('allows the call and posts an evaluate request built from event + ctx', async () => {
    const { hook, evaluate } = setup({
      ok: true,
      response: { evaluation_id: 'e1', decision: 'allow' },
    })

    const result = await hook(
      event({ toolCallId: 'tc-1' }),
      ctx({ agentId: 'main', sessionId: 'sess-1', channelId: 'C1', toolCallId: 'tc-1' }),
    )

    expect(result).toEqual({})
    expect(evaluate).toHaveBeenCalledWith({
      tool: { name: 'send_message' },
      arguments: { channel: '#general', text: 'hi' },
      agent_id: 'main',
      session_id: 'oc:sess-1',
      metadata: { channel_id: 'C1' },
    })
  })

  it('blocks a deny decision with the feedback message', async () => {
    const { hook } = setup({
      ok: true,
      response: { evaluation_id: 'e', decision: 'deny', feedback: { message: 'Not allowed' } },
    })

    const result = await hook(event(), ctx({ sessionId: 's1' }))

    expect(result).toEqual({ block: true, blockReason: 'Not allowed' })
  })

  it('blocks rate_limited using the reason when there is no feedback message', async () => {
    const { hook } = setup({
      ok: true,
      response: { evaluation_id: 'e', decision: 'rate_limited', reason: 'Rate limit hit' },
    })

    const result = await hook(event(), ctx({ sessionId: 's1' }))

    expect(result).toEqual({ block: true, blockReason: 'Rate limit hit' })
  })

  it('blocks dry_run with a [dry-run] prefix', async () => {
    const { hook } = setup({
      ok: true,
      response: { evaluation_id: 'e', decision: 'dry_run', feedback: { message: 'would forward' } },
    })

    const result = await hook(event(), ctx({ sessionId: 's1' }))

    expect(result).toEqual({ block: true, blockReason: '[dry-run] would forward' })
  })

  it('releases the correlation slot on a terminal block', async () => {
    const { hook, registry } = setup({
      ok: true,
      response: { evaluation_id: 'e', decision: 'deny' },
    })

    await hook(event(), ctx({ sessionId: 's1' }))

    // slot freed → a fresh no-ID reserve for the same (session, tool) succeeds
    expect(registry.reserve({ session: 'oc:s1', toolName: 'send_message' }).ok).toBe(true)
  })

  it('returns a require_approval card with locally-derived text', async () => {
    const { hook } = setup({
      ok: true,
      response: {
        evaluation_id: 'e',
        decision: 'require_approval',
        feedback: { message: 'Needs sign-off' },
        approval: { id: 'appr-1', timeout_ms: 30000 },
      },
    })

    const result = await hook(event({ toolName: 'send_email' }), ctx({ agentId: 'main' }))

    expect(result.requireApproval).toMatchObject({
      title: 'Approve "send_email"?',
      description: 'Needs sign-off',
      severity: 'warning',
      timeoutBehavior: 'deny',
      timeoutMs: 30000,
    })
    expect(typeof result.requireApproval?.onResolution).toBe('function')
  })

  it('onResolution maps allow-once to approved/scope:once and posts resolved_by', async () => {
    const { hook, resolveApproval } = setup({
      ok: true,
      response: { evaluation_id: 'e', decision: 'require_approval', approval: { id: 'appr-1' } },
    })

    const result = await hook(event(), ctx({ agentId: 'main' }))
    await result.requireApproval?.onResolution?.('allow-once')

    expect(resolveApproval).toHaveBeenCalledWith('appr-1', {
      resolution: 'approved',
      scope: 'once',
      resolved_by: 'openclaw:main',
    })
  })

  it('onResolution maps deny to denied (no scope)', async () => {
    const { hook, resolveApproval } = setup({
      ok: true,
      response: { evaluation_id: 'e', decision: 'require_approval', approval: { id: 'appr-1' } },
    })

    const result = await hook(event(), ctx())
    await result.requireApproval?.onResolution?.('deny')

    expect(resolveApproval).toHaveBeenCalledWith('appr-1', {
      resolution: 'denied',
      resolved_by: 'openclaw',
    })
  })

  // NOTE: the throw is a best-effort signal — the host only logs it (see hook comment), it does
  // not gate execution. The test asserts the adapter surfaces the failure rather than swallowing it.
  it('onResolution surfaces a failed approval-resolution recording (does not swallow it)', async () => {
    const { hook, resolveApproval } = setup({
      ok: true,
      response: { evaluation_id: 'e', decision: 'require_approval', approval: { id: 'appr-1' } },
    })
    resolveApproval.mockResolvedValue({ ok: false, reason: 'sideband down' })

    const result = await hook(event(), ctx())

    await expect(result.requireApproval?.onResolution?.('allow-once')).rejects.toThrow(
      /could not record/i,
    )
  })

  it('fails closed and releases the reservation when evaluate fails', async () => {
    const { hook, registry } = setup({ ok: false, reason: 'down' })

    const result = await hook(event(), ctx({ sessionId: 's1' }))

    expect(result).toEqual({ block: true, blockReason: 'Helio governance unavailable' })
    expect(registry.reserve({ session: 'oc:s1', toolName: 'send_message' }).ok).toBe(true)
  })

  it('blocks a second concurrent untracked call (no-ID ambiguity)', async () => {
    const { hook } = setup({ ok: true, response: { evaluation_id: 'e', decision: 'allow' } })
    const e = event()
    const c = ctx({ sessionId: 's1' })

    const first = hook(e, c) // reserves the no-ID slot synchronously, then awaits evaluate
    const second = await hook(e, c) // its reserve sees the slot taken → ambiguous

    expect(second).toEqual({
      block: true,
      blockReason: 'Helio cannot correlate ambiguous concurrent tool calls',
    })
    await first
  })
})
