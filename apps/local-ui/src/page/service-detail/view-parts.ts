import { errorRateClass } from "@maple/ui/lib/error-rate"
import { formatDuration, formatErrorRate, formatNumber } from "@maple/ui/lib/format"
import { latencyToneClass } from "@maple/ui/lib/latency-tone"
import { cn } from "@maple/ui/lib/utils"
import { button, linkButton } from "@maple/views/ui/button"
import { badge } from "@maple/views/ui/display"
import { icon } from "@maple/views/ui/icon"
import { serviceDot } from "@maple/views/ui/values"
import { hstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import type { Html, HtmlBuilder } from "foldkit/html"
import { hrefFor } from "../../route"
import { refreshButton, timeRangeSelect } from "../kit/toolbar"
import { Message } from "./message"
import type { ServiceCatalogEntry } from "../services/model"
import { Array as Arr } from "effect"

// The header and stat cards of the service detail page.

/** Traces touching this service, in span scope: most services never own a trace's root span. */
export const tracesHref = (serviceName: string, range: string, spanName?: string): string => {
	const params = new URLSearchParams({ scope: "spans", service: serviceName, range })
	if (spanName) params.set("span", spanName)
	return hrefFor("/traces", params)
}

export const detailHeader = (
	h: HtmlBuilder<Message>,
	options: Readonly<{
		serviceName: string
		backLabel: string
		environments: ReadonlyArray<string>
		range: string
		isRefreshing: boolean
		hasNewData: boolean
	}>,
): Html =>
	h.div(
		[h.Class("flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2")],
		[
			button(
				h,
				{
					variant: "ghost",
					size: "sm",
					className: "gap-1.5",
					attributes: [h.OnClick(Message.ClickedBack())],
				},
				[icon(h, "ArrowLeftIcon"), options.backLabel],
			),
			hstack(h, { as: "span", gap: "2", shrink: true }, [
				serviceDot(h, { serviceName: options.serviceName }),
				typography(h, { size: "sm", weight: "medium", truncate: true }, [options.serviceName]),
			]),
			...Arr.map(options.environments, (environment) =>
				badge(
					h,
					{
						variant: "outline",
						className: "px-1.5 py-0 text-3xs",
						attributes: [h.Key(environment)],
					},
					[environment],
				),
			),
			hstack(h, { gap: "2", className: "ml-auto" }, [
				linkButton(
					h,
					{ variant: "outline", size: "sm", href: tracesHref(options.serviceName, options.range) },
					["View traces"],
				),
				refreshButton(h, {
					isSpinning: options.isRefreshing,
					hasNewData: options.hasNewData,
					onRefresh: Message.ClickedRefresh(),
				}),
				timeRangeSelect(h, options.range, (range) => Message.ChangedRange({ range })),
			]),
		],
	)

/** `StatCard`: `valueClassName` comes after `danger`, so the latency ramp wins. */
const statCard = (
	h: HtmlBuilder<Message>,
	label: string,
	value: string,
	isDanger = false,
	valueClassName?: string,
): Html =>
	h.div(
		[h.Class("rounded-md border bg-card px-3 py-2")],
		[
			typography(
				h,
				{
					as: "div",
					size: "3xs",
					weight: "medium",
					tone: "muted",
					className: "uppercase tracking-wider",
				},
				[label],
			),
			typography(
				h,
				{
					as: "div",
					size: "lg",
					weight: "semibold",
					numeric: true,
					className: cn(isDanger && "text-severity-error", valueClassName),
				},
				[value],
			),
		],
	)

export const statCards = (h: HtmlBuilder<Message>, stats: ServiceCatalogEntry): Html =>
	h.section(
		[h.Class("grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6")],
		[
			statCard(h, "Spans", formatNumber(stats.spanCount)),
			statCard(h, "Errors", formatNumber(stats.errorCount), stats.errorCount > 0),
			statCard(
				h,
				"Error rate",
				formatErrorRate(stats.errorRate),
				false,
				errorRateClass(stats.errorRate, { neutral: "" }),
			),
			statCard(
				h,
				"p50",
				formatDuration(stats.p50LatencyMs),
				false,
				latencyToneClass(stats.p50LatencyMs, "p50"),
			),
			statCard(
				h,
				"p95",
				formatDuration(stats.p95LatencyMs),
				false,
				latencyToneClass(stats.p95LatencyMs, "p95"),
			),
			statCard(
				h,
				"p99",
				formatDuration(stats.p99LatencyMs),
				false,
				latencyToneClass(stats.p99LatencyMs, "p99"),
			),
		],
	)
