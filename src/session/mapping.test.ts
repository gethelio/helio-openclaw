import { describe, expect, it } from 'vitest'
import { mapSession } from './mapping.js'
import type { PluginHookToolContext } from '../types.js'

const ctx = (over: Partial<PluginHookToolContext>): PluginHookToolContext => ({
  toolName: 'send_message',
  ...over,
})

describe('mapSession', () => {
  it('maps sessionId to a stable oc:<id>', () => {
    expect(mapSession(ctx({ sessionId: 'sess-1' }))).toBe('oc:sess-1')
  })

  it('prefers sessionId over sessionKey when both are present', () => {
    expect(mapSession(ctx({ sessionId: 'sess-1', sessionKey: 'key-9' }))).toBe('oc:sess-1')
  })

  it('falls back to sessionKey when sessionId is absent', () => {
    expect(mapSession(ctx({ sessionKey: 'key-9' }))).toBe('oc:key-9')
  })

  it('falls back to channelId when no session identity is present', () => {
    expect(mapSession(ctx({ channelId: 'C123' }))).toBe('oc:C123')
  })

  it('returns a stable sentinel when nothing identifies the session', () => {
    expect(mapSession(ctx({}))).toBe('oc:unknown')
  })
})
