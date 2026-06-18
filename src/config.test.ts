import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, parseConfig } from './config.js'

describe('parseConfig', () => {
  it('parses a full valid config including evidence rules', () => {
    const result = parseConfig({
      helioBaseUrl: 'http://127.0.0.1:9999',
      tokenEnv: 'MY_TOKEN',
      origin: 'openclaw-test',
      evaluateTimeoutMs: 500,
      evidence: {
        send_email: [
          { key: 'recipient', path: ['to'], ttlSeconds: 300 },
          { key: 'message_id', path: ['id'] },
        ],
      },
    })

    expect(result).toEqual({
      ok: true,
      config: {
        helioBaseUrl: 'http://127.0.0.1:9999',
        tokenEnv: 'MY_TOKEN',
        origin: 'openclaw-test',
        evaluateTimeoutMs: 500,
        evidence: {
          send_email: [
            { key: 'recipient', path: ['to'], ttlSeconds: 300 },
            { key: 'message_id', path: ['id'] },
          ],
        },
      },
    })
  })

  it('applies defaults for an empty config object', () => {
    expect(parseConfig({})).toEqual({ ok: true, config: DEFAULT_CONFIG })
  })

  it('treats undefined (no operator config) as all-defaults', () => {
    expect(parseConfig(undefined)).toEqual({ ok: true, config: DEFAULT_CONFIG })
  })

  it('rejects an origin that violates the manifest pattern', () => {
    const result = parseConfig({ origin: 'Not A Valid Origin!' })
    expect(result.ok).toBe(false)
  })

  it('rejects a non-positive or non-integer evaluate timeout', () => {
    expect(parseConfig({ evaluateTimeoutMs: 0 }).ok).toBe(false)
    expect(parseConfig({ evaluateTimeoutMs: 12.5 }).ok).toBe(false)
  })

  it('rejects an invalid base URL', () => {
    expect(parseConfig({ helioBaseUrl: 'not-a-url' }).ok).toBe(false)
  })

  it('rejects an evidence rule with an empty path', () => {
    const result = parseConfig({ evidence: { send_email: [{ key: 'recipient', path: [] }] } })
    expect(result.ok).toBe(false)
  })

  it('rejects an evidence rule with an empty key', () => {
    const result = parseConfig({ evidence: { send_email: [{ key: '', path: ['to'] }] } })
    expect(result.ok).toBe(false)
  })

  it('rejects an evidence rule carrying an unknown field (mirrors manifest additionalProperties:false)', () => {
    const result = parseConfig({
      evidence: { send_email: [{ key: 'recipient', path: ['to'], bogus: 1 }] },
    })
    expect(result.ok).toBe(false)
  })
})
