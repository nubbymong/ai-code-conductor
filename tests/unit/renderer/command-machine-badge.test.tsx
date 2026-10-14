// @vitest-environment jsdom
/**
 * harmonise-remote Phase 3 (owner, 2026-08-30): the ONLY machine badge kept on
 * a cluster mark is "this PC" on the PARTNER cluster (the partner shell really
 * is local while the main pane is remote). The "remote" badge on the
 * main-shell/agent clusters is dropped — the cluster tooltip and the header's
 * "SSH: user@host" line already say where those run, so it was redundant chrome
 * over the command buttons. (#570 had already cut the raw-IP form down to a
 * side label; this removes the remaining "remote" side label.)
 *
 * #86 (2.1.1): the partner shell of an SSH session runs on the host now, so the
 * two panes are on the same machine and the "this PC" badge would be a lie
 * there: no cluster carries a machine badge on any session type. The cluster
 * tooltip names the host.
 */
import React from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { TargetMark } from '../../../src/renderer/components/command-bar/chips'
import { sessionCapabilities } from '../../../src/renderer/lib/session-capabilities'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ssh = (over: Record<string, unknown> = {}) => ({
  provider: 'claude',
  sessionType: 'ssh',
  configId: 'cfg',
  sshConfig: { host: '192.168.50.201', port: 22, username: 'pi', remotePath: '/' },
  ...over,
}) as never

let root: Root | null = null
let host: HTMLElement | null = null

function render(el: React.ReactElement): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(el))
}

afterEach(() => {
  if (root) act(() => root!.unmount())
  host?.remove()
  root = null
  host = null
})

describe('TargetMark machine badge (harmonise-remote Phase 3)', () => {
  it('shows NO badge on the agent cluster on SSH (the "remote" side label is dropped)', () => {
    const caps = sessionCapabilities(ssh())
    render(<TargetMark kind="agent" caps={caps} />)
    expect(host!.querySelector('[data-testid="command-machine-badge"]')).toBeNull()
    // The host stays reachable: the cluster tooltip still names it.
    const mark = host!.querySelector('[data-testid="command-cluster-agent"]')
    expect(mark!.getAttribute('title')).toContain('192.168.50.201')
  })

  it('shows NO badge on the main-shell cluster, nor (#86) "this PC" on the partner cluster on SSH: its tooltip names the host', () => {
    const caps = sessionCapabilities(ssh())
    render(
      <>
        <TargetMark kind="main-shell" caps={caps} />
        <TargetMark kind="partner" caps={caps} />
      </>,
    )
    expect(host!.querySelector('[data-testid="command-machine-badge"]')).toBeNull()
    const mark = host!.querySelector('[data-testid="command-cluster-partner"]')
    expect(mark!.getAttribute('title')).toBe('These run in the partner shell on 192.168.50.201')
  })

  it('shows no badge at all when both panes are on this PC', () => {
    const caps = sessionCapabilities({ provider: 'claude', sessionType: 'local', configId: 'cfg' } as never)
    render(
      <>
        <TargetMark kind="agent" caps={caps} />
        <TargetMark kind="partner" caps={caps} />
      </>,
    )
    expect(host!.querySelector('[data-testid="command-machine-badge"]')).toBeNull()
  })
})
