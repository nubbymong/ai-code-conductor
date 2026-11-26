// 2.1.3-beta.19 section 2 (aicc_planning#439): a Codex session starts by its
// package's local launch group (SessionProvider.localLaunch), which the PTY
// manager finds on the provider the registry holds for the session. A test
// that stands the registry in with a Codex session provider of its own wraps
// its mock with withCodexLocalLaunch: the provider handed out for the Codex id
// gets the package's real group, so the launch runs the same body through the
// test's own builder, hooks, telemetry and run screen, as it did when the body
// was the PTY manager's. A provider that names a group of its own keeps it.
//
// The group is loaded at the test's top level (loadCodexLocalLaunch), not in
// the registry mock's factory: its imports reach the registry, and loading
// them while that mock is still being made would wait on itself.
//
//   vi.mock('../../../src/main/providers', async () => (await import('../../helpers/codex-local-launch')).withCodexLocalLaunch(await (FACTORY)()))
//   await (await import('../../helpers/codex-local-launch')).loadCodexLocalLaunch()
import type { LocalLaunchCore, LocalLaunchRequest, LocalLaunchStarted, ProviderLocalLaunch } from '../../src/main/providers/types'

let group: ProviderLocalLaunch | undefined

/** Load the Codex package's local launch group; at the test's top level, after its mocks. */
export async function loadCodexLocalLaunch(): Promise<void> {
  group = (await import('../../src/main/providers/codex/local-launch')).CODEX_LOCAL_LAUNCH
}

/** The group, as the Codex package has it, once loaded. */
const loadedGroup: ProviderLocalLaunch = Object.freeze({
  start(request: LocalLaunchRequest, core: LocalLaunchCore): LocalLaunchStarted {
    if (!group) throw new Error('loadCodexLocalLaunch() was not awaited at the top of this test file')
    return group.start(request, core)
  },
})

/** The registry mock `mod`, with the Codex package's local launch group on the provider it hands out for the Codex id. */
export function withCodexLocalLaunch<M extends object>(mod: M): M {
  const out: Record<string, unknown> = { ...(mod as Record<string, unknown>) }
  for (const name of ['getProvider', 'tryGetProvider']) {
    const lookup = out[name]
    if (typeof lookup !== 'function') continue
    out[name] = (id: unknown, ...rest: unknown[]) => {
      const provider: unknown = (lookup as (...a: unknown[]) => unknown)(id, ...rest)
      if (id === 'codex' && provider && typeof provider === 'object' && !('localLaunch' in provider)) {
        Object.defineProperty(provider, 'localLaunch', { value: loadedGroup, configurable: true, enumerable: true, writable: true })
      }
      return provider
    }
  }
  return out as M
}
