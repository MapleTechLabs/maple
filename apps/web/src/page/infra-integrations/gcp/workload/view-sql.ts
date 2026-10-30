import {
	gcpPoolFull,
	type GcpAppWait,
	type GcpConnectionPeak,
	type GcpStatement,
	type GcpTracedStatement,
} from "../../../../components/infra/gcp/cloud-sql-signals"
import { EMPTY_VALUE, formatLatency, formatNumber, formatPercent } from "@maple/ui/lib/format"
import { latencyToneClass } from "@maple/ui/lib/latency-tone"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { rowSelectedClass } from "@maple/ui/styles/ui/list-row"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { LoadFailure } from "../../../../data/load-failure"
import { AppRoute, hrefOf } from "../../../../route"
import { emptyMessage } from "../../../../ui/empty"
import { icon } from "../../../../ui/icon"
import { errorState } from "../../../../ui/error-state"
import { meter } from "../../../../ui/meter"
import { skeletonList } from "../../../../ui/skeleton"
import { columnHead, dataTable } from "../../../infra/kit/data-table"
import { sectionHeading } from "../../../kit/section-heading"
import type { Statement } from "../data"
import { Message } from "./model"

// `GcpCloudSqlTopQueries` and the workload page's `GcpAppWaitCallout`.

type H = HtmlBuilder<Message>
type TimeSearch = Readonly<{ startTime?: string; endTime?: string; timePreset?: string }>

const SHOWN = 5
const STATEMENT = "w-0 min-w-64 flex-1"
const NUMBER = "text-right font-mono text-xs tabular-nums"
const SUB = "truncate font-mono text-3xs text-muted-foreground"
const MANY_ROWS = 10_000
const LOCK_WARN = 0.2
const LOCK_CRIT = 0.5
const APP_GAP = 5
const CHEVRON = "flex w-4 shrink-0 justify-center"

/** The app side's p95, red once it is `APP_GAP` times the database's. */
export const appP95Tone = (db: number | null, app: number | undefined): string =>
	app === undefined
		? "text-muted-foreground"
		: db !== null && app >= APP_GAP * db
			? TONE_TEXT.crit
			: latencyToneClass(app)

/** A statement's share of time waiting on locks. */
export const lockTone = (share: number): string =>
	share >= LOCK_CRIT ? TONE_TEXT.crit : share >= LOCK_WARN ? TONE_TEXT.warn : "text-muted-foreground"

const head = (h: H, label: string, width: string, align?: "right", hidden?: string) =>
	columnHead(h, { label, width, align, hidden })

const callers = (h: H, traced: GcpTracedStatement | undefined): Html => {
	if (traced === undefined) return h.div([h.Class(cn(SUB, TONE_TEXT.warn))], ["not traced"])
	const more = traced.serviceCount - traced.services.length
	return h.div(
		[h.Class(SUB)],
		["called by ", traced.services.join(" · "), ...(more > 0 ? [` +${more}`] : [])],
	)
}

