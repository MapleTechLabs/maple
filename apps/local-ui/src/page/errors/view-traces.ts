import { errorState } from "@maple/views/ui/error-state"
import { parseClickHouseDateTime } from "../../lib/time"
import { formatDuration } from "@maple/ui/lib/format"
import { dividedList } from "@maple/views/ui/rule"
import { spinner } from "@maple/views/ui/spinner"
import { hstack, hstackClass } from "@maple/views/ui/stack"
import { timestamp } from "@maple/views/ui/timestamp"
import { typography } from "@maple/views/ui/typography"
import type { DateTime } from "effect"
import { Option, Array as Arr, Record as Rec } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { failureWithoutData, isAwaitingFirstData } from "@maple/views/data/keyed"
import { hrefFor } from "../../route"
import type { ErrorTrace, ErrorTypeRow } from "./fetch"
import { Message } from "./message"
import type { Card } from "./model"

// The open panel of `ErrorTypeCard`: the most recent traces of one error type.

type H = HtmlBuilder<Message>

/** The clock the page last read, and the zone its timestamps' cards read in. */
export type Clock = Readonly<{ nowMs: number; timeZone: string }>

/** A relative `timestamp` against the page's clock. */
export const relativeTime = (h: H, value: DateTime.Utc, clock: Clock): Html | string => {
	const ms = parseClickHouseDateTime(value)
	return ms === null
		? "-"
		: timestamp(h, {
				value: ms,
				format: "relative",
				nowMs: clock.nowMs,
				timeZone: clock.timeZone,
				className: "cursor-pointer",
			})
}

/** `traceLinkParams`: the view's params, plus the error span to focus when the trace has one. */
const traceLinkHref = (trace: ErrorTrace, query: URLSearchParams): string => {
	const params = new URLSearchParams(Rec.fromEntries(query))
	if (trace.errorSpanId) params.set("spanId", trace.errorSpanId)
	return hrefFor(`/traces/${encodeURIComponent(trace.traceId)}`, params)
}

const traceItem = (h: H, trace: ErrorTrace, query: URLSearchParams, clock: Clock): Html =>
	h.li(
		[h.Key(trace.traceId)],
		[
			h.a(
				[
					h.Href(traceLinkHref(trace, query)),
					h.Class(
						hstackClass({
							gap: "3",
							className:
								"w-full py-2 text-left text-xs text-muted-foreground hover:text-foreground active:text-foreground",
						}),
					),
				],
				[
					typography(h, { mono: true, truncate: true, className: "min-w-0 flex-1" }, [
						trace.errorSpanName || trace.rootSpanName || trace.traceId,
						...(trace.errorServiceName
							? [h.span([h.Class("ml-2 text-foreground-subtle")], [trace.errorServiceName])]
							: []),
					]),
					typography(h, { numeric: true, className: "shrink-0" }, [
						String(trace.spanCount),
						" spans",
					]),
					typography(h, { numeric: true, className: "shrink-0" }, [
						formatDuration(trace.durationMicros / 1000),
					]),
					typography(h, { numeric: true, className: "shrink-0" }, [
						relativeTime(h, trace.startTime, clock),
					]),
				],
			),
		],
	)

export const cardTraces = (
	h: H,
	row: ErrorTypeRow,
	card: Card,
	query: URLSearchParams,
	clock: Clock,
): Html => {
	if (isAwaitingFirstData(card.traces))
		return hstack(h, { justify: "center", className: "h-16" }, [spinner(h, "size-4")])
	const failure = failureWithoutData(card.traces)
	if (Option.isSome(failure))
		return errorState(h, {
			failure: failure.value,
			title: "Couldn’t load traces",
			onRetry: Message.ClickedRetryTraces({ fingerprintHash: row.fingerprintHash }),
		})
	const traces = Option.getOrElse(AsyncData.getData(card.traces.data), () => [])
	if (traces.length === 0)
		return typography(h, { as: "p", size: "xs", tone: "muted", className: "py-2" }, [
			"No traces found for this error in the selected range.",
		])
	return dividedList(
		h,
		{ as: "ul", bordered: false },
		Arr.map(traces, (trace) => traceItem(h, trace, query, clock)),
	)
}
