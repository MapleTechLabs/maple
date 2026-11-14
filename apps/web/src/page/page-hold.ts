// Navigation's pending state (TanStack's `pendingMs`): the page left stays on screen while the
// entered page has nothing to show, for at most `PAGE_HOLD_MS`, so a page whose reads land in time
// appears whole. One still loading after that shows its skeletons at once: it already waited.

import { Schema, Array as Arr } from "effect"
import { defineTaggedUnion } from "foldkit/schema"
import { isAwaitingReads, isBareSlot, isFirstLoading, isLoading, PageSlot } from "./registry"

export const PAGE_HOLD_MS = 300

/** `Holding`: `leaving` is drawn for page `instance`; `Waited`: `instance` shows, skeletons with no delay. */
export const Model = defineTaggedUnion({
	None: {},
	Holding: { leaving: PageSlot, instance: Schema.Number },
	Waited: { instance: Schema.Number },
})
export type Model = typeof Model.Type

const NONE = Model.None()

/** The page left can stand in for the entered one: same org, both drawn in the shell, and it has
 * something to show (holding one skeleton page over another only delays the next). */
const canStandIn = (left: PageSlot, entered: PageSlot) =>
	left.orgId === entered.orgId && !isBareSlot(left) && !isBareSlot(entered) && !isFirstLoading(left)

/** `next` is a parked page coming back (`parkPages`): it shows its last data, so it never waits. */
export const isRevived = (parked: ReadonlyArray<PageSlot>, next: PageSlot | null): boolean =>
	next !== null &&
	Arr.some(parked, (slot) => slot._tag === next._tag && slot.key === next.key && slot.orgId === next.orgId)

/** The hold after a page write from `previous` to `next`; `revived`: `next` came back from the parked pages. */
export const written = (
	hold: Model,
	previous: PageSlot | null,
	next: PageSlot | null,
	revived: boolean,
): Model => {
	if (next === null) return NONE
	if (previous !== null && previous.instance !== next.instance) {
		// A second navigation during a hold keeps the page that is on screen.
		const leaving = hold._tag === "Holding" ? hold.leaving : previous
		// A literal, not `Model.Holding`: the constructor copies the slot, and the page cache keys on it.
		return !revived && canStandIn(leaving, next) && isAwaitingReads(next)
			? { _tag: "Holding", leaving, instance: next.instance }
			: NONE
	}
	if (hold._tag === "None" || hold.instance !== next.instance) return NONE
	// A hold lasts while the page reads what it opens with: a side read landing first (presence from
	// the cache) is not the page. `Waited` lasts while a read loads: dropping its 0ms delay would hide
	// the skeletons still up.
	return (hold._tag === "Holding" ? isAwaitingReads(next) : isLoading(next)) ? hold : NONE
}

/** `PAGE_HOLD_MS` ran out for `instance`: its page shows, with skeletons at once while it loads. */
export const elapsed = (hold: Model, instance: number, page: PageSlot | null): Model =>
	hold._tag === "Holding" && hold.instance === instance
		? page !== null && page.instance === instance && isLoading(page)
			? Model.Waited({ instance })
			: NONE
		: hold

/** The instance whose timer `written` just started, if it started a hold. */
export const startedHold = (before: Model, after: Model): number | null =>
	after._tag === "Holding" && (before._tag !== "Holding" || before.instance !== after.instance)
		? after.instance
		: null

/** The slot the view draws: the held page while there is one. */
export const shownSlot = (hold: Model, page: PageSlot | null): PageSlot | null =>
	hold._tag === "Holding" ? hold.leaving : page

/** The page frame's `data-page-hold`, when the hold changes how the page is drawn. */
export const holdAttribute = (hold: Model): "held" | "waited" | null =>
	hold._tag === "Holding" ? "held" : hold._tag === "Waited" ? "waited" : null
