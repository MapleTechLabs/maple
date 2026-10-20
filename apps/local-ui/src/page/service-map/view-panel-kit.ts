import { errorRateClass, errorRateLevel } from "@maple/ui/lib/error-rate"
import { formatErrorRate, formatRate } from "@maple/ui/lib/format"
import { TONE_FILL } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import type { ServiceMapEdgeRow } from "@maple/ui/components/service-map/service-map-types"
import { HEALTH_TONE } from "@maple/web/service-map/map/node-card"
import type { Html, HtmlBuilder } from "foldkit/html"
import { hrefFor } from "../../route"

// The building blocks of the service map's side panels.

export const serviceHref = (serviceName: string, range: string): string =>
	hrefFor(`/services/${encodeURIComponent(serviceName)}`, new URLSearchParams({ range }))

/** Span scope: most services never own a trace's root span. */
export const serviceTracesHref = (serviceName: string, range: string): string =>
	hrefFor("/traces", new URLSearchParams({ scope: "spans", service: serviceName, range }))

/** `getHealthDotClass` (packages/ui/src/components/service-map/service-map-node.tsx). */
const healthDotClass = (errorRate: number): string => TONE_FILL[HEALTH_TONE[errorRateLevel(errorRate)]]

export const panelHeader = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ accentColor: string; errorRate: number; title: string; subtitle?: ReadonlyArray<Html | string> }>,
	actions: ReadonlyArray<Html>,
): Html =>
	h.div(
		[h.Class("flex shrink-0 items-center justify-between gap-2 border-b px-4 py-3")],
		[
			h.div(
				[h.Class("flex min-w-0 items-center gap-2")],
				[
					h.div([h.Class("h-[18px] w-[3px] shrink-0 rounded-sm"), h.Style({ "background-color": options.accentColor })], []),
					h.div([h.Class(cn("size-1.5 shrink-0 rounded-full", healthDotClass(options.errorRate)))], []),
					h.div(
						[h.Class("flex min-w-0 flex-col")],
						[
							h.span([h.Class("truncate text-sm font-semibold text-foreground")], [options.title]),
							...(options.subtitle === undefined
								? []
								: [h.span([h.Class("truncate text-[10px] text-muted-foreground")], options.subtitle)]),
						],
					),
				],
			),
			h.div([h.Class("flex shrink-0 items-center gap-1")], actions),
		],
	)

export const sectionTitle = <M>(h: HtmlBuilder<M>, text: string): Html =>
	h.h4([h.Class("text-[10px] font-medium tracking-widest text-muted-foreground/60 uppercase")], [text])

export const metricTile = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ label: string; value: string; unit?: string; className?: string; title?: string }>,
): Html =>
	h.div(
		[h.Class("space-y-0.5"), ...(options.title === undefined ? [] : [h.Title(options.title)])],
		[
			h.span([h.Class("text-[10px] text-muted-foreground")], [options.label]),
			h.p([h.Class(cn("font-mono text-xl font-semibold tabular-nums text-foreground", options.className))], [options.value]),
			...(options.unit ? [h.span([h.Class("text-[10px] text-muted-foreground")], [options.unit])] : []),
		],
	)

export interface PeerRow {
	readonly key: string
	readonly label: string
	readonly color: string
	readonly href?: string
	readonly reqPerSec: number
	readonly tracedReqPerSec: number
	readonly errorRate: number
	readonly hasSampling: boolean
	readonly samplingWeight: number
}

type EdgeLike = Pick<ServiceMapEdgeRow, "callCount" | "estimatedCallCount" | "errorRate" | "hasSampling" | "samplingWeight">

export const rates = (edge: EdgeLike, durationSeconds: number) => {
	const safe = Math.max(durationSeconds, 1)
	return {
		reqPerSec: (edge.hasSampling ? edge.estimatedCallCount : edge.callCount) / safe,
		tracedReqPerSec: edge.callCount / safe,
		errorRate: edge.errorRate,
		hasSampling: edge.hasSampling,
		samplingWeight: edge.samplingWeight,
	}
}

const peerRow = <M>(h: HtmlBuilder<M>, row: PeerRow): Html => {
	const name = h.span(
		[h.Class("flex min-w-0 items-center gap-1.5")],
		[
			h.span([h.Class("h-3.5 w-[3px] shrink-0 rounded-sm"), h.Style({ "background-color": row.color })], []),
			h.span([h.Class("truncate text-foreground")], [row.label]),
		],
	)
	return h.div(
		[
			h.Key(row.key),
			h.Class(
				cn(
					"flex items-center justify-between gap-2 rounded-md border px-2.5 py-2 text-xs",
					errorRateLevel(row.errorRate) === "crit" ? "border-severity-error/[0.12] bg-severity-error/[0.04]" : "border-border bg-card",
				),
			),
			...(row.hasSampling
				? [h.Title(`Estimated x${row.samplingWeight.toFixed(0)} from ${formatRate(row.tracedReqPerSec)} traced req/s`)]
				: []),
		],
		[
			row.href === undefined ? name : h.a([h.Href(row.href), h.Class("min-w-0 hover:underline")], [name]),
			h.span(
				[h.Class("flex shrink-0 items-center gap-2 text-[10px]")],
				[
					h.span(
						[h.Class("font-mono tabular-nums text-muted-foreground")],
						[...(row.hasSampling ? ["~"] : []), formatRate(row.reqPerSec), " req/s"],
					),
					h.span(
						[h.Class(cn("font-mono tabular-nums", errorRateClass(row.errorRate, { neutral: "text-severity-info" })))],
						[formatErrorRate(row.errorRate)],
					),
				],
			),
		],
	)
}

/** `PeerList`: nothing when there are no peers. */
export const peerList = <M>(h: HtmlBuilder<M>, title: string, rows: ReadonlyArray<PeerRow>): ReadonlyArray<Html> =>
	rows.length === 0
		? []
		: [
				h.div(
					[h.Class("space-y-3")],
					[
						h.div([h.Class("h-px bg-border")], []),
						sectionTitle(h, title),
						h.div([h.Class("space-y-1.5")], rows.map((row) => peerRow(h, row))),
					],
				),
			]
