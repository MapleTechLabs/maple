import { formatRelativeTime } from "@maple/ui/lib/time-format"
import { type DocsPage, docsUrl } from "@maple/web/lib/docs"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button, linkButton } from "../../ui/button"
import { empty, emptyContent, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "../../ui/empty"
import { icon, type IconName } from "../../ui/icon"
import type { SignalPresence, TelemetrySignalKind } from "./signal-presence"

// `SignalEmptyState` (apps/web/src/components/common/signal-empty-state.tsx), `FilteredEmpty` and
// `DocsLink`/`EmptyActions` (common/docs-link.tsx). Presence comes from the page's Model.

type SignalCopy = Readonly<{
	noun: string
	icon: IconName
	purpose: string
	source: string
	action: string
	setupDocs: DocsPage
	guideDocs: DocsPage
}>

// copied: SIGNAL_COPY (the React module also holds the component).
const SIGNAL_COPY = {
	traces: {
		noun: "traces",
		icon: "NetworkNodesIcon",
		purpose: "Follow every request through your services, with timing for each step.",
		source: "Send spans from an OpenTelemetry SDK in your app.",
		action: "Set up tracing",
		setupDocs: "instrumentation",
		guideDocs: "traces",
	},
	logs: {
		noun: "logs",
		icon: "FileIcon",
		purpose: "Search every log line and jump to the trace that wrote it.",
		source: "Add an OpenTelemetry log exporter to the logger you already use; stdout alone doesn't reach Maple.",
		action: "Set up logging",
		setupDocs: "instrumentation",
		guideDocs: "logs",
	},
	metrics: {
		noun: "metrics",
		icon: "ChartLineIcon",
		purpose: "Chart the counters, gauges and histograms your services and hosts report.",
		source: "Send them from an OpenTelemetry metric reader, a Prometheus scrape, or the Maple agent.",
		action: "Set up metrics",
		setupDocs: "instrumentation",
		guideDocs: "metrics",
	},
	sessions: {
		noun: "sessions",
		icon: "EyeIcon",
		purpose: "Watch what a user saw and did, next to the requests their browser made.",
		source: "Add the Maple browser SDK to your site.",
		action: "Set up session replay",
		setupDocs: "browserSdk",
		guideDocs: "sessionReplay",
	},
	product_events: {
		noun: "events",
		icon: "ConnectionIcon",
		purpose: "Record what users do in your app, for funnels and web analytics.",
		source: "Send them with track() from the Maple browser SDK.",
		action: "Set up product analytics",
		setupDocs: "productEventsApi",
		guideDocs: "webAnalytics",
	},
} satisfies Record<TelemetrySignalKind, SignalCopy>

/** `DocsLink`. */
export const docsLink = <M>(h: HtmlBuilder<M>, page: DocsPage, label = "Read the docs"): Html =>
	h.a(
		[
			h.Class(
				"inline-flex items-center gap-1.5 text-muted-foreground text-sm underline-offset-4 hover:text-foreground hover:underline",
			),
			h.Href(docsUrl(page)),
			h.Target("_blank"),
			h.Rel("noopener noreferrer"),
		],
		[label, icon(h, "ExternalLinkIcon", { size: 12 })],
	)

/** `EmptyActions`. */
const emptyActions = <M>(h: HtmlBuilder<M>, children: ReadonlyArray<Html>): Html =>
	h.div([h.Class("flex flex-wrap items-center justify-center gap-x-4 gap-y-2")], children)

const iconMedia = <M>(h: HtmlBuilder<M>, name: IconName): Html =>
	emptyMedia(h, { variant: "icon" }, [icon(h, name)])

export type SignalEmptyStateOptions<M> = Readonly<{
	signal: TelemetrySignalKind
	presence: SignalPresence
	nowMs: number
	noun?: string
	isFiltered?: boolean
	/** `onClearFilters`: the Message the "Clear filters" button sends. */
	onClearFilters?: M
	onWidenRange?: M
	className?: string
}>

/** `FilteredEmpty` with its defaults. */
const filteredEmpty = <M>(
	h: HtmlBuilder<M>,
	noun: string,
	onClear: M | undefined,
	className?: string,
): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				iconMedia(h, "SlidersIcon"),
				emptyTitle(h, [`No ${noun} match these filters`]),
				emptyDescription(h, ["Everything in this time range was excluded by the current filters."]),
			]),
			...(onClear === undefined
				? []
				: [
						emptyContent(h, [
							button(h, { variant: "outline", size: "sm", attributes: [h.OnClick(onClear)] }, [
								"Clear filters",
							]),
						]),
					]),
		],
		className,
	)

/** `SignalEmptyStateView`: filtered, then absent (setup), present (quiet window), else unknown. */
export const signalEmptyState = <M>(h: HtmlBuilder<M>, options: SignalEmptyStateOptions<M>): Html => {
	const copy = SIGNAL_COPY[options.signal]
	const subject = options.noun ?? copy.noun
	if (options.isFiltered === true)
		return filteredEmpty(h, subject, options.onClearFilters, options.className)
	const { presence } = options
	if (presence.status === "absent") {
		return empty(
			h,
			[
				emptyHeader(h, [
					iconMedia(h, copy.icon),
					// Split where the JSX interpolates, so text runs shape the same.
					emptyTitle(h, ["No ", subject, " yet"]),
					emptyDescription(h, [copy.purpose, " ", copy.source]),
				]),
				emptyContent(h, [
					emptyActions(h, [
						linkButton(h, { size: "sm", className: "gap-2", href: "/settings?tab=ingestion" }, [
							icon(h, "ConnectionIcon"),
							copy.action,
						]),
						docsLink(h, copy.setupDocs, "Setup guide"),
					]),
				]),
			],
			options.className,
		)
	}
	if (presence.status === "present") {
		return empty(
			h,
			[
				emptyHeader(h, [
					iconMedia(h, "ClockIcon"),
					emptyTitle(h, ["No ", subject, " in this time range"]),
					emptyDescription(h, [
						presence.lastSeenMs === null
							? `Maple is receiving ${copy.noun}, just none in the selected window.`
							: `Maple last received ${copy.noun} ${formatRelativeTime(presence.lastSeenMs, options.nowMs)}. Widen the range to see them.`,
					]),
				]),
				emptyContent(h, [
					emptyActions(h, [
						...(options.onWidenRange === undefined
							? []
							: [
									button(
										h,
										{
											variant: "outline",
											size: "sm",
											attributes: [h.OnClick(options.onWidenRange)],
										},
										["Widen time range"],
									),
								]),
						docsLink(h, copy.guideDocs),
					]),
				]),
			],
			options.className,
		)
	}
	return empty(
		h,
		[
			emptyHeader(h, [emptyTitle(h, ["No ", subject, " found"]), emptyDescription(h, [copy.purpose])]),
			emptyContent(h, [docsLink(h, copy.guideDocs)]),
		],
		options.className,
	)
}
