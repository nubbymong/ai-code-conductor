/**
 * The Codex model and effort pickers' rows (P3.8, rows 39 and 40), for the
 * session dialog's Codex fields and the command bar's Codex model pill.
 *
 * The rows are the codex family's models of the registry main hands the
 * renderer. Once main has read the installed Codex's own list (`codex debug
 * models --bundled`, aicc_planning#362), those are that list's models, in its
 * order, each with the reasoning levels it lists; a registry row only adds a
 * price or corrects a label (withInstalledCodexModels). Without a list (Codex
 * not found, or the read failed) they are the codex family's rows in
 * resources/model-registry.json alone. A hand-kept list lived here until P3.8.
 */
import { buildModelPickerRows, codexEffortRuns, type ModelRegistry } from '../shared/model-registry'
import { effortsForModel } from './lib/claude-cli-options'
import codexCatalogueJson from '../../resources/codex-model-catalogue.json'

export interface CodexPickerOption {
  value: string
  label: string
  disabled?: boolean
}

/** The value that means "no override": Codex's own default model, or the
 *  model's own default effort (the spawn passes no flag for it). */
export const CODEX_DEFAULT = ''

/**
 * The Codex models to offer: Default, then the registry's Codex models (the
 * installed Codex's own list when main has read it), then `current` when it
 * is a model the list no longer offers (a config saved with one), so the
 * picker shows what the config or session actually holds rather than
 * silently displaying another row.
 */
export function codexModelOptions(registry: ModelRegistry, current?: string | null): CodexPickerOption[] {
  const rows = buildModelPickerRows(registry, 'codex')
  const out: CodexPickerOption[] = [
    { value: CODEX_DEFAULT, label: 'Default: follows Codex' },
    ...rows.map((r) => ({ value: r.value, label: r.label })),
  ]
  if (current && !out.some((o) => o.value === current)) out.push({ value: current, label: `${current} (not in the list)` })
  return out
}

/**
 * The efforts to offer for `model`: Default, then Codex's levels, each level
 * that model does not support disabled (Claude's rule: greyed, never hidden).
 */
export function codexEffortOptions(registry: ModelRegistry, model: string | null | undefined): CodexPickerOption[] {
  return [
    { value: CODEX_DEFAULT, label: 'Default' },
    ...effortsForModel(registry, model || null, 'codex').map((e) => ({ value: e.value, label: e.label, ...(e.disabled ? { disabled: true } : {}) })),
  ]
}

/** True when `model` runs `effort`: Default always does; a level Codex's list
 *  does not hold (a legacy 'none' or 'minimal') never does, so a model change
 *  or a load clamps it to Default, as Claude's effort is clamped. */
export function codexEffortSupported(registry: ModelRegistry, model: string | null | undefined, effort: string | null | undefined): boolean {
  return codexEffortRuns(registry, model, effort)
}

/** The part of resources/codex-model-catalogue.json this file reads: the
 *  supported versions the list was read from, and each model's own versions
 *  when not every one of them lists it. */
export interface CodexCatalogue {
  cliVersions?: string[]
  models?: { id: string; cliVersions?: string[] }[]
}

/** The ids every supported Codex version in the catalogue lists. */
function idsEveryCodexLists(catalogue: CodexCatalogue): Set<string> {
  const versions = catalogue.cliVersions ?? []
  return new Set((catalogue.models ?? [])
    .filter((m) => !m.cliVersions || versions.every((v) => m.cliVersions!.includes(v)))
    .map((m) => m.id))
}

/** The model a new Codex config starts on (P3.8 round 1, J1), as a new Claude
 *  config starts on the first row of Claude's (its newest Opus). With the
 *  installed Codex's own list read (aicc_planning#362), its first model: that
 *  Codex offers every model in it. Without one, the first model of the Codex
 *  list that every supported Codex version lists: a model only newer versions
 *  list (GPT-6.2-Sol, from 0.170.0) is skipped, so a new config never starts
 *  on a model the installed CLI may not offer. '' (Default, Codex chooses)
 *  when no model qualifies. */
export function codexNewConfigModel(registry: ModelRegistry, catalogue: CodexCatalogue = codexCatalogueJson): string {
  const rows = buildModelPickerRows(registry, 'codex')
  if (registry.installedCodex) return rows[0]?.value ?? CODEX_DEFAULT
  const everywhere = idsEveryCodexLists(catalogue)
  return rows.find((r) => everywhere.has(r.value))?.value ?? CODEX_DEFAULT
}
