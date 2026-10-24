import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { icon } from "../../../ui/icon"
import type { Message } from "./message"

// The connect flow's sticky footer: Back on the left, the step's hint and its actions on the right.
// It sits on the page's bottom edge, stuck or not, so it never moves between steps or at the scroll end.

type H = HtmlBuilder<Message>

export type FlowFooterOptions = Readonly<{
	/** Null on a step with no way back (the source already exists). */
	back: Message | null
	hint: string
	actions: ReadonlyArray<Html>
}>

export const flowFooter = (h: H, options: FlowFooterOptions): Html =>
	h.footer(
		[
			h.Class(
				"sticky -bottom-4 -mx-1 mt-auto -mb-4 flex items-center justify-between gap-4 border-t border-border bg-background px-1 py-4",
			),
		],
		[
			options.back === null
				? h.span([], [])
				: button(h, { variant: "outline", attributes: [h.OnClick(options.back)] }, [
						icon(h, "ArrowLeftIcon", { size: 14 }),
						"Back",
					]),
			h.div(
				[h.Class("flex items-center gap-4")],
				[
					h.span(
						[h.Class("hidden text-xs text-muted-foreground @2xl/page:inline")],
						[options.hint],
					),
					...options.actions,
				],
			),
		],
	)
