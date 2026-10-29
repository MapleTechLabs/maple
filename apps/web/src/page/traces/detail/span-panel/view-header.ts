import { warehouseDateTimeToIso } from "@maple/query-engine"
import { cacheResultStyles, getCacheInfo } from "@maple/ui/lib/cache"
import { calculateSelfTime, getServiceColor } from "@maple/ui/lib/colors"
import { EMPTY_VALUE, formatDuration, formatPercent } from "@maple/ui/lib/format"
import { getSpanKindLabel, getSpanStatusBadgeClass } from "@maple/ui/lib/span-kind"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "../../../../ui/display"
import { httpSpanLabel } from "../../../../ui/http-span-label"
import { icon } from "../../../../ui/icon"
import { iconButton } from "../../../../ui/icon-button"
import { keyValue, keyValueList } from "../../../../ui/key-value"
import { truncatedText } from "../../../../ui/truncated-text"
import { serviceDot } from "../../../../ui/values"
import { toSpanNode } from "../trace-data"
import { copyableValue, selectableValue } from "./copy"
import { Message } from "./message"
import type { Model } from "./model"
import { outcomeBadgeStyle, type PlatformInfo } from "./platform"

// The panel's header, summary stats, cache and platform blocks (`SpanDetailPanel`).

/** Any builder whose Messages include the panel's: the panel's own, the popover's, local-ui's. */
type H<P> = HtmlBuilder<Message | P>

/** A warehouse timestamp in `timeZone`, optionally with milliseconds. */
export const formatTimestamp = (value: string, timeZone: string, withMilliseconds: boolean): string => {
	const date = new Date(warehouseDateTimeToIso(value))
	if (Number.isNaN(date.getTime())) return EMPTY_VALUE
	return new Intl.DateTimeFormat("en-US", {
		timeZone,
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		fractionalSecondDigits: withMilliseconds ? 3 : undefined,
	}).format(date)
}

export const panelHeader = <P>(h: H<P>, model: Model): Html => {
	const { span } = model
	const serviceColor = getServiceColor(span.serviceName)
	return h.div(
		[h.Class("relative flex items-center justify-between border-b px-3 py-2 shrink-0")],
		[
			h.span(
				[
					h.AriaHidden(true),
					h.Class("absolute inset-y-0 left-0 w-0.5"),
					h.Style({ "background-color": serviceColor }),
				],
				[],
			),
			h.div(
				[h.Class("flex-1 min-w-0 mr-2 overflow-hidden")],
				[
					selectableValue(
						h,
						model,
						{
							id: "span-name",
							value: span.spanName,
							label: "span name",
							className: "flex min-w-0 items-center",
							textClassName: "min-w-0 flex-1",
						},
						[
							httpSpanLabel(h, {
								spanName: span.spanName,
								spanAttributes: span.spanAttributes,
								spanKind: span.spanKind,
								textClassName: "font-semibold text-sm",
							}),
						],
					),
					h.div(
						[h.Class("flex min-w-0 items-center gap-1.5 mt-0.5")],
						[
							serviceDot(h, { serviceName: span.serviceName, size: "sm" }),
							copyableValue(
								h,
								model,
								{
									id: "service-name",
									value: span.serviceName,
									className: "min-w-0 truncate",
								},
								[
									h.span(
										[h.Class("font-mono text-3xs"), h.Style({ color: serviceColor })],
										[span.serviceName],
									),
								],
							),
							h.span(
								[h.Class("shrink-0 text-3xs text-muted-foreground")],
								[getSpanKindLabel(span.spanKind)],
							),
						],
					),
				],
			),
			h.div(
				[h.Class("flex shrink-0 items-center gap-0.5")],
				[
					iconButton(
						h,
						{
							label: "Close span details",
							size: "icon",
							attributes: [h.OnClick(Message.ClickedClose())],
						},
						[icon(h, "XmarkIcon")],
					),
				],
			),
		],
	)
}

