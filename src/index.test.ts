import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import definition from './index.js'
import type { AuditRequest } from './client/helio-client.js'
import type {
  OpenClawPluginApi,
  PluginHookAfterToolCallEvent,
  PluginHookBeforeInstallResult,
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookToolContext,
} from './types.js'

const TOKEN_ENV = 'HELIO_ADAPTER_TOKEN'

interface Harness {
  readonly handlers: Map<string, unknown>
  readonly on: ReturnType<typeof vi.fn>
  readonly logger: {
    error: ReturnType<typeof vi.fn>
    warn: ReturnType<typeof vi.fn>
    info: ReturnType<typeof vi.fn>
  }
  readonly api: OpenClawPluginApi
}

function harness(pluginConfig: unknown): Harness {
  const handlers = new Map<string, unknown>()
  const on = vi.fn((name: string, handler: unknown) => {
    handlers.set(name, handler)
  })
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() }
  const api = { on, logger, pluginConfig } as unknown as OpenClawPluginApi
  return { handlers, on, logger, api }
}

const beforeHook = (h: Harness) =>
  h.handlers.get('before_tool_call') as (
    event: PluginHookBeforeToolCallEvent,
    ctx: PluginHookToolContext,
  ) => Promise<PluginHookBeforeToolCallResult> | PluginHookBeforeToolCallResult

const afterHook = (h: Harness) =>
  h.handlers.get('after_tool_call') as (
    event: PluginHookAfterToolCallEvent,
    ctx: PluginHookToolContext,
  ) => Promise<void>

// In degraded mode the install gate ignores its arguments and always blocks.
const installHook = (h: Harness) =>
  h.handlers.get('before_install') as () => PluginHookBeforeInstallResult

let savedToken: string | undefined

beforeEach(() => {
  savedToken = process.env[TOKEN_ENV]
})

afterEach(() => {
  if (savedToken === undefined) Reflect.deleteProperty(process.env, TOKEN_ENV)
  else process.env[TOKEN_ENV] = savedToken
  vi.unstubAllGlobals()
})

describe('plugin definition', () => {
  it('registers the three governance hooks when configured with a token', () => {
    process.env[TOKEN_ENV] = 'tok'
    const h = harness({})

    expect(definition.id).toBe('helio')
    definition.register?.(h.api)

    expect(h.on.mock.calls.map((call) => call[0] as string)).toStrictEqual([
      'before_tool_call',
      'after_tool_call',
      'before_install',
    ])
  })

  it('fails closed (blocks all tool calls) when the adapter token is missing', () => {
    Reflect.deleteProperty(process.env, TOKEN_ENV)
    const h = harness({})

    definition.register?.(h.api)

    const result = beforeHook(h)(
      { toolName: 'send_message', params: {} },
      { toolName: 'send_message' },
    )
    expect(result).toEqual({ block: true, blockReason: 'Helio governance misconfigured' })
    // installs are gated too — governance misconfig must not let an install through
    expect(installHook(h)()).toEqual({ block: true, blockReason: 'Helio governance misconfigured' })
    expect(h.logger.error).toHaveBeenCalledOnce()
    // no audit path in degraded mode — only the blocking gates are registered
    expect(h.handlers.has('after_tool_call')).toBe(false)
  })

  it('fails closed when the plugin config is invalid', () => {
    process.env[TOKEN_ENV] = 'tok'
    const h = harness({ origin: 'Not A Valid Origin!' })

    definition.register?.(h.api)

    const result = beforeHook(h)(
      { toolName: 'send_message', params: {} },
      { toolName: 'send_message' },
    )
    expect(result).toEqual({ block: true, blockReason: 'Helio governance misconfigured' })
    expect(h.logger.error).toHaveBeenCalledOnce()
  })

  it('passes configured evidence rules end-to-end into the /audit body', async () => {
    process.env[TOKEN_ENV] = 'tok'
    const auditBodies: AuditRequest[] = []
    const fetchMock = vi.fn((input: string | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/evaluate')) {
        return Promise.resolve(
          new Response(JSON.stringify({ evaluation_id: 'ev1', decision: 'allow' }), {
            status: 200,
          }),
        )
      }
      if (url.endsWith('/audit')) {
        const body = init?.body as string | undefined
        auditBodies.push(JSON.parse(body ?? '{}') as AuditRequest)
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      }
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    const h = harness({ evidence: { send_email: [{ key: 'recipient', path: ['to'] }] } })
    definition.register?.(h.api)

    const ctx: PluginHookToolContext = {
      toolName: 'send_email',
      sessionId: 's1',
      toolCallId: 'tc1',
    }
    await beforeHook(h)(
      { toolName: 'send_email', params: { to: 'a@b.com' }, toolCallId: 'tc1' },
      ctx,
    )
    await afterHook(h)(
      { toolName: 'send_email', params: {}, toolCallId: 'tc1', result: { to: 'a@b.com' } },
      ctx,
    )

    expect(auditBodies).toHaveLength(1)
    expect(auditBodies[0]?.evidence).toEqual([
      { evidence_key: 'recipient', evidence_data: 'a@b.com' },
    ])
  })
})
