import { describe, expect, it, vi } from 'vitest'
import { createHelioClient, type HelioClientConfig } from './helio-client.js'

const config: HelioClientConfig = {
  baseUrl: 'http://127.0.0.1:3200',
  token: 'test-adapter-token',
  origin: 'openclaw',
  evaluateTimeoutMs: 2000,
}

interface Captured {
  url: string
  init: RequestInit | undefined
  body: Record<string, unknown>
}

// Builds a client whose injected fetch returns `respond()` (or throws from it), while capturing
// the outbound request for assertions.
function setup(
  respond: () => Response | Promise<Response>,
  overrides: Partial<HelioClientConfig> = {},
) {
  const captured: Captured = { url: '', init: undefined, body: {} }
  const fetchImpl = vi.fn<typeof fetch>((url, init) => {
    captured.url = url as string
    captured.init = init
    if (typeof init?.body === 'string') {
      captured.body = JSON.parse(init.body) as Record<string, unknown>
    }
    return Promise.resolve(respond())
  })
  const client = createHelioClient({ ...config, ...overrides }, { fetch: fetchImpl })
  return { client, fetchImpl, captured }
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status })

const unreachable = (): Promise<Response> => Promise.reject(new Error('ECONNREFUSED'))

describe('helio client — evaluate fail-closed', () => {
  it('fails closed when the proxy is unreachable', async () => {
    const { client } = setup(unreachable)

    const outcome = await client.evaluate({ tool: { name: 'send_message' }, arguments: {} })

    expect(outcome.ok).toBe(false)
  })

  it('returns the decision on a 200 response', async () => {
    const body = { evaluation_id: 'eval-1', decision: 'allow' as const }
    const { client } = setup(() => jsonResponse(body))

    const outcome = await client.evaluate({ tool: { name: 'send_message' } })

    expect(outcome).toEqual({ ok: true, response: body })
  })

  it('fails closed on a 5xx response', async () => {
    const { client } = setup(() => jsonResponse({ error: 'boom' }, 503))

    const outcome = await client.evaluate({ tool: { name: 'send_message' } })

    expect(outcome.ok).toBe(false)
  })

  it('fails closed on a 4xx response (no valid decision to honor)', async () => {
    const { client } = setup(() => jsonResponse({ error: 'unauthorized' }, 401))

    const outcome = await client.evaluate({ tool: { name: 'send_message' } })

    expect(outcome.ok).toBe(false)
  })

  it('fails closed on a malformed /evaluate response', async () => {
    const { client } = setup(() => jsonResponse({ nonsense: true }))

    const outcome = await client.evaluate({ tool: { name: 'send_message' } })

    expect(outcome.ok).toBe(false)
  })

  it('sends the bearer token and JSON content-type, and never an Origin header', async () => {
    const { client, fetchImpl, captured } = setup(() =>
      jsonResponse({ evaluation_id: 'e', decision: 'allow' }),
    )

    await client.evaluate({ tool: { name: 'send_message' } })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const headers = new Headers(captured.init?.headers)
    expect(headers.get('authorization')).toBe('Bearer test-adapter-token')
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.has('origin')).toBe(false)
  })

  it('includes the configured origin in the /evaluate body', async () => {
    const { client, captured } = setup(() =>
      jsonResponse({ evaluation_id: 'e', decision: 'allow' }),
    )

    await client.evaluate({ tool: { name: 'send_message' }, arguments: { a: 1 } })

    expect(captured.body).toMatchObject({
      origin: 'openclaw',
      tool: { name: 'send_message' },
      arguments: { a: 1 },
    })
  })

  it('fails closed when /evaluate exceeds the timeout', async () => {
    // Slow fetch that only settles after 1s, unless the client aborts it first.
    const fetchImpl = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((resolve, reject) => {
          const slow = setTimeout(() => {
            resolve(jsonResponse({ evaluation_id: 'e', decision: 'allow' }))
          }, 1000)
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(slow)
            reject(new Error('aborted'))
          })
        }),
    )
    const client = createHelioClient({ ...config, evaluateTimeoutMs: 10 }, { fetch: fetchImpl })

    const outcome = await client.evaluate({ tool: { name: 'send_message' } })

    expect(outcome.ok).toBe(false)
  })
})

