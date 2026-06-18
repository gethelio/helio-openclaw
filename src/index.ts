import { createHelioClient, type HelioClientConfig } from './client/helio-client.js'
import { CorrelationRegistry } from './correlation/registry.js'
import { parseConfig } from './config.js'
import { createAfterToolCallHook } from './hooks/after-tool-call.js'
import { createBeforeInstallHook } from './hooks/before-install.js'
import { createBeforeToolCallHook } from './hooks/before-tool-call.js'
import type { OpenClawPluginApi, OpenClawPluginDefinition } from './types.js'

const MISCONFIGURED_REASON = 'Helio governance misconfigured'

const definition: OpenClawPluginDefinition = {
  id: 'helio',
  name: 'Helio Governance',
  register(api: OpenClawPluginApi): void {
    const parsed = parseConfig(api.pluginConfig)
    const token = parsed.ok ? process.env[parsed.config.tokenEnv] : undefined

    // Fail closed WITHOUT depending on the host's register()-throw semantics: if the config is
    // invalid or the adapter token is missing, register hooks that BLOCK every governed action
    // rather than leaving the tool surface ungoverned (which is what skipping registration would
    // do). The operator sees everything blocked + a loud log, and fixes the config.
    if (!parsed.ok || token === undefined || token === '') {
      const reason = !parsed.ok
        ? `Helio adapter config is invalid: ${parsed.error}`
        : `Helio adapter token ($${parsed.config.tokenEnv}) is not set`
      api.logger.error(`${reason} — blocking all governed tool calls and installs.`)
      api.on('before_tool_call', () => ({ block: true, blockReason: MISCONFIGURED_REASON }))
      api.on('before_install', () => ({ block: true, blockReason: MISCONFIGURED_REASON }))
      return
    }

    const { config } = parsed
    const clientConfig: HelioClientConfig = {
      baseUrl: config.helioBaseUrl,
      token,
      origin: config.origin,
      evaluateTimeoutMs: config.evaluateTimeoutMs,
    }
    const client = createHelioClient(clientConfig)
    const registry = new CorrelationRegistry()

    api.on(
      'before_tool_call',
      createBeforeToolCallHook({ client, registry, origin: config.origin }),
    )
    api.on(
      'after_tool_call',
      createAfterToolCallHook({ client, registry, evidence: config.evidence }),
    )
    api.on('before_install', createBeforeInstallHook(client))
  },
}

export default definition
