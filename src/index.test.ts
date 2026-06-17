import { describe, expect, it, vi } from 'vitest'
import definition from './index.js'
import type { OpenClawPluginApi } from './types.js'

describe('plugin definition', () => {
  it('registers the three governance hooks under the "helio" id', () => {
    const on = vi.fn<OpenClawPluginApi['on']>()
    const api = { on } as unknown as OpenClawPluginApi

    expect(definition.id).toBe('helio')
    definition.register?.(api)

    expect(on).toHaveBeenCalledTimes(3)
    expect(on.mock.calls.map((call) => call[0])).toStrictEqual([
      'before_tool_call',
      'after_tool_call',
      'before_install',
    ])
  })
})
