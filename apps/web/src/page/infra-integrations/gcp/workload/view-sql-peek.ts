import { gcpAppWait } from "../../../../components/infra/gcp/cloud-sql-signals"
import { EMPTY_VALUE, formatLatency, formatNumber, formatPercent } from "@maple/ui/lib/format"
import { LATENCY_BAR_TONE, latencyLevel, latencyToneClass } from "@maple/ui/lib/latency-tone"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { cn } from "@maple/ui/lib/utils"
import { formatClockInTimezone } from "@maple/web-data/lib/timezone-format"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { LoadFailure } from "../../../../data/load-failure"
import { AppRoute, hrefOf } from "../../../../route"
import { linkButton } from "../../../../ui/button"
import * as CopyButton from "../../../../ui/copy-button"
import * as DialogView from "../../../../ui/dialog-view"
import { emptyMessage } from "../../../../ui/empty"
import { errorState } from "../../../../ui/error-state"
import { eyebrow } from "../../../../ui/eyebrow"
import { icon } from "../../../../ui/icon"
import { meter } from "../../../../ui/meter"
import { skeleton } from "../../../../ui/skeleton"
import { serviceDot } from "../../../../ui/values"
import { heroChip } from "../../../infra/kit/hero-chip"
import { statRail, statRailItem } from "../../../kit/stat-rail"
import type { StatementSpan } from "../data"
import { Message, type Model } from "./model"
import { type QueryPeek, statementTracesHref } from "./peek"
import { appP95Tone, lockTone } from "./view-sql"

// `GcpQueryPeekSheet`: one Query Insights statement, its callers and its slowest traced calls.

type H = HtmlBuilder<Message>
type TimeSearch = Readonly<{ startTime?: string; endTime?: string; timePreset?: string }>

export type QueryPeekInputs = Readonly<{
	peek: QueryPeek | null
	/** `instance / database`, the eyebrow's subject. */
	where: string
	spans: AsyncData.AsyncData<ReadonlyArray<StatementSpan>, LoadFailure>
	/** The traces' side of the instance: until it is in, "not traced" would be a guess. */
	traceSide: AsyncData.AsyncData<unknown, LoadFailure>
	timeSearch: TimeSearch
	timeZone: string
}>

const DB_TRACING_DOCS = "https://maple.dev/docs/concepts/otel-conventions#database-queries"
const SPAN_ROWS = 5
const SUB = "text-2xs text-muted-foreground"

const sectionHead = (h: H, title: string, hint: string): Html =>
	h.div(
		[h.Class("flex items-baseline justify-between gap-3")],
		[
			h.h3([h.Class("shrink-0 text-xs font-semibold text-foreground")], [title]),
			h.span([h.Class(cn(SUB, "truncate"))], [hint]),
		],
	)

const header = (h: H, model: Model, peek: QueryPeek, inputs: QueryPeekInputs): Html => {
	const where = inputs.where
	const id = model.queryPeek.id
	const traced = peek.traced
	return DialogView.dialogHeader(
		h,
		"sheet",
		[
			eyebrow(h, { as: "div", className: "flex items-center gap-2" }, [
				"Statement",
				h.span([h.Class("normal-case tracking-normal")], [`· ${where}`]),
			]),
			DialogView.dialogTitle(h, "sheet", id, `Statement on ${where}`, "sr-only"),
			DialogView.dialogDescription(
				h,
				"sheet",
				id,
				"Query Insights figures for the statement and the traced calls that ran it",
				"sr-only",
			),
			h.div(
				[h.Class("relative rounded-md border bg-background/60")],
				[
					h.pre(
						[
							h.Class(
								"max-h-48 overflow-auto px-3 py-2.5 pr-10 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-foreground",
							),
						],
						[peek.statement.querystring],
					),
					h.div(
						[h.Class("absolute top-1.5 right-1.5")],
						[
							CopyButton.view(h, {
								model: model.copyStatement,
								toParentMessage: (message) => Message.GotCopyStatementMessage({ message }),
								value: peek.statement.querystring,
								label: "statement",
							}),
						],
					),
				],
			),
			h.div(
				[h.Class("flex flex-wrap items-center gap-1.5")],
				[
					heroChip(h, `hash ${peek.statement.queryHash}`),
					heroChip(
						h,
						traced !== undefined
							? `Query Insights + ${traced.serviceCount} ${traced.serviceCount === 1 ? "service" : "services"} traced`
							: AsyncData.isSuccess(inputs.traceSide) ||
								  AsyncData.isRefreshing(inputs.traceSide)
								? "Query Insights only"
								: "Query Insights",
					),
				],
			),
		],
		"gap-2 pr-14",
	)
}

