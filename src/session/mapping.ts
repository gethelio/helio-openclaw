import type { PluginHookToolContext } from '../types.js'

/**
 * Map an OpenClaw tool-call context to a stable Helio `session_id`, prefixed `oc:`.
 * Prefers `sessionId`, then `sessionKey`, then `channelId`; falls back to a stable sentinel
 * so a session-less call still correlates deterministically (and fails closed on ambiguity).
 */
export function mapSession(ctx: PluginHookToolContext): string {
  return `oc:${ctx.sessionId ?? ctx.sessionKey ?? ctx.channelId ?? 'unknown'}`
}
