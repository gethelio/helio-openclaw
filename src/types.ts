// Single import site for the real OpenClaw SDK types.
//
// NOTE (verified against openclaw@2026.6.8): the hook types, `OpenClawPluginApi`, and
// `OpenClawPluginDefinition` are exported from `openclaw/plugin-sdk/plugin-runtime` — NOT the
// `openclaw/plugin-sdk` root, which does not re-export them. Re-verify on any openclaw bump.
export type {
  OpenClawPluginApi,
  OpenClawPluginDefinition,
  PluginApprovalResolution,
  PluginHookAfterToolCallEvent,
  PluginHookBeforeInstallContext,
  PluginHookBeforeInstallEvent,
  PluginHookBeforeInstallResult,
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookToolContext,
} from 'openclaw/plugin-sdk/plugin-runtime'
