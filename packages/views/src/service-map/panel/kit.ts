import { getServiceColor } from "@maple/ui/lib/colors"
import { errorRateClass, errorRateLevel } from "@maple/ui/lib/error-rate"
import { formatErrorRate, formatRate } from "@maple/ui/lib/format"
import type { Tone } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "../../ui/display"
import { typography, typographyClass } from "../../ui/typography"
import { hstack } from "../../ui/stack"
import { textLink } from "../../ui/text-link"
import { stripClass } from "../../ui/rule"

// The small pieces both detail panels share.

type Children = ReadonlyArray<Html | string>

/** A quiet error rate reads as healthy, not unknown. */
export const healthTone = (errorRate: number): Tone => {
	const level = errorRateLevel(errorRate)
	return level === "neutral" ? "ok" : level
}

/** `SampledValue` without a tooltip: `~` before an extrapolated value. */
export const sampled = (estimated: boolean, value: string): Children => (estimated ? ["~", value] : [value])

/** `MetricValue`. */
export const metricValue = <M>(h: HtmlBuilder<M>, className: string | undefined, children: Children): Html =>
	h.p([h.Class(cn("font-mono text-xl font-semibold tabular-nums text-foreground", className))], children)

/** `MetricTile`: label over a big value, with an optional caption under it. */
export const metricTile = <M>(h: HtmlBuilder<M>, label: string, value: Html, caption?: Children): Html =>
	h.div(
		[h.Class("space-y-0.5")],
		[
			typography(h, { size: "3xs", tone: "muted" }, [label]),
			value,
			...(caption === undefined ? [] : [typography(h, { size: "3xs", tone: "muted" }, caption)]),
		],
	)

/** `DetailPanelHeader`: accent bar and title on the left, actions on the right. */
export const detailPanelHeader = <M>(
	h: HtmlBuilder<M>,
	accentColor: string,
	title: Children,
	actions: Children,
): Html =>
	hstack(h, { align: "center", justify: "between", className: stripClass("header", "shrink-0") }, [
		hstack(h, { gap: "2", shrink: true }, [
			h.div([
				h.Class("w-[3px] h-[18px] rounded-sm shrink-0"),
				h.Style({ "background-color": accentColor }),
			]),
			...title,
		]),
		hstack(h, { gap: "2", className: "shrink-0" }, actions),
	])

/** `TagBadge`: a branch's "prod", an origin scheme. */
export const tagBadge = <M>(h: HtmlBuilder<M>, children: Children): Html =>
	badge(h, { variant: "tag", className: "shrink-0 font-semibold" }, children)

export type EdgeLike = Readonly<{
	hasSampling: boolean
	callCount: number
	estimatedCallCount: number
	errorRate: number
	samplingWeight: number
}>

/** `EdgeRow`: one caller or dependency, its call rate and error rate. */
export const edgeRow = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		service: string
		/** The row's name and bar color when it is not a service (a database). */
		label?: string
		color?: string
		/** Where the name links: the peer's own page. */
		href?: string
		edge: EdgeLike
		durationSeconds: number
		unit: string
		highlightError?: boolean
		explainSampling?: boolean
	}>,
): Html => {
	const { edge } = options
	const safeDuration = Math.max(options.durationSeconds, 1)
	const reqPerSec = (edge.hasSampling ? edge.estimatedCallCount : edge.callCount) / safeDuration
	const isError = options.highlightError === true && errorRateLevel(edge.errorRate) === "crit"
	const title =
		options.explainSampling === true && edge.hasSampling
			? `Estimated ×${edge.samplingWeight.toFixed(0)} from ${formatRate(edge.callCount / safeDuration)} traced req/s`
			: undefined
	const name = hstack(h, { gap: "1.5", shrink: true }, [
		h.div([
			h.Class("w-[3px] h-3.5 rounded-sm shrink-0"),
			h.Style({ "background-color": options.color ?? getServiceColor(options.service) }),
		]),
		typography(h, { tone: "foreground", truncate: true }, [options.label ?? options.service]),
	])
	return h.div(
		[
			h.Key(options.service),
			h.Class(
				cn(
					"flex items-center justify-between px-2.5 py-2 rounded-md border text-xs",
					isError
						? "bg-severity-error/[0.04] border-severity-error/[0.12]"
						: "bg-card border-border",
				),
			),
			...(title === undefined ? [] : [h.Title(title)]),
		],
		[
			options.href === undefined
				? name
				: textLink(h, { href: options.href, tone: "inherit", className: "min-w-0" }, [name]),
			hstack(h, { gap: "2", align: "center", className: "shrink-0 text-3xs" }, [
				typography(h, { tone: "muted", mono: true, numeric: true }, [
					...sampled(edge.hasSampling, formatRate(reqPerSec)),
					" ",
					options.unit,
				]),
				h.span(
					[
						h.Class(
							cn(
								typographyClass({ mono: true, numeric: true }),
								errorRateClass(edge.errorRate),
							),
						),
					],
					[formatErrorRate(edge.errorRate)],
				),
			]),
		],
	)
}
