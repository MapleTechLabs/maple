// Navigation's pending state (TanStack's `pendingMs`): the page left stays on screen while the
// entered page has nothing to show, for at most `PAGE_HOLD_MS`, so a page whose reads land in time
// appears whole. One still loading after that shows its skeletons at once: it already waited.

import { Schema } from "effect"
import { defineTaggedUnion } from "foldkit/schema"
import { isBareSlot, isFirstLoading, PageSlot } from "./registry"

export const PAGE_HOLD_MS = 300

/** `Holding`: `leaving` is drawn for page `instance`; `Waited`: `instance` shows, skeletons with no delay. */
export const Model = defineTaggedUnion({
	None: {},
	Holding: { leaving: PageSlot, instance: Schema.Number },
	Waited: { instance: Schema.Number },
})
export type Model = typeof Model.Type

const NONE = Model.None()

/** The page left can stand in for the entered one: same org, both drawn in the shell. */
const canStandIn = (left: PageSlot, entered: PageSlot) =>
	left.orgId === entered.orgId && !isBareSlot(left) && !isBareSlot(entered)

/** The hold after a page write from `previous` to `next`. */
export const written = (hold: Model, previous: PageSlot | null, next: PageSlot | null): Model => {
	if (next === null) return NONE
	if (previous !== null && previous.instance !== next.instance) {
		// A second navigation during a hold keeps the page that is on screen.
		const leaving = hold._tag === "Holding" ? hold.leaving : previous
		// A literal, not `Model.Holding`: the constructor copies the slot, and the page cache keys on it.
		return canStandIn(leaving, next) && isFirstLoading(next)
			? { _tag: "Holding", leaving, instance: next.instance }
			: NONE
	}
	return hold._tag !== "None" && hold.instance === next.instance && isFirstLoading(next) ? hold : NONE
}

/** `PAGE_HOLD_MS` ran out for `instance`: its page shows, with skeletons at once while it loads. */
export const elapsed = (hold: Model, instance: number, page: PageSlot | null): Model =>
	hold._tag === "Holding" && hold.instance === instance
		? page !== null && page.instance === instance && isFirstLoading(page)
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
