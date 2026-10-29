import { parseClickHouseDateTime } from "../../lib/time"
import { formatDuration } from "@maple/ui/lib/format"
import { formatRelativeFrom } from "@maple/ui/lib/time-format"
import { spinner } from "@maple/web/ui/spinner"
import type { DateTime } from "effect"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html } from "foldkit/html"
import type { ErrorsViewBuilder } from "./composition"
import { failureWithoutData, isPending } from "../../data/slot"
import { hrefFor } from "../../route"
import { errorState } from "../kit/view-states"
import type { ErrorTrace, ErrorTypeRow } from "./fetch"
import { Message } from "./message"
import type { Card } from "./model"

// The open panel of `ErrorTypeCard`: the most recent traces of one error type.

type H = ErrorsViewBuilder

/** `formatRelativeTime` against the clock the page last read. */
export const relativeTime = (value: DateTime.Utc, nowMs: number): string => {
	const ms = parseClickHouseDateTime(value)
	return ms === null ? "-" : formatRelativeFrom(ms, nowMs)
}

/** `traceLinkParams`: the view's params, plus the error span to focus when the trace has one. */
const traceLinkHref = (trace: ErrorTrace, query: URLSearchParams): string => {
	const params = new URLSearchParams(Object.fromEntries(query))
	if (trace.errorSpanId) params.set("spanId", trace.errorSpanId)
	return hrefFor(`/traces/${encodeURIComponent(trace.traceId)}`, params)
}

const traceItem = (h: H, trace: ErrorTrace, query: URLSearchParams, nowMs: number): Html =>
	h.li(
		[h.Key(trace.traceId)],
		[
			h.a(
				[
					h.Href(traceLinkHref(trace, query)),
					h.Class(
						"flex w-full items-center gap-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground",
					),
				],
				[
					h.span(
						[h.Class("min-w-0 flex-1 truncate font-mono")],
						[
							trace.errorSpanName || trace.rootSpanName || trace.traceId,
							...(trace.errorServiceName
								? [h.span([h.Class("ml-2 text-muted-foreground/70")], [trace.errorServiceName])]
								: []),
						],
					),
					h.span([h.Class("shrink-0 tabular-nums")], [String(trace.spanCount), " spans"]),
					h.span([h.Class("shrink-0 tabular-nums")], [formatDuration(trace.durationMicros / 1000)]),
					h.span([h.Class("shrink-0 tabular-nums")], [relativeTime(trace.startTime, nowMs)]),
				],
			),
		],
	)

export const cardTraces = (h: H, row: ErrorTypeRow, card: Card, query: URLSearchParams, nowMs: number): Html => {
	if (isPending(card.traces))
		return h.div([h.Class("flex h-16 items-center justify-center")], [spinner(h, "size-4")])
	const failure = failureWithoutData(card.traces)
	if (Option.isSome(failure))
		return errorState(h, {
			label: "traces",
			failure: failure.value,
			onRetry: Message.ClickedRetryTraces({ fingerprintHash: row.fingerprintHash }),
		})
	const traces = Option.getOrElse(AsyncData.getData(card.traces.data), () => [])
	if (traces.length === 0)
		return h.p([h.Class("py-2 text-xs text-muted-foreground")], ["No traces found for this error in the selected range."])
	return h.ul([h.Class("divide-y")], traces.map((trace) => traceItem(h, trace, query, nowMs)))
}
