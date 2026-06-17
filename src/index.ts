import { createHelioClient } from './client/helio-client.js'
import { parseConfig } from './config.js'
import { createAfterToolCallHook } from './hooks/after-tool-call.js'
import { createBeforeInstallHook } from './hooks/before-install.js'
import { createBeforeToolCallHook } from './hooks/before-tool-call.js'
import type { OpenClawPluginApi, OpenClawPluginDefinition } from './types.js'

const definition: OpenClawPluginDefinition = {
  id: 'helio',
  name: 'Helio Governance',
  register(api: OpenClawPluginApi): void {
    // TODO: resolve the real plugin config from the host instead of defaults.
    const config = parseConfig(undefined)
    const client = createHelioClient(config)

    api.on('before_tool_call', createBeforeToolCallHook(client))
    api.on('after_tool_call', createAfterToolCallHook(client))
    api.on('before_install', createBeforeInstallHook(client))
  },
}

export default definition
