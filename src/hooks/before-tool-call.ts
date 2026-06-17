import type { HelioClient } from '../client/helio-client.js'
import type {
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookToolContext,
} from '../types.js'

// before_tool_call → POST /evaluate → decision→result mapping (fail-closed).
export function createBeforeToolCallHook(_client: HelioClient) {
  return (
    _event: PluginHookBeforeToolCallEvent,
    _ctx: PluginHookToolContext,
  ): PluginHookBeforeToolCallResult => {
    // TODO: translate /evaluate decision → result; require_approval → onResolution.
    throw new Error('not implemented')
  }
}
