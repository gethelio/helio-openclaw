import type { HelioClient } from '../client/helio-client.js'
import type { PluginHookAfterToolCallEvent, PluginHookToolContext } from '../types.js'

// after_tool_call → POST /audit (+ success-only evidence). The host ignores the return value.
export function createAfterToolCallHook(_client: HelioClient) {
  return (_event: PluginHookAfterToolCallEvent, _ctx: PluginHookToolContext): void => {
    // TODO: POST /audit; treat 200 already_finalized as success; attach evidence on success.
    throw new Error('not implemented')
  }
}
