import { readLocalStorage } from "@maple/ui/lib/local-storage"
import { Option, Schema } from "effect"

/** `dashboardFavoritesAtom`: an effect-atom KVS entry, JSON-encoded. */
export const DASHBOARD_FAVORITES_KEY = "maple.dashboards.favorites"

/**
 * Fired on `window` after the dashboards list writes the favorites, so the Pinned group follows
 * the star (a same-tab write fires no `storage` event).
 */
export const DASHBOARD_FAVORITES_EVENT = "maple:dashboard-favorites-changed"

const decodeFavorites = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)))

export const readDashboardFavorites = (): ReadonlyArray<string> =>
	Option.getOrElse(Option.flatMap(readLocalStorage(DASHBOARD_FAVORITES_KEY), decodeFavorites), () => [])
