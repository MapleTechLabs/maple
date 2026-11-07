import type { SupabaseProjectCaller } from "@maple/domain/http"
import { formatErrorRate, formatLatency, formatRate } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { docsUrl } from "../../../../lib/docs"
import { AppRoute, hrefOf } from "../../../../route"
import { statusDot } from "@maple/views/ui/status-dot"
import { columnHead, dataTable } from "../../../infra/kit/data-table"
import { type SparkWindow, windowSparkline } from "../../kit/window-sparkline"
import { ERROR_RATE_LIMIT } from "../health"
import { callerMixText } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { keyedBody, panelEmpty, panelLink, sectionPanel } from "../panel"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { Array as Arr } from "effect"
import { hstack } from "@maple/views/ui/stack"

// "Services calling this project": the org's client spans to the project's API and pooler.

type H = HtmlBuilder<Message>
const SERVICE_MAP_HREF = hrefOf(AppRoute.ServiceMap({ search: {} }))

const trend = (h: H, caller: SupabaseProjectCaller, window: SparkWindow | null): Html =>
	window === null
		? h.div([h.Class("h-5 w-24")])
		: h.div(
				[h.Class("h-5 w-24 text-chart-p50")],
				[
					windowSparkline(h, {
						points: Arr.map(caller.series, (bucket) => ({
							bucket: bucket.bucket,
							value: bucket.calls,
						})),
						window,
						color: "currentColor",
						className: "h-5",
						label: `${caller.serviceName} calls over the time range`,
					}),
				],
			)

const NUMBER = typographyClass({ size: "xs", mono: true, numeric: true })

const callerRow = (h: H, model: Model, caller: SupabaseProjectCaller, spark: SparkWindow | null): Html =>
	hstack(
		h,
		{
			gap: "4",
			align: "center",
			className: "border-b border-border-subtle px-4 py-2.5 last:border-0",
			attributes: [h.Key(caller.serviceName)],
		},
		[
			h.a(
				[
					h.Class(
						"flex w-0 min-w-40 flex-1 items-center gap-2 text-xs hover:text-primary active:text-primary",
					),
					h.Href(
						hrefOf(
							AppRoute.Service({
								serviceName: caller.serviceName,
								search: {
									startTime: model.search.startTime,
									endTime: model.search.endTime,
									timePreset: model.search.timePreset,
								},
							}),
						),
					),
				],
				[
					statusDot(h, { tone: "custom", className: "bg-chart-1" }),
					typography(h, { mono: true, truncate: true, attributes: [h.Title(caller.serviceName)] }, [
						caller.serviceName,
					]),
				],
			),
			h.span(
				[h.Class("hidden w-56 truncate font-mono text-2xs text-muted-foreground md:block")],
				[callerMixText(caller.mix)],
			),
			h.span([h.Class(cn(NUMBER, "w-20 text-right"))], [formatRate(caller.callsPerMinute)]),
			h.span([h.Class(cn(NUMBER, "w-20 text-right"))], [formatLatency(caller.p95DurationMs)]),
			h.span(
				[
					h.Class(
						cn(
							NUMBER,
							"w-16 text-right",
							caller.errorRate >= ERROR_RATE_LIMIT && "text-severity-error",
						),
					),
				],
				[formatErrorRate(caller.errorRate)],
			),
			hstack(h, { align: "stretch", justify: "end", className: "w-24" }, [trend(h, caller, spark)]),
		],
	)

const HEAD = [
	{ label: "Service", width: "w-0 min-w-40 flex-1" },
	{ label: "Calls to", width: "w-56", hidden: "hidden md:flex" },
	{ label: "Calls / min", width: "w-20", align: "right" },
	{ label: "P95", width: "w-20", align: "right" },
	{ label: "Errors", width: "w-16", align: "right" },
	{ label: "Trend", width: "w-24", align: "right" },
] as const

const noCallers = (h: H): Html =>
	panelEmpty(h, [
		"This fills in when your instrumented services call this project's URL or its pooler. ",
		h.a(
			[
				h.Href(docsUrl("instrumentation")),
				h.Target("_blank"),
				h.Rel("noopener noreferrer"),
				h.Class("underline underline-offset-2 hover:text-foreground active:text-foreground"),
			],
			["Instrument a service"],
		),
	])

export const callersPanel = (h: H, model: Model, spark: SparkWindow | null): Html =>
	sectionPanel(
		h,
		{
			title: "Services calling this project",
			description: "From your traces: client spans to this project's API and its pooler",
			action: panelLink(h, SERVICE_MAP_HREF, "Open service map"),
		},
		[
			keyedBody(h, model.callers, {
				rows: 3,
				failureTitle: "Couldn't load the calling services",
				onRetry: Message.ClickedRetry({ section: "callers" }),
				render: (response) =>
					response.callers.length === 0
						? noCallers(h)
						: dataTable(
								h,
								{ ariaLabel: "Services calling this project", className: "border-b-0" },
								Arr.map(HEAD, (column) => columnHead(h, column)),
								Arr.map(response.callers, (caller) => callerRow(h, model, caller, spark)),
							),
			}),
		],
	)
