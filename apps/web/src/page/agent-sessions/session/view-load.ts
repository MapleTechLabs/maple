import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { meter } from "../../../ui/meter"
import { spinner } from "../../../ui/spinner"
import type { LoadProgress } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"

// The session load indicator: how far a large session has loaded.

type H = HtmlBuilder<Message>

export const loadIndicator = (h: H, model: Model, progress: LoadProgress, className?: string): Html => {
	if (progress.phase === "failed")
		return h.div(
			[
				h.DataAttribute("testid", "session-load-indicator"),
				h.Class(cn("flex items-center gap-2 text-xs text-muted-foreground", className)),
			],
			[
				h.span([], ["Couldn't load the rest of this session."]),
				button(
					h,
					{ variant: "outline", size: "xs", attributes: [h.OnClick(Message.ClickedRetryLoad())] },
					["Retry"],
				),
			],
		)
	const totals = Option.getOrUndefined(AsyncData.getData(model.totals.data))
	const isAgent = progress.phase === "agent"
	const loaded = isAgent ? progress.loadedAgentSpans : progress.loadedSpans
	const total = totals === undefined ? undefined : isAgent ? totals.aiSpanCount : totals.spanCount
	const fraction = total === undefined || total <= 0 ? undefined : Math.min(1, loaded / total)
	return h.div(
		[
			h.DataAttribute("testid", "session-load-indicator"),
			h.AriaLive("polite"),
			h.Class(cn("flex min-w-0 flex-col gap-1 text-xs text-muted-foreground", className)),
		],
		[
			h.div(
				[h.Class("flex items-center gap-2")],
				[
					spinner(h, "shrink-0", 12),
					h.span(
						[h.Class("tabular-nums")],
						[
							`Loading ${loaded.toLocaleString("en-US")}`,
							...(total === undefined ? [] : [` of ${total.toLocaleString("en-US")}`]),
							` ${isAgent ? "agent spans" : "spans"}`,
						],
					),
				],
			),
			meter(h, {
				value: fraction ?? 1 / 3,
				fillClassName: "bg-primary/70",
				className: "h-0.5 w-40 bg-muted",
			}),
		],
	)
}
