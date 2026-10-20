import { upsertSnapshot } from "@maple/ui/components/service-map/service-map-layout-state"
import { Option, Schema } from "effect"
import { Point, Viewport } from "../xyflow/geometry"

// The user-owned map state `ServiceMapFlowCanvas` keeps across renders (packages/ui
// `service-map-layout-state.ts`): focus, declutter prefs, and drags plus camera per layout.

export const Positions = Schema.Record(Schema.String, Point)
export type Positions = typeof Positions.Type

export const Focus = Schema.Struct({
	serviceId: Schema.String,
	hops: Schema.Literals([1, 2]),
	mode: Schema.Literals(["dim", "hide"]),
})
export type Focus = typeof Focus.Type

export const sameFocus = (a: Option.Option<Focus>, b: Option.Option<Focus>): boolean =>
	Option.isNone(a)
		? Option.isNone(b)
		: Option.isSome(b) &&
			a.value.serviceId === b.value.serviceId &&
			a.value.hops === b.value.hops &&
			a.value.mode === b.value.mode

/** `ServiceMapLayoutSnapshot`: manual positions and camera captured against one layout signature. */
export const Snapshot = Schema.Struct({
	signature: Schema.String,
	positions: Positions,
	viewport: Schema.NullOr(Viewport),
})
export type Snapshot = typeof Snapshot.Type

/** `ServiceMapViewPrefs`: per-org declutter preferences (focus lives in the URL). */
export const ViewPrefs = Schema.Struct({
	minTrafficPct: Schema.Number,
	collapsedNamespaces: Schema.Array(Schema.String),
})
export type ViewPrefs = typeof ViewPrefs.Type

export const DEFAULT_VIEW_PREFS: ViewPrefs = { minTrafficPct: 0, collapsedNamespaces: [] }

export const snapshotFor = (snapshots: ReadonlyArray<Snapshot>, signature: string): Option.Option<Snapshot> =>
	Option.fromNullishOr(snapshots.find((s) => s.signature === signature))

/** `upsertSnapshot`: `signature`'s snapshot at the front of the LRU of four. */
export const upsert = (
	snapshots: ReadonlyArray<Snapshot>,
	signature: string,
	update: (snapshot: Snapshot) => Snapshot,
): ReadonlyArray<Snapshot> => upsertSnapshot({ snapshots }, signature, update).snapshots

export const ColorMode = Schema.Literals(["service", "health", "platform"])
export type ColorMode = typeof ColorMode.Type

export const LayoutStatus = Schema.Literals(["pending", "fallback", "ready"])
export type LayoutStatus = typeof LayoutStatus.Type
