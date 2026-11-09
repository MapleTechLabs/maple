import { Effect, Option, Schema } from "effect"
import { back, replaceUrl } from "foldkit/navigation"

/**
 * A side sheet held in the URL as `?sheet=<id>`. Opening pushes an entry this tab marks as its own,
 * so dismissing it goes back (Back after a close never lands on the same page again); a deep link
 * or a sheet opened by another tab's entry replaces the param away instead. Pages wrap
 * `pushSheetUrl` / `dismissSheetUrl` in a Command and follow the URL with `followUrl`.
 */
export const SHEET_PARAM = "sheet"

/** Spread into a route's search schema. */
export const SheetSearchFields = { [SHEET_PARAM]: Schema.optional(Schema.String) }

const BASE = "http://maple.local"

/** `href` with `?sheet=` set to `id`, or removed when `id` is undefined; other params stay. */
export const withSheetParam = (href: string, id: string | undefined): string => {
	const url = new URL(href, BASE)
	if (id === undefined) url.searchParams.delete(SHEET_PARAM)
	else url.searchParams.set(SHEET_PARAM, id)
	return `${url.pathname}${url.search}${url.hash}`
}

/** The open sheet named in `href`, if any. */
export const sheetParamOf = (href: string): Option.Option<string> =>
	Option.filter(Option.fromNullOr(new URL(href, BASE).searchParams.get(SHEET_PARAM)), (id) => id !== "")

/** The history entry state `pushSheetUrl` writes. */
export const SheetHistoryState = Schema.Struct({ mapleSheet: Schema.String })
const decodeSheetState = Schema.decodeUnknownOption(SheetHistoryState)

export type SheetDismissal = Readonly<{ _tag: "Back" }> | Readonly<{ _tag: "Replace"; url: string }>

/** Back when the current entry is the one this tab pushed for `id`, else replace the param away. */
export const dismissalOf = (historyState: unknown, href: string, id: string): SheetDismissal =>
	Option.exists(decodeSheetState(historyState), (state) => state.mapleSheet === id)
		? { _tag: "Back" }
		: { _tag: "Replace", url: withSheetParam(href, undefined) }

/** Opens the sheet: a marked history entry, announced the way foldkit's `pushUrl` does. */
export const pushSheetUrl = (href: string, id: string): Effect.Effect<void> =>
	Effect.sync(() => {
		const state: typeof SheetHistoryState.Type = { mapleSheet: id }
		window.history.pushState(state, "", withSheetParam(href, id))
		window.dispatchEvent(new CustomEvent("foldkit:urlchange"))
	})

/** Dismisses it (Escape, backdrop, close, Cancel): see `dismissalOf`. */
export const dismissSheetUrl = (href: string, id: string): Effect.Effect<void> =>
	Effect.suspend(() => {
		const dismissal = dismissalOf(window.history.state, href, id)
		return dismissal._tag === "Back" ? back() : replaceUrl(dismissal.url)
	})