/** Duration, self time, share of trace, status and cache result. */
export const summaryStats = <P>(h: H<P>, model: Model): Html => {
	const { span } = model
	const node = toSpanNode(span)
	const duration = formatDuration(span.durationMs)
	const selfTimeMs = span.children.length > 0 ? calculateSelfTime(node, node.children) : null
	const traceShare = model.totalDurationMs > 0 ? span.durationMs / model.totalDurationMs : null
	const cacheInfo = getCacheInfo({ ...span.spanAttributes })
	return h.div(
		[h.Class("flex items-center gap-4 border-b px-3 py-1.5 text-xs shrink-0")],
		[
			h.div(
				[h.Class("flex items-center gap-1.5")],
				[
					icon(h, "ClockIcon", { size: 12, className: "text-muted-foreground" }),
					h.span(
						[h.Class("font-mono")],
						[copyableValue(h, model, { id: "duration", value: duration }, [duration])],
					),
				],
			),
			selfTimeMs === null
				? null
				: h.span(
						[
							h.Class("font-mono text-muted-foreground"),
							h.Title("Time not spent in child spans"),
						],
						["self ", h.span([h.Class("text-foreground")], [formatDuration(selfTimeMs)])],
					),
			traceShare === null || span.isMissing === true
				? null
				: h.span(
						[h.Class("font-mono text-muted-foreground")],
						[formatPercent(traceShare, { floor: 0.001 }), " of trace"],
					),
			badge(
				h,
				{ variant: "outline", size: "xs", className: getSpanStatusBadgeClass(span.statusCode) },
				[span.statusCode === "" ? "Unset" : span.statusCode],
			),
			cacheInfo?.result === undefined || cacheInfo.result === null
				? null
				: badge(
						h,
						{ variant: "outline", size: "xs", className: cacheResultStyles[cacheInfo.result] },
						[cacheInfo.result === "hit" ? "HIT" : "MISS"],
					),
		],
	)
}

/** The cache summary row, for spans carrying `cache.*`. */
export const cacheSummary = <P>(h: H<P>, model: Model): Html | null => {
	const cacheInfo = getCacheInfo({ ...model.span.spanAttributes })
	if (cacheInfo === null) return null
	return h.div(
		[h.Class("flex items-center gap-3 border-b px-3 py-1.5 text-xs shrink-0")],
		[
			cacheInfo.system === null || cacheInfo.system === ""
				? null
				: badge(h, { variant: "outline", size: "xs", mono: true }, [cacheInfo.system]),
			cacheInfo.operation === null || cacheInfo.operation === ""
				? null
				: h.span([h.Class("font-mono text-muted-foreground uppercase")], [cacheInfo.operation]),
			cacheInfo.name === null || cacheInfo.name === ""
				? null
				: truncatedText(h, { text: cacheInfo.name, mono: true, className: "text-muted-foreground" }),
		],
	)
}

/** The cloud platform / database block (Cloudflare, PostgreSQL, ...). */
export const platformSummary = <P>(h: H<P>, model: Model, platform: PlatformInfo): Html =>
	h.div(
		[h.Class("@container/platform border-b px-3 py-2 text-xs shrink-0 space-y-1.5")],
		[
			h.div(
				[h.Class("flex items-center gap-1.5")],
				[
					icon(h, platform.icon, { size: 12, className: cn("shrink-0", platform.accentClassName) }),
					h.span([h.Class("font-medium")], [platform.label]),
					platform.outcome === null
						? null
						: badge(
								h,
								{
									variant: "outline",
									size: "xs",
									className: cn("ml-auto", outcomeBadgeStyle(platform.outcome.bad)),
								},
								[platform.outcome.value],
							),
				],
			),
			keyValueList(
				h,
				{ className: "grid grid-cols-1 gap-x-4 gap-y-1 text-2xs @min-[22rem]/platform:grid-cols-2" },
				[
					...(platform.edge === null
						? []
						: [
								keyValue(h, { label: "Edge", mono: true }, [
									h.span(
										[h.Class("inline-flex items-center gap-1")],
										[
											icon(h, "GlobeIcon", { size: 10, className: "shrink-0" }),
											platform.edge,
										],
									),
								]),
							]),
					...(platform.location === null
						? []
						: [keyValue(h, { label: "Location", mono: true }, [platform.location])]),
					...platform.fields.map((field) =>
						keyValue(
							h,
							{
								label: field.label,
								mono: true,
								className:
									field.wide === true ? "@min-[22rem]/platform:col-span-2" : undefined,
							},
							[
								field.copyable === true
									? copyableValue(
											h,
											model,
											{ id: `platform:${field.label}`, value: field.value },
											[field.display ?? field.value],
										)
									: (field.display ?? field.value),
							],
						),
					),
				],
			),
		],
	)
