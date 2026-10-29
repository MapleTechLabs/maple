import { Effect, Option, type Scope } from "effect"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { input } from "../ui/input"

/** `NamespaceScopeList`'s search: it only earns its row once the list is this long. */
export const SEARCH_THRESHOLD = 8

export const hasNamespaceSearch = (observed: ReadonlyArray<string>): boolean =>
	observed.length >= SEARCH_THRESHOLD

const trimmedOf = (query: string) => query.trim().toLowerCase()

/** The observed namespaces the query matches (all of them for a blank query). */
export const matchingNamespaces = (observed: ReadonlyArray<string>, query: string): ReadonlyArray<string> => {
	const trimmed = trimmedOf(query)
	return trimmed === "" ? observed : observed.filter((name) => name.toLowerCase().includes(trimmed))
}

/** What the list shows for a query: "All namespaces" only unfiltered, the unseen pin while it matches. */
export const namespaceRows = (
	observed: ReadonlyArray<string>,
	pinned: Option.Option<string>,
	query: string,
) => {
	const trimmed = trimmedOf(query)
	const matches = matchingNamespaces(observed, query)
	const unseenPin = Option.filter(
		pinned,
		(name) => !observed.includes(name) && (trimmed === "" || name.toLowerCase().includes(trimmed)),
	)
	return {
		isFiltered: trimmed !== "",
		matches,
		unseenPin,
		isNoMatch: matches.length === 0 && trimmed !== "",
	}
}

/** `<div className="p-1 pb-1.5"><Input autoFocus placeholder size="sm" /></div>`. */
export const namespaceSearchRow = <Message, R = never>(
	h: HtmlBuilder<Message, R>,
	options: Readonly<{
		id: string
		query: string
		/** The row's own attributes (its Mount); `attributes` go on the input. */
		rowAttributes: ReadonlyArray<Attribute<Message, R>>
		attributes: ReadonlyArray<Attribute<Message>>
	}>,
): Html =>
	h.div(
		[h.Class("p-1 pb-1.5"), ...options.rowAttributes],
		[
			input(h, {
				id: options.id,
				size: "sm",
				attributes: [
					h.Placeholder("Search namespaces…"),
					h.Value(options.query),
					...options.attributes,
				],
			}),
		],
	)

export const noNamespacesMatch = <Message>(h: HtmlBuilder<Message>): Html =>
	h.div([h.Class("px-2 py-1.5 text-xs text-muted-foreground")], ["No namespaces match"])

/**
 * The search input's mount: it takes focus (`autoFocus`) and its keydowns stop there, so the
 * menu's own keys and typeahead do not act while typing (`onKeyDown={e => e.stopPropagation()}`).
 */
export const containSearchKeys = (element: Element): Effect.Effect<void, never, Scope.Scope> =>
	Effect.acquireRelease(
		Effect.sync(() => {
			const field = element.querySelector("input")
			if (field instanceof HTMLElement) field.focus({ preventScroll: true })
			const onKeyDown = (event: Event) => event.stopPropagation()
			element.addEventListener("keydown", onKeyDown)
			return onKeyDown
		}),
		(onKeyDown) => Effect.sync(() => element.removeEventListener("keydown", onKeyDown)),
	).pipe(Effect.asVoid)
