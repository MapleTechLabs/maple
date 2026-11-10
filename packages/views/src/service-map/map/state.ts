import { upsertSnapshot } from "../graph/service-map-layout-state"
import { readLocalStorage, writeLocalStorage } from "@maple/ui/lib/local-storage"
import { Array as Arr, Effect, Option, Schema } from "effect"
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

/** What a map keeps per browser: declutter prefs and layout snapshots. */
export const Stored = Schema.Struct({ prefs: ViewPrefs, snapshots: Schema.Array(Snapshot) })
export type Stored = typeof Stored.Type

/** The localStorage keys a host app keeps its map under (Maple Local's differ from the dashboard's, per org). */
export type StoredKeys = Readonly<{ prefs: string; layout: string }>

const LayoutJson = Schema.fromJsonString(Schema.Struct({ snapshots: Schema.Array(Snapshot) }))
const PrefsJson = Schema.fromJsonString(ViewPrefs)

/** The stored map; an unreadable entry falls back to the defaults. */
export const readStored = (keys: StoredKeys): Stored => ({
	prefs: Option.getOrElse(
		Option.flatMap(readLocalStorage(keys.prefs), Schema.decodeUnknownOption(PrefsJson)),
		() => DEFAULT_VIEW_PREFS,
	),
	snapshots: Option.match(
		Option.flatMap(readLocalStorage(keys.layout), Schema.decodeUnknownOption(LayoutJson)),
		{ onNone: () => [], onSome: (layout) => layout.snapshots },
	),
})

/** Writes the declutter prefs; a failed write is dropped. */
export const saveStoredPrefs = (keys: StoredKeys, prefs: ViewPrefs): Effect.Effect<void> =>
	Schema.encodeEffect(PrefsJson)(prefs).pipe(
		Effect.flatMap((text) => Effect.sync(() => writeLocalStorage(keys.prefs, text))),
		Effect.ignore,
	)

/** Writes the layout snapshots; a failed write is dropped. */
export const saveStoredLayout = (keys: StoredKeys, snapshots: ReadonlyArray<Snapshot>): Effect.Effect<void> =>
	Schema.encodeEffect(LayoutJson)({ snapshots }).pipe(
		Effect.flatMap((text) => Effect.sync(() => writeLocalStorage(keys.layout, text))),
		Effect.ignore,
	)

export const snapshotFor = (snapshots: ReadonlyArray<Snapshot>, signature: string): Option.Option<Snapshot> =>
	Arr.findFirst(snapshots, (s) => s.signature === signature)

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
