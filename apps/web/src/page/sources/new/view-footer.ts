import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import { icon } from "@maple/views/ui/icon"
import type { Message } from "./message"
import type { FlowHost } from "./model"
import { actionBar } from "@maple/views/ui/action-bar"
import { typography } from "@maple/views/ui/typography"

// The connect flow's sticky footer (kit `actionBar`): Back on the left, the step's hint and its
// actions on the right. In the drawer it insets to the sheet panel's padding.

type H = HtmlBuilder<Message>

export type FlowFooterOptions = Readonly<{
	/** Null on a step with no way back (the source already exists). */
	back: Message | null
	hint: string
	actions: ReadonlyArray<Html>
	host: FlowHost
}>

/** In the drawer the bar insets to the sheet panel's padding. */
const FOOTER_LAYOUT = {
	page: "",
	drawer: "mx-6",
} satisfies Record<FlowHost, string>

export const flowFooter = (h: H, options: FlowFooterOptions): Html =>
	actionBar(h, {
		label: "Step actions",
		as: "footer",
		className: FOOTER_LAYOUT[options.host],
		leading:
			options.back === null
				? []
				: [
						button(h, { variant: "outline", size: "sm", attributes: [h.OnClick(options.back)] }, [
							icon(h, "ArrowLeftIcon", { size: 14 }),
							"Back",
						]),
					],
		actions: [
			typography(h, { size: "xs", tone: "muted", className: "hidden @2xl/page:inline" }, [options.hint]),
			...options.actions,
		],
	})
