import { describe, expect, it, vi } from 'vitest'
import { createHelioClient, type HelioClientConfig } from '../../src/client/helio-client.js'

const config: HelioClientConfig = {
  baseUrl: 'http://127.0.0.1:3200',
  token: 'test-adapter-token',
  origin: 'openclaw',
  evaluateTimeoutMs: 2000,
}

describe('helio client — evaluate fail-closed', () => {
  it('fails closed when the proxy is unreachable', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.reject(new Error('ECONNREFUSED')))
    const client = createHelioClient(config, { fetch: fetchImpl })

    const outcome = await client.evaluate({ tool: { name: 'send_message' }, arguments: {} })

    expect(outcome.ok).toBe(false)
  })

  it('returns the decision on a 200 response', async () => {
    const body = { evaluation_id: 'eval-1', decision: 'allow' as const }
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )
    const client = createHelioClient(config, { fetch: fetchImpl })

    const outcome = await client.evaluate({ tool: { name: 'send_message' } })

    expect(outcome).toEqual({ ok: true, response: body })
  })

  it('fails closed on a 5xx response', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('{"error":"boom"}', { status: 503 })),
    )
    const client = createHelioClient(config, { fetch: fetchImpl })

    const outcome = await client.evaluate({ tool: { name: 'send_message' } })

    expect(outcome.ok).toBe(false)
  })

  it('sends the bearer token and JSON content-type, and never an Origin header', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ evaluation_id: 'e', decision: 'allow' }), { status: 200 }),
      ),
    )
    const client = createHelioClient(config, { fetch: fetchImpl })

    await client.evaluate({ tool: { name: 'send_message' } })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const init = fetchImpl.mock.calls.at(0)?.[1]
    const headers = new Headers(init?.headers)
    expect(headers.get('authorization')).toBe('Bearer test-adapter-token')
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.has('origin')).toBe(false)
  })

  it('fails closed on a 4xx response (no valid decision to honor)', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('{"error":"unauthorized"}', { status: 401 })),
    )
    const client = createHelioClient(config, { fetch: fetchImpl })

    const outcome = await client.evaluate({ tool: { name: 'send_message' } })

    expect(outcome.ok).toBe(false)
  })

  it('includes the configured origin in the /evaluate body', async () => {
    let sent: Record<string, unknown> = {}
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => {
      sent = JSON.parse(init?.body as string) as Record<string, unknown>
      return Promise.resolve(
        new Response(JSON.stringify({ evaluation_id: 'e', decision: 'allow' }), { status: 200 }),
      )
    })
    const client = createHelioClient(config, { fetch: fetchImpl })

    await client.evaluate({ tool: { name: 'send_message' }, arguments: { a: 1 } })

    expect(sent).toMatchObject({
      origin: 'openclaw',
      tool: { name: 'send_message' },
      arguments: { a: 1 },
    })
  })

  it('fails closed on a malformed /evaluate response', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(JSON.stringify({ nonsense: true }), { status: 200 })),
    )
    const client = createHelioClient(config, { fetch: fetchImpl })

    const outcome = await client.evaluate({ tool: { name: 'send_message' } })

    expect(outcome.ok).toBe(false)
  })

  it('fails closed when /evaluate exceeds the timeout', async () => {
    // Slow fetch that only settles after 1s, unless the client aborts it first.
    const fetchImpl = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((resolve, reject) => {
          const slow = setTimeout(() => {
            resolve(
              new Response(JSON.stringify({ evaluation_id: 'e', decision: 'allow' }), {
                status: 200,
              }),
            )
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
    let sent: Record<string, unknown> = {}
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => {
      sent = JSON.parse(init?.body as string) as Record<string, unknown>
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 201 }))
    })
    const client = createHelioClient(config, { fetch: fetchImpl })

    const outcome = await client.audit({
      evaluation_id: 'eval-1',
      status: 'success',
      duration_ms: 12,
    })

    expect(outcome.ok).toBe(true)
    expect(sent).toMatchObject({ evaluation_id: 'eval-1', status: 'success', duration_ms: 12 })
  })

  it('treats a 200 already_finalized replay as success', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(JSON.stringify({ already_finalized: true }), { status: 200 })),
    )
    const client = createHelioClient(config, { fetch: fetchImpl })

    const outcome = await client.audit({ evaluation_id: 'eval-1', status: 'success' })

    expect(outcome.ok).toBe(true)
  })

  it('reports a soft failure on a 5xx (audit is best-effort, never thrown)', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response('', { status: 500 })))
    const client = createHelioClient(config, { fetch: fetchImpl })

    const outcome = await client.audit({ evaluation_id: 'eval-1', status: 'success' })

    expect(outcome.ok).toBe(false)
  })

  it('reports a soft failure when the proxy is unreachable (never throws)', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.reject(new Error('ECONNREFUSED')))
    const client = createHelioClient(config, { fetch: fetchImpl })

    const outcome = await client.audit({ evaluation_id: 'eval-1', status: 'success' })

    expect(outcome.ok).toBe(false)
  })
})