const statementRow = (
	h: H,
	row: GcpStatement,
	traced: GcpTracedStatement | undefined,
	isPeeked: boolean,
): Html => {
	const rowsPerCall = row.calls > 0 ? row.rows / row.calls : undefined
	const db = row.p95LatencyMillis
	const app = traced?.appP95Ms
	return h.button(
		[
			h.Type("button"),
			h.OnClick(Message.ClickedStatement({ queryHash: row.queryHash })),
			h.AriaLabel(`Open statement: ${row.querystring}`),
			...(isPeeked ? [h.AriaCurrent("true")] : []),
			h.Class(
				cn(
					"flex w-full cursor-pointer items-center gap-4 border-b border-border-subtle px-4 py-2.5 text-left transition-colors last:border-0 hover:bg-surface-sunken focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none",
					rowSelectedClass(isPeeked),
				),
			),
		],
		[
			h.div(
				[h.Class(cn(STATEMENT, "space-y-0.5"))],
				[
					h.div(
						[h.Class("truncate font-mono text-xs text-foreground"), h.Title(row.querystring)],
						[row.querystring],
					),
					callers(h, traced),
				],
			),
			h.div([h.Class(cn("w-16 text-foreground-soft", NUMBER))], [formatNumber(row.calls)]),
			h.div(
				[
					h.Class(
						cn("w-20", NUMBER, db === null ? "text-muted-foreground" : latencyToneClass(db)),
					),
				],
				[db === null ? EMPTY_VALUE : formatLatency(db)],
			),
			h.div(
				[h.Class(cn("w-20", NUMBER, appP95Tone(db, app)))],
				[app === undefined ? EMPTY_VALUE : formatLatency(app)],
			),
			h.div(
				[
					h.Class(
						cn(
							"hidden w-16 md:block",
							NUMBER,
							(rowsPerCall ?? 0) >= MANY_ROWS ? TONE_TEXT.warn : "text-foreground-soft",
						),
					),
				],
				[rowsPerCall === undefined ? EMPTY_VALUE : formatNumber(Math.round(rowsPerCall))],
			),
			h.div([h.Class(cn("w-[56px]", NUMBER, lockTone(row.lockShare)))], [formatPercent(row.lockShare)]),
			h.div(
				[h.Class("hidden w-28 items-center gap-2 md:flex")],
				[
					meter(h, { value: row.executionShare, tone: "neutral", className: "w-14" }),
					h.span(
						[h.Class("font-mono text-2xs tabular-nums text-foreground-soft")],
						[formatPercent(row.executionShare)],
					),
				],
			),
			h.span(
				[
					h.AriaHidden(true),
					h.Class(cn(CHEVRON, isPeeked ? "text-foreground" : "text-muted-foreground")),
				],
				[icon(h, "ChevronRightIcon", { size: 14 })],
			),
		],
	)
}

const notice = (h: H, text: string): Html =>
	emptyMessage(h, { dashed: true, className: "bg-card/50 px-3 py-4 text-xs" }, [text])

export type TopQueriesInputs = Readonly<{
	slot: AsyncData.AsyncData<ReadonlyArray<Statement>, LoadFailure>
	rows: ReadonlyArray<GcpStatement>
	unavailableReason: string | null
	traced: ReadonlyMap<string, GcpTracedStatement>
	showAll: boolean
	/** The statement open in the side panel. */
	peekHash: string | undefined
}>

export const topQueries = (h: H, inputs: TopQueriesInputs): Html => {
	const body = (isWaiting: boolean): Html => {
		const { rows } = inputs
		if (inputs.unavailableReason !== null) return notice(h, inputs.unavailableReason)
		if (rows.length === 0) return notice(h, "Query Insights recorded no statements in this window.")
		const shown = inputs.showAll ? rows : rows.slice(0, SHOWN)
		return dataTable(
			h,
			{ ariaLabel: "Top queries", isWaiting },
			[
				head(h, "Statement", STATEMENT),
				head(h, "Calls", "w-16", "right"),
				head(h, "DB p95", "w-20", "right"),
				head(h, "App p95", "w-20", "right"),
				head(h, "Rows", "w-16", "right", "hidden md:flex"),
				head(h, "Lock", "w-[56px]", "right"),
				head(h, "Total time", "w-28", undefined, "hidden md:flex"),
				h.span([h.Class(CHEVRON)], []),
			],
			[
				...shown.map((row) =>
					statementRow(h, row, inputs.traced.get(row.queryHash), row.queryHash === inputs.peekHash),
				),
				h.div(
					[
						h.Class(
							"flex items-center justify-between gap-4 px-4 py-2.5 font-mono text-2xs text-muted-foreground",
						),
					],
					[
						h.span(
							[],
							[
								rows.length > shown.length ? `${rows.length - shown.length} more · ` : "",
								"rows = rows per call · lock = share of DB time waiting on locks",
							],
						),
						...(rows.length > SHOWN
							? [
									h.button(
										[
											h.Type("button"),
											h.OnClick(Message.ClickedShowAllQueries()),
											h.Class("shrink-0 text-primary hover:text-primary/80"),
										],
										[inputs.showAll ? "Show fewer" : `Show all ${rows.length}`],
									),
								]
							: []),
					],
				),
			],
		)
	}
	const failed = (failure: LoadFailure) =>
		errorState(h, { failure, title: "Query Insights is unavailable", variant: "inline" })
	return h.section(
		[h.Class("space-y-3")],
		[
			sectionHeading(h, { title: "Top queries", hint: "by total time, Query Insights and traces" }),
			AsyncData.match(inputs.slot, {
				onIdle: () =>
					skeletonList(h, { rows: 3, rowClassName: "h-[48px] rounded-md", className: "gap-1.5" }),
				onLoading: () =>
					skeletonList(h, { rows: 3, rowClassName: "h-[48px] rounded-md", className: "gap-1.5" }),
				onFailure: failed,
				onStale: ({ error }) => failed(error),
				onRefreshing: () => body(true),
				onSuccess: () => body(false),
			}),
		],
	)
}