describe('helio client — audit', () => {
  it('returns ok and posts the audit body on 201', async () => {
    const { client, captured } = setup(() => jsonResponse({ ok: true }, 201))

    const outcome = await client.audit({
      evaluation_id: 'eval-1',
      status: 'success',
      duration_ms: 12,
    })

    expect(outcome.ok).toBe(true)
    expect(captured.body).toMatchObject({
      evaluation_id: 'eval-1',
      status: 'success',
      duration_ms: 12,
    })
  })

  it('treats a 200 already_finalized replay as success', async () => {
    const { client } = setup(() => jsonResponse({ already_finalized: true }))

    const outcome = await client.audit({ evaluation_id: 'eval-1', status: 'success' })

    expect(outcome.ok).toBe(true)
  })

  it('reports a soft failure on a 5xx (audit is best-effort, never thrown)', async () => {
    const { client } = setup(() => new Response('', { status: 500 }))

    const outcome = await client.audit({ evaluation_id: 'eval-1', status: 'success' })

    expect(outcome.ok).toBe(false)
  })

  it('reports a soft failure when the proxy is unreachable (never throws)', async () => {
    const { client } = setup(unreachable)

    const outcome = await client.audit({ evaluation_id: 'eval-1', status: 'success' })

    expect(outcome.ok).toBe(false)
  })
})

describe('helio client — installScan', () => {
  it('returns the install decision and posts origin + package on 200', async () => {
    const body = { evaluation_id: 'i1', decision: 'deny' as const, reason: 'blocked' }
    const { client, captured } = setup(() => jsonResponse(body))

    const outcome = await client.installScan({
      package: { name: 'left-pad', source: 'npm', version: '1.3.0' },
    })

    expect(outcome).toEqual({ ok: true, response: body })
    expect(captured.body).toMatchObject({
      origin: 'openclaw',
      package: { name: 'left-pad', source: 'npm' },
    })
  })

  it('fails closed on a 5xx response', async () => {
    const { client } = setup(() => new Response('', { status: 502 }))

    const outcome = await client.installScan({ package: { name: 'left-pad', source: 'npm' } })

    expect(outcome.ok).toBe(false)
  })

  it('fails closed on a malformed /install-scan response', async () => {
    const { client } = setup(() => jsonResponse({ nope: 1 }))

    const outcome = await client.installScan({ package: { name: 'left-pad', source: 'npm' } })

    expect(outcome.ok).toBe(false)
  })

  it('fails closed when the proxy is unreachable', async () => {
    const { client } = setup(unreachable)

    const outcome = await client.installScan({ package: { name: 'left-pad', source: 'npm' } })

    expect(outcome.ok).toBe(false)
  })

  it('fails closed when /install-scan exceeds the timeout', async () => {
    // install-scan is a gating call like /evaluate; a hung proxy must fail closed promptly,
    // not hang the install hook indefinitely.
    const fetchImpl = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((resolve, reject) => {
          const slow = setTimeout(() => {
            resolve(jsonResponse({ evaluation_id: 'i', decision: 'allow' }))
          }, 1000)
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(slow)
            reject(new Error('aborted'))
          })
        }),
    )
    const client = createHelioClient({ ...config, evaluateTimeoutMs: 10 }, { fetch: fetchImpl })

    const outcome = await client.installScan({ package: { name: 'left-pad', source: 'npm' } })

    expect(outcome.ok).toBe(false)
  })
})

describe('helio client — resolveApproval', () => {
  it('posts the resolution to /approval/:id/resolve and returns ok on 200', async () => {
    const { client, captured } = setup(() => jsonResponse({ ok: true }))

    const outcome = await client.resolveApproval('appr-9', {
      resolution: 'approved',
      resolved_by: 'telegram:@oli',
      scope: 'once',
    })

    expect(outcome.ok).toBe(true)
    expect(captured.url).toBe('http://127.0.0.1:3200/approval/appr-9/resolve')
    expect(captured.body).toMatchObject({
      resolution: 'approved',
      resolved_by: 'telegram:@oli',
      scope: 'once',
    })
  })

  it('reports a failure on a non-2xx response', async () => {
    const { client } = setup(() => new Response('', { status: 409 }))

    const outcome = await client.resolveApproval('appr-9', { resolution: 'denied' })

    expect(outcome.ok).toBe(false)
  })

  it('reports a failure when the proxy is unreachable', async () => {
    const { client } = setup(unreachable)

    const outcome = await client.resolveApproval('appr-9', { resolution: 'timeout' })

    expect(outcome.ok).toBe(false)
  })
})
