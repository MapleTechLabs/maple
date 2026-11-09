import { Option, Schema } from "effect"
import { PageOutMessage } from "../contract"

/**
 * A right sheet held in the URL as `?sheet=<id>`: opening pushes it (Back closes the sheet, the
 * link reopens it), and dismissing replaces it away. Pair with `followUrl` / `isDismissed`.
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

/** A page opens the sheet: a new history entry, so Back closes it. */
export const openSheetNavigation = (href: string, id: string): PageOutMessage =>
	PageOutMessage.RequestedNavigation({ url: withSheetParam(href, id), isReplace: false })

/** The sheet was dismissed: the param leaves without adding an entry. */
export const closeSheetNavigation = (href: string): PageOutMessage =>
	PageOutMessage.RequestedNavigation({ url: withSheetParam(href, undefined), isReplace: true })
