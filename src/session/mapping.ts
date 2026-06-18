import type { PluginHookToolContext } from '../types.js'

/**
 * Map an OpenClaw tool-call context to a stable Helio `session_id`, prefixed `oc:`.
 * Prefers `sessionId`, then `sessionKey`, then `channelId`; falls back to a stable sentinel
 * so a session-less call still correlates deterministically (and fails closed on ambiguity).
 *
 * NOTE: this id feeds both the Helio `session_id` (which scopes session-level policies/limits) and
 * the no-ID correlation lane. In the fallback cases — `channelId` (one channel may span several
 * logical sessions) or the `'unknown'` sentinel — distinct sessions can collapse onto one id. That
 * is correlation-safe (the registry fails closed on the resulting ambiguity), but operators relying
 * on per-session scoping should ensure the host supplies `sessionId`/`sessionKey`.
 */
export function mapSession(ctx: PluginHookToolContext): string {
  return `oc:${ctx.sessionId ?? ctx.sessionKey ?? ctx.channelId ?? 'unknown'}`
}
