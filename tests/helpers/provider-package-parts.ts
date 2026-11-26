// 2.1.3-beta.19 section 2 (aicc_planning#439): a Codex session starts by its
// package's local launch group (SessionProvider.localLaunch), and each
// provider's bindings, take-over, serving, unbind and description are its
// package's lifecycle object (SessionProvider.lifecycle). The PTY manager and
// the launch bindings find both on the provider the registry holds for the
// session. A test that stands the registry in with providers of its own wraps
// its mock with withProviderPackageParts: the provider it hands out for the
// Codex id gets the Codex package's real group and lifecycle object, and the
// one for the Claude Code id the Claude Code package's lifecycle object, so a
// launch runs the same bodies through the test's own builder, hooks,
// telemetry and run screen as it did when those bodies were core's. A
// provider that names a part of its own keeps it.
//
// The parts are loaded at the test's top level (loadProviderPackageParts),
// not in the registry mock's factory: their imports reach the registry, and
// loading them while that mock is still being made would wait on itself.
//
//   vi.mock('../../../src/main/providers', async () => (await import('../../helpers/provider-package-parts')).withProviderPackageParts(await (FACTORY)()))
//   await (await import('../../helpers/provider-package-parts')).loadProviderPackageParts()
import type { ProviderLifecycle, ProviderLocalLaunch } from '../../src/main/providers/types'

const loaded: { localLaunch?: ProviderLocalLaunch; lifecycle: Record<string, ProviderLifecycle | undefined> } = { lifecycle: {} }

/** Load the packages' parts; at the test's top level, after its mocks. */
export async function loadProviderPackageParts(): Promise<void> {
  const codexLaunch = await import('../../src/main/providers/codex/local-launch')
  const codexLifecycle = await import('../../src/main/providers/codex/lifecycle')
  const claudeLifecycle = await import('../../src/main/providers/claude/lifecycle')
  loaded.localLaunch = codexLaunch.CODEX_LOCAL_LAUNCH
  loaded.lifecycle.codex = codexLifecycle.CODEX_LIFECYCLE as ProviderLifecycle
  loaded.lifecycle.claude = claudeLifecycle.CLAUDE_LIFECYCLE as ProviderLifecycle
}

function need<T>(part: T | undefined): T {
  if (!part) throw new Error('loadProviderPackageParts() was not awaited at the top of this test file')
  return part
}

const localLaunch: ProviderLocalLaunch = Object.freeze({ start: (request, core) => need(loaded.localLaunch).start(request, core) })

function lifecycleOf(id: string): ProviderLifecycle {
  const of = (): ProviderLifecycle => need(loaded.lifecycle[id])
  return Object.freeze<ProviderLifecycle>({
    bind: (binding, core) => of().bind(binding, core),
    keptAccount: (take) => of().keptAccount(take),
    takeOver: (take, proc, kept, launchCwd, core) => of().takeOver(take, proc, kept, launchCwd, core),
    serveUnseen: (kept, provider, resolvedCwd, core) => of().serveUnseen(kept, provider, resolvedCwd, core),
    unbind: (sessionId, core) => of().unbind(sessionId, core),
    describe: (sessionId, core) => of().describe(sessionId, core),
  })
}
const PARTS: Record<string, Record<string, unknown>> = {
  codex: { localLaunch, lifecycle: lifecycleOf('codex') },
  claude: { lifecycle: lifecycleOf('claude') },
}

/** The registry mock `mod`, with each package's parts on the provider it
 *  hands out for that package's id. A mock with one of the two lookups gets
 *  the other from it (the launch bindings ask tryGetProvider at every
 *  teardown since 2.1.3-beta.19 section 2): getProvider throws where
 *  tryGetProvider answers null. */
export function withProviderPackageParts<M extends object>(mod: M): M {
  const out: Record<string, unknown> = { ...(mod as Record<string, unknown>) }
  const get = out.getProvider
  const tryGet = out.tryGetProvider
  if (typeof tryGet !== 'function' && typeof get === 'function') {
    out.tryGetProvider = (id: unknown) => { try { return (get as (id: unknown) => unknown)(id) ?? null } catch { return null } }
  }
  if (typeof get !== 'function' && typeof tryGet === 'function') {
    out.getProvider = (id: unknown) => {
      const provider: unknown = (tryGet as (id: unknown) => unknown)(id)
      if (!provider) throw new Error(`no provider registered for "${String(id)}"`)
      return provider
    }
  }
  for (const name of ['getProvider', 'tryGetProvider']) {
    const lookup = out[name]
    if (typeof lookup !== 'function') continue
    out[name] = (id: unknown, ...rest: unknown[]) => {
      const provider: unknown = (lookup as (...a: unknown[]) => unknown)(id, ...rest)
      const parts = typeof id === 'string' && Object.hasOwn(PARTS, id) ? PARTS[id] : undefined
      if (parts && provider && typeof provider === 'object') {
        for (const [key, value] of Object.entries(parts)) {
          if (!(key in provider)) Object.defineProperty(provider, key, { value, configurable: true, enumerable: true, writable: true })
        }
      }
      return provider
    }
  }
  return out as M
}
