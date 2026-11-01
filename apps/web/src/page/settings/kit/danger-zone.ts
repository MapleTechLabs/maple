import type { Html, HtmlBuilder } from "foldkit/html"
import { panel } from "../../../ui/panel"
import { settingsSection } from "./section"

// The one "Danger zone" section: a destructive-edged panel of rows, each a title, what it does, and its action.

type Children = ReadonlyArray<Html | string>

export const dangerZone = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ id: string; description?: Children }>,
	rows: ReadonlyArray<Html>,
): Html =>
	settingsSection(
		h,
		{ id: options.id, title: "Danger zone", description: options.description, framed: false },
		[panel(h, { className: "divide-y border-destructive-a4" }, rows)],
	)

export const dangerRow = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		title: string
		description: Children
		/** Below the description: a list of what the action takes with it. */
		details?: Html
		action: Html
	}>,
): Html =>
	h.div(
		[h.Class("flex items-start justify-between gap-6 p-4")],
		[
			h.div(
				[h.Class("flex min-w-0 flex-1 flex-col gap-1")],
				[
					h.p([h.Class("text-sm font-medium text-foreground")], [options.title]),
					h.p([h.Class("font-prose text-xs text-muted-foreground")], options.description),
					...(options.details === undefined ? [] : [h.div([h.Class("pt-1")], [options.details])]),
				],
			),
			h.div([h.Class("shrink-0")], [options.action]),
		],
	)
