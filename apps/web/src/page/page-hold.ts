import type { PageSlotBase } from "./contract"

/**
 * Navigation's pending state (TanStack's `pendingMs`): the page left stays on screen while the
 * entered one's first reads run, for at most `PAGE_HOLD_MS`. A page whose reads land in time
 * appears whole, never as a frame of blanks. One that is still loading then shows its skeletons at
 * once (`Waited`): it already waited the skeleton delay.
 */
export const PAGE_HOLD_MS = 300

export type PageHold<S> =
	| { readonly _tag: "None" }
	| { readonly _tag: "Holding"; readonly leaving: S; readonly instance: number }
	| { readonly _tag: "Waited"; readonly instance: number }

const NONE = { _tag: "None" } as const

export const noHold = <S>(): PageHold<S> => NONE

/**
 * The hold after a page write. `isLoading`: `next` still waits on a first read. Entering a page of
 * the same org holds the page on screen (the one left, or the one already held); anything else
 * keeps the hold only while it is the same instance and still loading.
 */
export const written = <S extends PageSlotBase>(
	hold: PageHold<S>,
	previous: S | null,
	next: S | null,
	isLoading: boolean,
): PageHold<S> => {
	if (next === null || !isLoading) return NONE
	if (previous !== null && previous.instance !== next.instance) {
		const leaving = hold._tag === "Holding" ? hold.leaving : previous
		return leaving.orgId === next.orgId ? { _tag: "Holding", leaving, instance: next.instance } : NONE
	}
	return hold._tag !== "None" && hold.instance === next.instance ? hold : NONE
}

/** `PAGE_HOLD_MS` ran out for `instance`: its page shows, with skeletons at once while it loads. */
export const elapsed = <S>(hold: PageHold<S>, instance: number, isLoading: boolean): PageHold<S> =>
	hold._tag === "Holding" && hold.instance === instance
		? isLoading
			? { _tag: "Waited", instance }
			: NONE
		: hold

/** A hold that `written` just started, which needs its timer. */
export const startedHold = <S>(before: PageHold<S>, after: PageHold<S>): number | null =>
	after._tag === "Holding" && (before._tag !== "Holding" || before.instance !== after.instance)
		? after.instance
		: null

/** The slot the view draws: the held page while there is one. */
export const shownSlot = <S>(hold: PageHold<S>, page: S | null): S | null =>
	hold._tag === "Holding" ? hold.leaving : page

/** The page frame's `data-page-hold`, when the hold changes how the page is drawn. */
export const holdAttribute = <S>(hold: PageHold<S>): "held" | "waited" | null =>
	hold._tag === "Holding" ? "held" : hold._tag === "Waited" ? "waited" : null