const stats = (h: H, peek: QueryPeek): ReadonlyArray<Html> => {
	const { statement, traced } = peek
	const db = statement.p95LatencyMillis
	const app = traced?.appP95Ms
	const rowsPerCall = statement.calls > 0 ? statement.rows / statement.calls : undefined
	const wait = gcpAppWait(
		[statement],
		traced === undefined ? new Map() : new Map([[statement.queryHash, traced]]),
	)
	const item = (eyebrowText: string, value: string, className?: string) =>
		statRailItem(h, {
			eyebrow: eyebrowText,
			value,
			compact: true,
			className: "px-4 py-3",
			valueClassName: cn("text-xl", className),
		})
	return [
		statRail(h, {}, [
			item("Calls", formatNumber(statement.calls)),
			item(
				"DB p95",
				db === null ? EMPTY_VALUE : formatLatency(db),
				db === null ? undefined : latencyToneClass(db),
			),
			item("App p95", app === undefined ? EMPTY_VALUE : formatLatency(app), appP95Tone(db, app)),
			item("Lock wait", formatPercent(statement.lockShare), lockTone(statement.lockShare)),
		]),
		h.div(
			[h.Class(cn(SUB, "flex flex-wrap gap-x-4 gap-y-1 font-mono"))],
			[
				...(rowsPerCall === undefined
					? []
					: [
							h.span(
								[],
								[
									`${formatNumber(Math.round(rowsPerCall))} ${Math.round(rowsPerCall) === 1 ? "row" : "rows"} per call`,
								],
							),
						]),
				h.span([], [`I/O wait ${formatPercent(statement.ioShare)}`]),
				...(statement.p50LatencyMillis === null
					? []
					: [h.span([], [`DB p50 ${formatLatency(statement.p50LatencyMillis)}`])]),
				h.span([], [`${formatPercent(statement.executionShare)} of instance DB time`]),
			],
		),
		...(wait === null
			? []
			: [
					h.div(
						[h.Class("space-y-1 rounded-md border border-severity-error-a4 p-3")],
						[
							h.p(
								[h.Class("text-xs font-medium text-foreground")],
								[
									`${wait.service} waits ${formatLatency(wait.appP95Ms)} for a query the database runs in ${formatLatency(wait.dbP95Ms)}`,
								],
							),
							h.p(
								[h.Class(SUB)],
								[
									"The time is spent outside the database: the network, or waiting on the connection pool.",
								],
							),
						],
					),
				]),
	]
}

const callers = (h: H, peek: QueryPeek, timeSearch: TimeSearch): Html => {
	const traced = peek.traced
	const services = traced?.services ?? []
	const more = (traced?.serviceCount ?? 0) - services.length
	return h.section(
		[h.Class("space-y-2")],
		[
			sectionHead(h, "Called by", more > 0 ? `the busiest, +${more} more` : "client spans"),
			h.div(
				[h.Class("border-y border-border-subtle")],
				services.map((service) =>
					h.a(
						[
							h.Href(hrefOf(AppRoute.Service({ serviceName: service, search: timeSearch }))),
							h.Class(
								"flex items-center gap-3 border-b border-border-subtle px-1 py-2 last:border-0 hover:bg-surface-sunken active:bg-surface-sunken",
							),
						],
						[
							serviceDot(h, { serviceName: service }),
							h.span(
								[h.Class("min-w-0 flex-1 truncate font-mono text-xs text-foreground")],
								[service],
							),
							h.span(
								[h.Class("text-muted-foreground")],
								[icon(h, "ChevronRightIcon", { size: 14 })],
							),
						],
					),
				),
			),
		],
	)
}

const spanRow = (h: H, span: StatementSpan, slowestMs: number, timeZone: string): Html => {
	const time = formatClockInTimezone(span.timestamp, { timeZone })
	const tone = latencyToneClass(span.durationMs)
	return h.a(
		[
			h.Href(
				hrefOf(
					AppRoute.Trace({
						traceId: span.traceId,
						search: { spanId: span.spanId, t: span.timestamp },
					}),
				),
			),
			h.AriaLabel(`Open trace: ${span.serviceName}, ${formatLatency(span.durationMs)}`),
			h.Class(
				"flex items-center gap-3 border-b border-border-subtle px-1 py-2 last:border-0 hover:bg-surface-sunken active:bg-surface-sunken",
			),
		],
		[
			h.span([h.Class("w-16 shrink-0 font-mono text-2xs tabular-nums text-muted-foreground")], [time]),
			h.span([h.Class("w-28 shrink-0 truncate font-mono text-xs text-foreground")], [span.serviceName]),
			meter(h, {
				value: span.durationMs,
				max: slowestMs,
				minVisible: 4,
				fillClassName: LATENCY_BAR_TONE[latencyLevel(span.durationMs)],
				className: "min-w-0 flex-1",
			}),
			h.span(
				[h.Class(cn("w-14 shrink-0 text-right font-mono text-xs tabular-nums", tone))],
				[formatLatency(span.durationMs)],
			),
			h.span([h.Class("text-muted-foreground")], [icon(h, "ArrowRightIcon", { size: 14 })]),
		],
	)
}

