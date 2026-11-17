/**
 * What each provider is called on screen, for a page that names one before,
 * or without, the main process's provider view (whose `displayName` a page
 * prefers once it has read it). One map for the renderer, so a new provider
 * or a rename is made here once; tests/wp1/provider-conformance.test.ts holds
 * it to each provider package's own `displayName`, the name that view gives.
 */
import type { ProviderId } from '../shared/providers'

export const PROVIDER_NAMES: Readonly<Record<ProviderId, string>> = { claude: 'Claude Code', codex: 'Codex' }
