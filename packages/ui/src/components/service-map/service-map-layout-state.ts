// The user-owned state a service map keeps across renders: manual node
// positions + camera per layout, and declutter preferences. Hosts decide where
// it lives (web persists it per org in localStorage; local keeps it in memory).

export interface ServiceMapLayoutSnapshot {
	/**
	 * The layout signature these positions were captured against (topology +
	 * namespace assignment + spacing config + declutter state + engine version).
	 * Positions are only honoured while this still matches the live layout;
	 * stale absolute coordinates would scatter nodes out of their clusters.
	 */
	signature: string
	positions: Record<string, { x: number; y: number }>
	viewport: { x: number; y: number; zoom: number } | null
}

/**
 * Small LRU of layout snapshots (most-recent first), so toggling declutter
 * state (traffic filter / focus-hide / collapse, each of which changes the
 * signature) round-trips manual arrangements instead of stomping a single one.
 */
export interface ServiceMapLayout {
	snapshots: ReadonlyArray<ServiceMapLayoutSnapshot>
}

export const SNAPSHOT_LIMIT = 4

export const EMPTY_SERVICE_MAP_LAYOUT: ServiceMapLayout = { snapshots: [] }

/** Upsert `signature`'s snapshot at the front of the LRU, capped at {@link SNAPSHOT_LIMIT}. */
export function upsertSnapshot(
	layout: ServiceMapLayout,
	signature: string,
	update: (snapshot: ServiceMapLayoutSnapshot) => ServiceMapLayoutSnapshot,
): ServiceMapLayout {
	const existing = layout.snapshots.find((s) => s.signature === signature) ?? {
		signature,
		positions: {},
		viewport: null,
	}
	const rest = layout.snapshots.filter((s) => s.signature !== signature)
	return { snapshots: [update(existing), ...rest].slice(0, SNAPSHOT_LIMIT) }
}

/**
 * Declutter preferences that should survive reloads: the low-traffic threshold
 * and which namespaces are collapsed. Focus is navigational and lives elsewhere.
 */
export interface ServiceMapViewPrefs {
	/** 0 = off; otherwise hide edges under this % of the peak edge rate. */
	minTrafficPct: number
	collapsedNamespaces: ReadonlyArray<string>
}

export const DEFAULT_SERVICE_MAP_VIEW_PREFS: ServiceMapViewPrefs = {
	minTrafficPct: 0,
	collapsedNamespaces: [],
}