const slowestCalls = (h: H, inputs: QueryPeekInputs): Html => {
	const body = AsyncData.matchData(inputs.spans, {
		onEmpty: () =>
			h.div(
				[h.Class("space-y-2 py-2"), h.AriaBusy(true)],
				Array.from({ length: SPAN_ROWS }, () => skeleton(h, "h-5 w-full rounded-sm")),
			),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Couldn't load the calls",
				variant: "inline",
				onRetry: Message.ClickedRetryStatementSpans(),
			}),
		onData: (spans) =>
			spans.length === 0
				? emptyMessage(h, { dashed: true, className: "px-3 py-4 text-xs" }, [
						"No traced call of it was kept in this window",
					])
				: h.div(
						[
							h.Class(
								cn(
									"border-y border-border-subtle",
									refreshingClass(AsyncData.isRefreshing(inputs.spans)),
								),
							),
						],
						spans.map((span) => spanRow(h, span, spans[0]?.durationMs ?? 0, inputs.timeZone)),
					),
	})
	return h.section(
		[h.Class("space-y-2")],
		[sectionHead(h, "Slowest calls", "open one to see its whole trace"), body],
	)
}

const notTraced = (h: H): Html =>
	h.div(
		[h.Class("flex flex-col items-start gap-3 rounded-md border border-dashed px-5 py-6")],
		[
			h.span(
				[
					h.Class(
						"flex size-8 items-center justify-center rounded-md bg-muted text-muted-foreground",
					),
				],
				[icon(h, "DatabaseIcon", { size: 16 })],
			),
			h.h3([h.Class("text-sm font-semibold text-foreground")], ["No traces recorded this query"]),
			h.p(
				[h.Class("max-w-md text-xs leading-relaxed text-muted-foreground")],
				[
					"No client span with this statement reached Maple in the window, so there is no caller or trace to open. Trace the service that runs it with OpenTelemetry's database instrumentation, keeping ",
					h.code([h.Class("font-mono")], ["db.query.text"]),
					" on the span.",
				],
			),
			linkButton(
				h,
				{
					variant: "outline",
					size: "sm",
					href: DB_TRACING_DOCS,
					attributes: [h.Target("_blank"), h.Rel("noreferrer")],
				},
				["Set up database tracing", icon(h, "ArrowRightIcon")],
			),
		],
	)

/** A statement the traces did not match: still loading, failed, or not traced at all. */
const untraced = (h: H, inputs: QueryPeekInputs): Html =>
	AsyncData.matchData(inputs.traceSide, {
		onEmpty: () => skeleton(h, "h-40 w-full rounded-md"),
		onFailure: (failure) =>
			errorState(h, { failure, title: "Couldn't load what the traces saw", variant: "inline" }),
		onData: () => notTraced(h),
	})

const footer = (h: H, peek: QueryPeek, timeSearch: TimeSearch): Html =>
	DialogView.dialogFooter(
		h,
		"sheet",
		[
			h.span(
				[h.Class("font-mono text-2xs tabular-nums text-muted-foreground")],
				[`${peek.index + 1} of ${peek.count} statements`],
			),
			...(peek.traced === undefined
				? []
				: [
						linkButton(h, { size: "sm", href: statementTracesHref(peek, timeSearch) }, [
							"View in Traces",
							icon(h, "ArrowRightIcon"),
						]),
					]),
		],
		"flex-row items-center justify-between gap-3 border-t py-3 sm:justify-between",
	)

const content = (h: H, model: Model, peek: QueryPeek, inputs: QueryPeekInputs): ReadonlyArray<Html> => [
	header(h, model, peek, inputs),
	DialogView.dialogPanel(
		h,
		"sheet",
		model.queryPeek.id,
		[
			...stats(h, peek),
			...(peek.traced === undefined
				? [untraced(h, inputs)]
				: [callers(h, peek, inputs.timeSearch), slowestCalls(h, inputs)]),
		],
		"space-y-5",
	),
	footer(h, peek, inputs.timeSearch),
]

/** The sheet; its content renders only while a statement is peeked. */
export const queryPeekSheet = (h: H, model: Model, inputs: QueryPeekInputs): Html =>
	h.submodel({
		slotId: `${model.queryPeek.id}-sheet`,
		model: model.queryPeek,
		view: DialogView.view,
		viewInputs: {
			className: "p-0 sm:max-w-xl",
			side: "right",
			hasTrigger: false,
			toView: ({ portal }) => portal,
			toContent: () => (inputs.peek === null ? [] : content(h, model, inputs.peek, inputs)),
		},
		toParentMessage: (message) => Message.GotQueryPeekMessage({ message }),
	})
