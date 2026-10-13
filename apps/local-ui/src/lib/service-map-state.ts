// The service map's per-browser state: manual node positions + camera per
// layout, and declutter preferences. Mirrors the cloud app's per-org atoms,
// keyed here per browser since local mode has one tenant.

import { useSyncExternalStore } from "react"
import { Option, Schema } from "effect"
import { readLocalStorage, writeLocalStorage } from "@maple/ui/lib/local-storage"
import {
	DEFAULT_SERVICE_MAP_VIEW_PREFS,
	EMPTY_SERVICE_MAP_LAYOUT,
	type ServiceMapLayout,
	type ServiceMapViewPrefs,
} from "@maple/ui/components/service-map/service-map-layout-state"

interface StoredValue<A> {
	readonly get: () => A
	readonly subscribe: (listener: () => void) => () => void
	/** Stable across renders, so it can sit in effect and callback deps. */
	readonly update: (fn: (prev: A) => A) => void
}

function storedValue<A>(key: string, decode: (raw: string) => Option.Option<A>, fallback: A): StoredValue<A> {
	let loaded: Option.Option<A> = Option.none()
	const listeners = new Set<() => void>()
	const get = (): A => {
		if (Option.isSome(loaded)) return loaded.value
		const value = Option.getOrElse(Option.flatMap(readLocalStorage(key), decode), () => fallback)
		loaded = Option.some(value)
		return value
	}
	return {
		get,
		subscribe: (listener) => {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
		update: (fn) => {
			const next = fn(get())
			loaded = Option.some(next)
			writeLocalStorage(key, JSON.stringify(next))
			for (const listener of listeners) listener()
		},
	}
}

const Position = Schema.Struct({ x: Schema.Number, y: Schema.Number })

const LayoutSchema = Schema.Struct({
	snapshots: Schema.Array(
		Schema.Struct({
			signature: Schema.String,
			positions: Schema.Record(Schema.String, Position),
			viewport: Schema.NullOr(
				Schema.Struct({ x: Schema.Number, y: Schema.Number, zoom: Schema.Number }),
			),
		}),
	),
})

const ViewPrefsSchema = Schema.Struct({
	minTrafficPct: Schema.Number,
	collapsedNamespaces: Schema.Array(Schema.String),
})

const layoutStore = storedValue<ServiceMapLayout>(
	"maple-local:service-map.layout",
	Schema.decodeUnknownOption(Schema.fromJsonString(LayoutSchema)),
	EMPTY_SERVICE_MAP_LAYOUT,
)

const viewPrefsStore = storedValue<ServiceMapViewPrefs>(
	"maple-local:service-map.view-prefs",
	Schema.decodeUnknownOption(Schema.fromJsonString(ViewPrefsSchema)),
	DEFAULT_SERVICE_MAP_VIEW_PREFS,
)

export function useServiceMapLayout(): readonly [ServiceMapLayout, StoredValue<ServiceMapLayout>["update"]] {
	const layout = useSyncExternalStore(layoutStore.subscribe, layoutStore.get, layoutStore.get)
	return [layout, layoutStore.update] as const
}

export function useServiceMapViewPrefs(): readonly [
	ServiceMapViewPrefs,
	StoredValue<ServiceMapViewPrefs>["update"],
] {
	const prefs = useSyncExternalStore(viewPrefsStore.subscribe, viewPrefsStore.get, viewPrefsStore.get)
	return [prefs, viewPrefsStore.update] as const
}
