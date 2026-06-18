import type {
  HelioClient,
  InstallScanRequest,
  InstallScanResponse,
} from '../client/helio-client.js'
import type {
  PluginHookBeforeInstallContext,
  PluginHookBeforeInstallEvent,
  PluginHookBeforeInstallResult,
  PluginInstallRequestKind,
} from '../types.js'

function blockReasonOf(response: InstallScanResponse): string {
  return response.feedback?.message ?? response.reason ?? 'Blocked by Helio'
}

// `package.source` is the install's provenance, derived from the normalized request.kind — NOT
// `targetType` (which is only "skill"|"plugin", the kind of thing, not where it came from). The
// lowercase tokens are safe under the proxy's origin-style charset. See plan §B.2.
function sourceOf(kind: PluginInstallRequestKind): string {
  switch (kind) {
    case 'plugin-npm':
      return 'npm'
    case 'plugin-git':
      return 'git'
    case 'plugin-archive':
      return 'archive'
    case 'plugin-file':
      return 'file'
    case 'plugin-dir':
      return 'dir'
    case 'skill-install':
      return 'skill'
  }
}

function buildRequest(event: PluginHookBeforeInstallEvent): InstallScanRequest {
  const { request, plugin, builtinScan } = event
  return {
    package: {
      // Prefer the true package identity (npm/package name) so supply-chain deny_install globs
      // match; fall back to targetName for skills and plugins lacking packageName.
      name: plugin?.packageName ?? event.targetName,
      source: sourceOf(request.kind),
      ...(plugin?.version !== undefined ? { version: plugin.version } : {}),
      ...(request.requestedSpecifier !== undefined ? { spec: request.requestedSpecifier } : {}),
    },
    metadata: {
      mode: request.mode,
      target_type: event.targetType,
      // OpenClaw's own static-scan summary, carried forward as context for Helio's evaluation.
      builtin_scan: {
        critical: builtinScan.critical,
        warn: builtinScan.warn,
        info: builtinScan.info,
      },
    },
  }
}

// before_install → POST /install-scan → decision→result mapping (fail-closed, terminal: no /audit).
// NOTE: package.source derives from event.request.kind (normalized), not targetType (plan §B.2).
export function createBeforeInstallHook(client: HelioClient) {
  return async (
    event: PluginHookBeforeInstallEvent,
    _ctx: PluginHookBeforeInstallContext,
  ): Promise<PluginHookBeforeInstallResult> => {
    const outcome = await client.installScan(buildRequest(event))
    if (!outcome.ok) {
      return { block: true, blockReason: 'Helio governance unavailable' }
    }

    const { response } = outcome
    switch (response.decision) {
      case 'allow':
        return {}
      case 'deny':
        return { block: true, blockReason: blockReasonOf(response) }
      default: {
        // Unreachable today: the response schema's decision enum is exactly allow|deny, and a
        // malformed body fails the client's safeParse → { ok: false } → already blocked above.
        // The `never` binding turns any future enum growth into a compile error here; the runtime
        // arm stays fail-closed regardless.
        const _never: never = response.decision
        return { block: true, blockReason: 'Helio governance unavailable' }
      }
    }
  }
}
