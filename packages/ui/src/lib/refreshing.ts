/**
 * The dim a view takes while a refetch is in flight over data it is still showing.
 * One opacity and one transition everywhere, so a page with three panels refreshing
 * does not fade them by three different amounts. Pair with `aria-busy={waiting}`.
 */
export function refreshingClass(waiting: boolean): string {
	return waiting ? "opacity-60 transition-opacity" : "transition-opacity"
}
