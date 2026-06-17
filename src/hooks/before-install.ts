import type { HelioClient } from '../client/helio-client.js'
import type {
  PluginHookBeforeInstallContext,
  PluginHookBeforeInstallEvent,
  PluginHookBeforeInstallResult,
} from '../types.js'

// before_install → POST /install-scan → decision→result mapping.
// NOTE: package.source derives from event.request.kind (normalized), not targetType (plan B.2).
export function createBeforeInstallHook(_client: HelioClient) {
  return (
    _event: PluginHookBeforeInstallEvent,
    _ctx: PluginHookBeforeInstallContext,
  ): PluginHookBeforeInstallResult => {
    // TODO: POST /install-scan; deny → { block: true, blockReason }.
    throw new Error('not implemented')
  }
}
