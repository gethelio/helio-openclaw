import { createHelioClient, type HelioClientConfig } from './client/helio-client.js'
import { parseConfig } from './config.js'
import { createAfterToolCallHook } from './hooks/after-tool-call.js'
import { createBeforeInstallHook } from './hooks/before-install.js'
import { createBeforeToolCallHook } from './hooks/before-tool-call.js'
import type { OpenClawPluginApi, OpenClawPluginDefinition } from './types.js'

const definition: OpenClawPluginDefinition = {
  id: 'helio',
  name: 'Helio Governance',
  register(api: OpenClawPluginApi): void {
    // TODO(config step): resolve + validate the real plugin config from the host, and
    // fail-closed when the token is missing. Defaults + env lookup are a placeholder.
    const adapterConfig = parseConfig(undefined)
    const clientConfig: HelioClientConfig = {
      baseUrl: adapterConfig.helioBaseUrl,
      token: process.env[adapterConfig.tokenEnv] ?? '',
      origin: adapterConfig.origin,
      evaluateTimeoutMs: adapterConfig.evaluateTimeoutMs,
    }
    const client = createHelioClient(clientConfig)

    api.on('before_tool_call', createBeforeToolCallHook(client))
    api.on('after_tool_call', createAfterToolCallHook(client))
    api.on('before_install', createBeforeInstallHook(client))
  },
}

export default definition
