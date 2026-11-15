/// <reference types="vite/client" />
/**
 * The service registry's rows and its restart routing are tested on the
 * registry itself (tests/unit/services/service-registry.test.ts). This pins
 * what main hands it: which service feeds which row, that every push and the
 * GET handler read the one registry, and that the MCP server's row is told to
 * the Services view once its start settles, with the reason when it failed.
 */
import { describe, it, expect } from 'vitest'
import indexSource from '../../../src/main/index.ts?raw'

const flat = (s: string) => s.replace(/\s+/g, ' ')

/** The statement that starts with `start`, up to the blank line or the next
 *  statement named by `end`, on one line. Empty when it is not found. */
function statement(start: string, end: RegExp): string {
  const at = indexSource.indexOf(start)
  if (at === -1) return ''
  const rest = indexSource.slice(at)
  const to = rest.search(end)
  return to === -1 ? '' : flat(rest.slice(0, to))
}

describe('main wires the service registry', () => {
  // The registry's sources: the statement ends where the push is defined.
  const sourcesBlock = statement('const serviceRegistry = createServiceRegistry({', /\r?\n\s*const pushDiagnostics = /)
  // The MCP server start, up to the blank line after its promise chain.
  const mcpStart = statement('startConductorMcpServer(mcpPort, getWindow)', /\r?\n[ \t]*\r?\n/)

  it('there is one registry, built once', () => {
    expect(sourcesBlock).not.toBe('')
    expect(indexSource.split('createServiceRegistry(').length - 1).toBe(1)
  })

  it('each row is read from its own service, on its own key', () => {
    for (const source of [
      'hooks: () => getHooksSupervisor(),',
      'logging: () => getLogSupervisor(),',
      'tokenomics: () => getTokenomicsSupervisor(),',
      'watchdog: () => getWatchdogManager(),',
      'pty: () => getPtyIntegrityMonitor()?.diagnostics() ?? null,',
    ]) expect(sourcesBlock, source).toContain(source)
  })

  it('the MCP server row is read from the server\'s own state, with the reason its start failed', () => {
    expect(sourcesBlock).toContain('mcp: () => ({ running: isMcpServerRunning(), port: getMcpPort(), startError: mcpStartError }),')
  })

  it('every push and the GET handler read the same registry', () => {
    expect(flat(indexSource)).toContain('const pushDiagnostics = () => emitToWindow(IPC.SERVICE_HEALTH_UPDATE, serviceRegistry.snapshot())')
    expect(flat(indexSource)).toContain('registerServiceHealthHandlers(serviceRegistry)')
    // A supervisor's own push of its one row is sent as the whole snapshot.
    expect(flat(indexSource)).toContain('channel === IPC.SERVICE_HEALTH_UPDATE ? pushDiagnostics() : emitToWindow(channel, payload)')
    for (const owner of [
      'new ServiceSupervisor({ forkChild: forkHooksChild, defaultPort: hooksPort, emit: emitWithMerge,',
      'initLogging({ emit: emitWithMerge,',
      'initTokenomics({ emit: emitWithMerge',
      'new PtyIntegrityMonitor({ emit: pushDiagnostics })',
      'onHealthChange: () => pushDiagnostics(),',
    ]) expect(flat(indexSource), owner).toContain(owner)
  })

  it('a failed MCP server start is kept for its row', () => {
    expect(mcpStart).not.toBe('')
    expect(mcpStart).toMatch(/\.catch\(err => \{ logError\([^)]*\) mcpStartError = \{ message: String\(err\?\.message \?\? err\), ts: Date\.now\(\) \} \}\)/)
  })

  it('the row is pushed once the MCP server start settles, and a push that fails there is caught', () => {
    expect(mcpStart).toMatch(/\}\)\.finally\(\(\) => \{.*try \{ pushDiagnostics\(\) \} catch \(err\) \{ logError\(/)
  })
})
