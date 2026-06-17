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