export const figure = (h: H, value: string, caption: string, className?: string): Html =>
	h.div(
		[h.Class("flex flex-col items-start @2xl:items-end")],
		[
			h.span(
				[h.Class(cn("font-mono text-sm font-semibold tabular-nums text-foreground", className))],
				[value],
			),
			h.span([h.Class("font-mono text-3xs text-muted-foreground")], [caption]),
		],
	)

/** `GcpAppWaitCallout`: a statement's app-side p95 far over its database-side p95. */
export const appWaitCallout = (
	h: H,
	wait: GcpAppWait,
	peak: GcpConnectionPeak | undefined,
	instanceName: string,
	timeSearch: TimeSearch,
): Html => {
	const idle = Math.round(peak?.idleInTransaction ?? 0)
	const why =
		peak !== undefined && peak.max !== null && gcpPoolFull(peak)
			? `The gap is waiting for a connection: ${instanceName} sat at ${Math.round(peak.open)} of ${peak.max}${idle > 0 ? `, and ${idle} of them were idle in transaction` : ""}. Fix the pool, not the query.`
			: "The time is spent outside the database: the network, or waiting on the connection pool."
	return h.div(
		[h.Class("@container rounded-md border border-severity-error/40")],
		[
			h.div(
				[h.Class("flex flex-col @2xl:flex-row @2xl:items-center")],
				[
					h.div(
						[h.Class("min-w-0 flex-1 space-y-1 px-4 py-3")],
						[
							h.p(
								[h.Class("text-sm font-medium text-foreground")],
								[
									wait.service,
									" waits ",
									formatLatency(wait.appP95Ms),
									" for a query the database runs in",
									" ",
									formatLatency(wait.dbP95Ms),
								],
							),
							h.p(
								[
									h.Class("truncate font-mono text-2xs text-muted-foreground"),
									h.Title(wait.statement),
								],
								[wait.statement],
							),
							h.p(
								[h.Class("max-w-prose text-xs text-muted-foreground")],
								["Same statement, p95 from both ends. ", why],
							),
						],
					),
					h.div(
						[
							h.Class(
								"flex items-center gap-6 border-t px-4 py-3 @2xl:self-stretch @2xl:border-t-0 @2xl:border-l @2xl:px-5",
							),
						],
						[
							figure(h, formatLatency(wait.appP95Ms), "app p95", "text-severity-error"),
							figure(h, formatLatency(wait.dbP95Ms), "database"),
							h.a(
								[
									h.Class(
										"ml-auto font-mono text-xs text-primary hover:text-primary/80 @2xl:ml-0",
									),
									h.Href(
										hrefOf(
											AppRoute.Traces({
												search: {
													...timeSearch,
													services: [wait.service],
													minDurationMs: Math.round(wait.appP95Ms),
												},
											}),
										),
									),
								],
								["Slow traces"],
							),
						],
					),
				],
			),
		],
	)
}
