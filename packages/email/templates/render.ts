/**
 * Renders a template unit to markup with Foldkit's static server render.
 *
 * Build-time only: nothing under `templates/` is imported by `src/`, so the
 * Worker runtime never loads Foldkit.
 */
import { Effect, Array as Arr, String as Str } from "effect"
import { renderToString } from "foldkit/experimental/server"
import type { Html, HtmlBuilder } from "foldkit/html"

export type H = HtmlBuilder<never>

/** What an element accepts as children (Foldkit does not export the alias). */
export type Child = Html | string

/**
 * Where a unit's root nodes sit in the HTML grammar. Foldkit verifies that its
 * output parses back to the same tree, and a `<tr>` outside a table does not,
 * so each unit renders inside the parent it will be spliced into and that
 * parent is cut off again afterwards.
 */
export type Context = "flow" | "tbody" | "tr"

export interface Unit {
	readonly context: Context
	readonly view: (h: H) => ReadonlyArray<Child>
}

const CARRIERS = {
	flow: { open: "<div>", close: "</div>" },
	tbody: { open: "<table><tbody>", close: "</tbody></table>" },
	tr: { open: "<table><tbody><tr>", close: "</tr></tbody></table>" },
} as const satisfies Record<Context, { readonly open: string; readonly close: string }>

function carrier(h: H, context: Context, children: ReadonlyArray<Child>): Html {
	switch (context) {
		case "flow":
			return h.div([], children)
		case "tbody":
			return h.table([], [h.tbody([], children)])
		case "tr":
			return h.table([], [h.tbody([], [h.tr([], children)])])
	}
}

/**
 * A `[[#name]]` hole where the grammar only allows rows or cells. Text there
 * would be foster-parented out of the table, so the hole renders as an empty
 * element that {@link renderUnit} swaps back for the token.
 */
export const rowsSlot = (h: H, name: string): Html => h.tr([h.Attribute("data-slot", name)], [])
export const cellsSlot = (h: H, name: string): Html => h.td([h.Attribute("data-slot", name)], [])

const SLOT_ELEMENT = /<(tr|td) data-slot="([A-Za-z0-9_]+)"><\/\1>/g

export function renderUnit(unit: Unit): Promise<string> {
	const { open, close } = CARRIERS[unit.context]
	return Effect.runPromise(
		renderToString(
			{
				init: () => ({ model: {} }),
				view: (_model, h: H) => ({ title: "", body: carrier(h, unit.context, unit.view(h)) }),
			},
			{ isHydratable: false },
		),
	).then(({ html }) => {
		if (!Str.startsWith(open)(html) || !Str.endsWith(close)(html)) {
			throw new Error(`Rendered unit is not wrapped in its ${unit.context} carrier`)
		}
		return Str.replace(SLOT_ELEMENT, "[[#$2]]")(Str.slice(open.length, html.length - close.length)(html))
	})
}

const MARK_SRC = "https://maple.dev/brand/logo/maple-mark-amber-256.png"

/** Doctype and head around a page body, as react-email used to emit them. */
export function documentShell(body: string): string {
	return Arr.join(
		[
			'<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">',
			'<html dir="ltr" lang="en"><head>',
			'<meta content="text/html; charset=UTF-8" http-equiv="Content-Type" />',
			'<meta name="x-apple-disable-message-reformatting" />',
			`<link rel="preload" as="image" href="${MARK_SRC}" />`,
			'</head><body style="background-color:#141210;margin:0;padding:0;">',
			body,
			"</body></html>",
		],
		"",
	)
}

export { MARK_SRC }
