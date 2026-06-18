import { describe, expect, it, vi } from 'vitest'
import { createBeforeInstallHook } from './before-install.js'
import type { HelioClient, InstallScanOutcome } from '../client/helio-client.js'
import type {
  PluginHookBeforeInstallContext,
  PluginHookBeforeInstallEvent,
  PluginInstallRequestKind,
} from '../types.js'

function setup(outcome: InstallScanOutcome) {
  const installScan = vi.fn<HelioClient['installScan']>(() => Promise.resolve(outcome))
  const client: HelioClient = {
    evaluate: vi.fn<HelioClient['evaluate']>(() => Promise.resolve({ ok: false, reason: 'n/a' })),
    audit: vi.fn<HelioClient['audit']>(() => Promise.resolve({ ok: true })),
    installScan,
    resolveApproval: vi.fn<HelioClient['resolveApproval']>(() => Promise.resolve({ ok: true })),
  }
  const hook = createBeforeInstallHook(client)
  return { hook, installScan }
}

const event = (over: Partial<PluginHookBeforeInstallEvent> = {}): PluginHookBeforeInstallEvent => ({
  targetType: 'plugin',
  targetName: 'left-pad',
  sourcePath: '/tmp/left-pad',
  sourcePathKind: 'directory',
  request: { kind: 'plugin-npm', mode: 'install', requestedSpecifier: 'left-pad@1.3.0' },
  builtinScan: { status: 'ok', scannedFiles: 3, critical: 0, warn: 1, info: 2, findings: [] },
  plugin: { pluginId: 'p1', contentType: 'package', packageName: 'left-pad', version: '1.3.0' },
  ...over,
})

const ctx = (
  over: Partial<PluginHookBeforeInstallContext> = {},
): PluginHookBeforeInstallContext => ({
  targetType: 'plugin',
  requestKind: 'plugin-npm',
  ...over,
})

describe('before_install', () => {
  it('allows the install and posts an install-scan request built from event', async () => {
    const { hook, installScan } = setup({
      ok: true,
      response: { evaluation_id: 'e1', decision: 'allow' },
    })

    const result = await hook(event(), ctx())

    expect(result).toEqual({})
    expect(installScan).toHaveBeenCalledWith({
      package: { name: 'left-pad', version: '1.3.0', source: 'npm', spec: 'left-pad@1.3.0' },
      metadata: {
        mode: 'install',
        target_type: 'plugin',
        builtin_scan: { critical: 0, warn: 1, info: 2 },
      },
    })
  })

  it('prefers plugin.packageName over targetName for package.name', async () => {
    const { hook, installScan } = setup({
      ok: true,
      response: { evaluation_id: 'e1', decision: 'allow' },
    })

    await hook(
      event({
        targetName: 'my-alias',
        plugin: {
          pluginId: 'p1',
          contentType: 'package',
          packageName: 'real-pkg',
          version: '2.0.0',
        },
      }),
      ctx(),
    )

    expect(installScan.mock.calls[0]?.[0].package.name).toBe('real-pkg')
  })

  it('falls back to targetName and omits version/spec when there is no plugin metadata', async () => {
    const { hook, installScan } = setup({
      ok: true,
      response: { evaluation_id: 'e1', decision: 'allow' },
    })

    // skill installs carry no `plugin` block (and thus no version) — build without it
    // rather than passing `plugin: undefined` (rejected under exactOptionalPropertyTypes).
    const skillEvent: PluginHookBeforeInstallEvent = {
      targetType: 'skill',
      targetName: 'web-search',
      sourcePath: '/tmp/web-search',
      sourcePathKind: 'directory',
      request: { kind: 'skill-install', mode: 'install' },
      builtinScan: { status: 'ok', scannedFiles: 3, critical: 0, warn: 1, info: 2, findings: [] },
    }

    await hook(skillEvent, ctx({ targetType: 'skill', requestKind: 'skill-install' }))

    expect(installScan).toHaveBeenCalledWith({
      package: { name: 'web-search', source: 'skill' },
      metadata: {
        mode: 'install',
        target_type: 'skill',
        builtin_scan: { critical: 0, warn: 1, info: 2 },
      },
    })
  })

  it.each<[PluginInstallRequestKind, string]>([
    ['plugin-npm', 'npm'],
    ['plugin-git', 'git'],
    ['plugin-archive', 'archive'],
    ['plugin-file', 'file'],
    ['plugin-dir', 'dir'],
    ['skill-install', 'skill'],
  ])('maps request.kind %s to package.source %s', async (kind, source) => {
    const { hook, installScan } = setup({
      ok: true,
      response: { evaluation_id: 'e1', decision: 'allow' },
    })

    await hook(event({ request: { kind, mode: 'install' } }), ctx({ requestKind: kind }))

    expect(installScan.mock.calls[0]?.[0].package.source).toBe(source)
  })

  it('blocks a deny decision with the feedback message', async () => {
    const { hook } = setup({
      ok: true,
      response: { evaluation_id: 'e', decision: 'deny', feedback: { message: 'Blocked package' } },
    })

    const result = await hook(event(), ctx())

    expect(result).toEqual({ block: true, blockReason: 'Blocked package' })
  })

  it('blocks a deny decision using the reason when there is no feedback message', async () => {
    const { hook } = setup({
      ok: true,
      response: { evaluation_id: 'e', decision: 'deny', reason: 'Matched block-evil' },
    })

    const result = await hook(event(), ctx())

    expect(result).toEqual({ block: true, blockReason: 'Matched block-evil' })
  })

  it('blocks a deny decision with a default reason when neither feedback nor reason is present', async () => {
    const { hook } = setup({
      ok: true,
      response: { evaluation_id: 'e', decision: 'deny' },
    })

    const result = await hook(event(), ctx())

    expect(result).toEqual({ block: true, blockReason: 'Blocked by Helio' })
  })

  it('forwards update mode and the builtin-scan summary even when the scan errored', async () => {
    const { hook, installScan } = setup({
      ok: true,
      response: { evaluation_id: 'e1', decision: 'allow' },
    })

    await hook(
      event({
        request: { kind: 'plugin-npm', mode: 'update', requestedSpecifier: 'left-pad@2.0.0' },
        builtinScan: {
          status: 'error',
          scannedFiles: 0,
          critical: 2,
          warn: 0,
          info: 0,
          findings: [],
          error: 'scan failed',
        },
      }),
      ctx(),
    )

    expect(installScan.mock.calls[0]?.[0].metadata).toEqual({
      mode: 'update',
      target_type: 'plugin',
      builtin_scan: { critical: 2, warn: 0, info: 0 },
    })
  })

  it('fails closed and blocks when the install scan is unavailable', async () => {
    const { hook } = setup({ ok: false, reason: 'down' })

    const result = await hook(event(), ctx())

    expect(result).toEqual({ block: true, blockReason: 'Helio governance unavailable' })
  })
})
