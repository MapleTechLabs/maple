import { Array, Option } from "effect"
import { AsyncData } from "foldkit"
import { STALE_MS } from "./cached"
import { shownOf, type Slot } from "./slot"

// What the open page shows from its
// queries, and how old it is. A page's queries are the Slots in its Model (and its panel's).

/** The page's fields, nested state (the span panel) and keyed state (an error card under its hash). */
const SLOT_DEPTH = 3

const isSlot = (value: unknown): value is Slot<unknown> =>
	typeof value === "object" &&
	value !== null &&
	"key" in value &&
	"isPlaceholder" in value &&
	"isStandIn" in value &&
	"data" in value &&
	AsyncData.isAsyncData(value.data)

/** Every Slot in a page Model, down to keyed nested state. Rows arrays never hold one, so they are skipped. */
export const slotsOf = (model: unknown, depth = SLOT_DEPTH): ReadonlyArray<Slot<unknown>> => {
	if (typeof model !== "object" || model === null || Array.isArray(model) || depth === 0) return []
	return Object.values(model).flatMap((value) => (isSlot(value) ? [value] : slotsOf(value, depth - 1)))
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

const minOf = (values: ReadonlyArray<number>): number | null => (values.length === 0 ? null : Math.min(...values))

export const shownDataOf = (model: unknown, nowMs: number): ShownData => {
	const slots = slotsOf(model)
	const shown = Array.getSomes(slots.map(shownOf))
	const stale = shown.filter((item) => item.isStandIn || item.isFailed || (item.isRefreshing && nowMs - item.atMs >= STALE_MS))
	return {
		hasData: slots.some((slot) => Option.isSome(AsyncData.getData(slot.data))),
		shownAsOfMs: minOf(shown.map((item) => item.atMs)),
		staleAsOfMs: minOf(stale.map((item) => item.atMs)),
		refreshFailed: shown.some((item) => item.isFailed),
	}
}
