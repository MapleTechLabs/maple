import { Array, Option, Record as Rec } from "effect"
import { AsyncData } from "foldkit"
import { STALE_MS } from "./cached"
import type { Keyed } from "@maple/views/data/keyed"

// What the open page shows from its
// queries, and how old it is. A page's queries are the Keyed slots in its Model (and its panel's).

/** The page's fields, nested state (the span panel) and keyed state (an error card under its hash). */
const SLOT_DEPTH = 3

type Slot = Keyed<unknown, unknown>

const isSlot = (value: unknown): value is Slot =>
	typeof value === "object" &&
	value !== null &&
	"key" in value &&
	"data" in value &&
	AsyncData.isAsyncData(value.data)

/** Every slot in a page Model, down to keyed nested state. Rows arrays never hold one, so they are skipped. */
export const slotsOf = (model: unknown, depth = SLOT_DEPTH): ReadonlyArray<Slot> => {
	if (typeof model !== "object" || model === null || Array.isArray(model) || depth === 0) return []
	return Array.flatMap(Rec.values(model), (value) => (isSlot(value) ? [value] : slotsOf(value, depth - 1)))
}

type Shown = Readonly<{ atMs: number; isStandIn: boolean; isRefreshing: boolean; isFailed: boolean }>

/** The slot's data as the stale-data notice sees it: none for retained or untracked slots. */
const shownOf = (slot: Slot): Option.Option<Shown> => {
	if (
		slot.retained === true ||
		slot.updatedAtMs === undefined ||
		Option.isNone(AsyncData.getData(slot.data))
	)
		return Option.none()
	return Option.some({
		atMs: slot.updatedAtMs,
		isStandIn: slot.isStandIn === true,
		isRefreshing: AsyncData.isRefreshing(slot.data),
		isFailed: AsyncData.isStale(slot.data),
	})
}

export type ShownData = Readonly<{
	/** Any result is on hand, so the views have something to show without the server. */
	hasData: boolean
	/** Fetch time of the oldest result on screen, or null when nothing is shown. */
	shownAsOfMs: number | null
	/** Fetch time of the oldest result standing in for one that has not loaded or failed to refresh. */
	staleAsOfMs: number | null
	/** A shown result's refresh failed. */
	refreshFailed: boolean
}>

const minOf = (values: ReadonlyArray<number>): number | null =>
	values.length === 0 ? null : Math.min(...values)

export const shownDataOf = (model: unknown, nowMs: number): ShownData => {
	const slots = slotsOf(model)
	const shown = Array.getSomes(Array.map(slots, shownOf))
	const stale = Array.filter(
		shown,
		(item) => item.isStandIn || item.isFailed || (item.isRefreshing && nowMs - item.atMs >= STALE_MS),
	)
	return {
		hasData: Array.some(slots, (slot) => Option.isSome(AsyncData.getData(slot.data))),
		shownAsOfMs: minOf(Array.map(shown, (item) => item.atMs)),
		staleAsOfMs: minOf(Array.map(stale, (item) => item.atMs)),
		refreshFailed: Array.some(shown, (item) => item.isFailed),
	}
}