describe('helio client — installScan', () => {
  it('returns the install decision and posts origin + package on 200', async () => {
    const body = { evaluation_id: 'i1', decision: 'deny' as const, reason: 'blocked' }
    let sent: Record<string, unknown> = {}
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => {
      sent = JSON.parse(init?.body as string) as Record<string, unknown>
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
    })
    const client = createHelioClient(config, { fetch: fetchImpl })

    const outcome = await client.installScan({
      package: { name: 'left-pad', source: 'npm', version: '1.3.0' },
    })

    expect(outcome).toEqual({ ok: true, response: body })
    expect(sent).toMatchObject({ origin: 'openclaw', package: { name: 'left-pad', source: 'npm' } })
  })

  it('fails closed on a 5xx response', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response('', { status: 502 })))
    const client = createHelioClient(config, { fetch: fetchImpl })

    const outcome = await client.installScan({ package: { name: 'left-pad', source: 'npm' } })

    expect(outcome.ok).toBe(false)
  })

  it('fails closed on a malformed /install-scan response', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(JSON.stringify({ nope: 1 }), { status: 200 })),
    )
    const client = createHelioClient(config, { fetch: fetchImpl })

    const outcome = await client.installScan({ package: { name: 'left-pad', source: 'npm' } })

    expect(outcome.ok).toBe(false)
  })

  it('fails closed when the proxy is unreachable', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.reject(new Error('ECONNREFUSED')))
    const client = createHelioClient(config, { fetch: fetchImpl })

    const outcome = await client.installScan({ package: { name: 'left-pad', source: 'npm' } })

    expect(outcome.ok).toBe(false)
  })
})

describe('helio client — resolveApproval', () => {
  it('posts the resolution to /approval/:id/resolve and returns ok on 200', async () => {
    let calledUrl = ''
    let sent: Record<string, unknown> = {}
    const fetchImpl = vi.fn<typeof fetch>((url, init) => {
      calledUrl = url as string
      sent = JSON.parse(init?.body as string) as Record<string, unknown>
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    })
    const client = createHelioClient(config, { fetch: fetchImpl })

    const outcome = await client.resolveApproval('appr-9', {
      resolution: 'approved',
      resolved_by: 'telegram:@oli',
      scope: 'once',
    })

    expect(outcome.ok).toBe(true)
    expect(calledUrl).toBe('http://127.0.0.1:3200/approval/appr-9/resolve')
    expect(sent).toMatchObject({
      resolution: 'approved',
      resolved_by: 'telegram:@oli',
      scope: 'once',
    })
  })

  it('reports a failure on a non-2xx response', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response('', { status: 409 })))
    const client = createHelioClient(config, { fetch: fetchImpl })

    const outcome = await client.resolveApproval('appr-9', { resolution: 'denied' })

    expect(outcome.ok).toBe(false)
  })

  it('reports a failure when the proxy is unreachable', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.reject(new Error('ECONNREFUSED')))
    const client = createHelioClient(config, { fetch: fetchImpl })

    const outcome = await client.resolveApproval('appr-9', { resolution: 'timeout' })

    expect(outcome.ok).toBe(false)
  })
})
