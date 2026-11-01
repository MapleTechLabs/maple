import { cn } from "@maple/ui/lib/utils"
import { makeClientErrorBody } from "@maple/web-data/lib/error-messages"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { errorState } from "../../../ui/error-state"
import { meter } from "../../../ui/meter"
import { spinner } from "../../../ui/spinner"
import type { LoadProgress } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"

// The session load indicator: how far a large session has loaded.

type H = HtmlBuilder<Message>

/** A later page of a large session failed; what already loaded stays on screen. */
export const REST_LOAD_FAILURE = makeClientErrorBody({
	_tag: "@maple/web/errors/SessionRestLoadFailed",
	code: "session_rest_unavailable",
	title: "Couldn't load the rest of this session",
	message: "The spans loaded so far are still shown.",
	retryable: false,
	recovery: "retry",
})

export const loadIndicator = (h: H, model: Model, progress: LoadProgress, className?: string): Html => {
	if (progress.phase === "failed")
		return h.div(
			[h.DataAttribute("testid", "session-load-indicator"), h.Class(cn("flex", className))],
			[errorState(h, { failure: REST_LOAD_FAILURE, variant: "quiet", onRetry: Message.ClickedRetryLoad() })],
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
