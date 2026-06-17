import type { PluginHookToolContext } from '../types.js'

// TODO: map (ctx.sessionId | ctx.sessionKey, channel, sender) → a stable `oc:<id>`.
export function mapSession(_ctx: PluginHookToolContext): string {
  throw new Error('not implemented')
}
