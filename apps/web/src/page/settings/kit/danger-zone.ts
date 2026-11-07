import type { Html, HtmlBuilder } from "foldkit/html"
import { panel } from "@maple/views/ui/panel"
import { settingsSection } from "./section"
import { typography } from "@maple/views/ui/typography"
import { hstack, vstack } from "@maple/views/ui/stack"

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
	hstack(h, { gap: "6", align: "start", justify: "between", className: "p-4" }, [
		vstack(h, { gap: "1", shrink: true, grow: true }, [
			typography(h, { size: "sm", tone: "foreground", weight: "medium", as: "p" }, [options.title]),
			typography(
				h,
				{ size: "xs", tone: "muted", as: "p", className: "font-prose" },
				options.description,
			),
			...(options.details === undefined ? [] : [h.div([h.Class("pt-1")], [options.details])]),
		]),
		h.div([h.Class("shrink-0")], [options.action]),
	])
