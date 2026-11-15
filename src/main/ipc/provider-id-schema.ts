// One schema for a provider id in an IPC payload.
//
// Every request from the renderer that names a provider is held to this one
// schema, built from the app's own list of provider ids (PROVIDER_IDS, the
// list the provider registry is keyed by). A provider added to that list is
// accepted by every such request at once, one taken off it is refused by all
// of them, and no IPC schema restates the names.
//
// No default export (project convention).
import { z } from 'zod'
import { PROVIDER_IDS } from '../../shared/providers'

/** A provider id, exactly as the app lists them. */
export const providerIdSchema = z.enum(PROVIDER_IDS)
