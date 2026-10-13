/**
 * Drag regions as Electron would see them, for jsdom tests (aicc_planning
 * #211). jsdom has no app regions of its own, so these apply styles.css's own
 * -webkit-app-region rules (the cascade: specificity, then source order) to
 * what React rendered, and list the regions in DOM order, the order Electron
 * folds them in. Shared by onboarding-shell-window-controls.test.tsx,
 * setup-window-controls.test.tsx, multi-spawn-window-controls.test.tsx and
 * app-loading-window-controls.test.tsx.
 */
import { expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export type Region = 'drag' | 'no-drag'
export type RegionRule = { selector: string; value: string; order: number; spec: number }

const src = (rel: string) => readFileSync(resolve(__dirname, '../../../', rel), 'utf8').replace(/\r\n/g, '\n')

/** Specificity of the simple selectors the region rules use (no ids, no
 *  functional pseudo-classes: regionRules refuses anything else). */
function specificity(sel: string): number {
  const attrs = (sel.match(/\[[^\]]*\]/g) ?? []).length
  const classes = (sel.match(/\.[\w-]+/g) ?? []).length
  const types = (sel.replace(/\[[^\]]*\]/g, ' ').replace(/\.[\w-]+/g, ' ').match(/[a-zA-Z][\w-]*/g) ?? []).length
  return (attrs + classes) * 100 + types
}

/** Every styles.css rule that sets -webkit-app-region, one entry per selector. */
export function regionRules(): RegionRule[] {
  const css = src('src/renderer/styles.css').replace(/\/\*[\s\S]*?\*\//g, '')
  const rules: RegionRule[] = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m: RegExpExecArray | null
  let order = 0
  while ((m = re.exec(css))) {
    const decl = /-webkit-app-region\s*:\s*([^;}]+)/.exec(m[2])
    if (!decl) continue
    const value = decl[1].trim()
    expect(value, 'no !important (this emulation does not model it)').not.toContain('!')
    for (const selector of m[1].split(',').map((s) => s.trim())) {
      expect(selector, 'a simple selector this emulation scores exactly').toMatch(/^[\w\s.\-[\]>]+$/)
      rules.push({ selector, value, order, spec: specificity(selector) })
    }
    order++
  }
  return rules
}

/** The region an element declares: drag and no-drag declare one; initial,
 *  none or no rule at all declare none. */
export function regionOf(el: Element, rules: RegionRule[]): Region | null {
  let win: RegionRule | null = null
  for (const r of rules) {
    if (!el.matches(r.selector)) continue
    if (!win || r.spec > win.spec || (r.spec === win.spec && r.order > win.order)) win = r
  }
  return win && (win.value === 'drag' || win.value === 'no-drag') ? win.value : null
}

/** The regions on the page in DOM order (a display: none subtree has no
 *  layout and declares none). */
export function declaredRegions(rules: RegionRule[]): { el: Element; region: Region }[] {
  const out: { el: Element; region: Region }[] = []
  for (const el of Array.from(document.body.querySelectorAll('*'))) {
    if (el.closest('[style*="display: none"]')) continue
    const region = regionOf(el, rules)
    if (region) out.push({ el, region })
  }
  return out
}
