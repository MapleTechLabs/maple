import { formatRelativeTime } from "@maple/ui/lib/time-format"
import { type DocsPage, docsUrl } from "../../lib/docs"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button, linkButton } from "../../ui/button"
import { empty, emptyContent, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "../../ui/empty"
import { icon, type IconName } from "../../ui/icon"
import { skeleton } from "../../ui/skeleton"
import type { PresenceState, TelemetrySignalKind } from "./signal-presence"

// `SignalEmptyState`, `FilteredEmpty` and `DocsLink`/`EmptyActions`. Presence comes from the
// page's Model.

type SignalCopy = Readonly<{
	noun: string
	icon: IconName
	purpose: string
	source: string
	action: string
	setupDocs: DocsPage
	guideDocs: DocsPage
}>

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
				"inline-flex items-center gap-1.5 text-muted-foreground text-sm underline-offset-4 hover:text-foreground active:text-foreground hover:underline active:underline",
			),
			h.Href(docsUrl(page)),
			h.Target("_blank"),
			h.Rel("noopener noreferrer"),
		],
		[label, icon(h, "ExternalLinkIcon", { size: 12 })],
	)

/** `EmptyActions`. */
export const emptyActions = <M>(h: HtmlBuilder<M>, children: ReadonlyArray<Html>): Html =>
	h.div([h.Class("flex flex-wrap items-center justify-center gap-x-4 gap-y-2")], children)

const iconMedia = <M>(h: HtmlBuilder<M>, name: IconName): Html =>
	emptyMedia(h, { variant: "icon" }, [icon(h, name)])

export type SignalEmptyStateOptions<M> = Readonly<{
	signal: TelemetrySignalKind
	presence: PresenceState
	nowMs: number
	noun?: string
	/** The setup button's label in place of the signal's. */
	action?: string
	/** The page's own sentence in place of the signal's, and its guide. */
	purpose?: string
	guideDocs?: DocsPage
	/** The setup guide the absent state links in place of the signal's. */
	setupDocs?: DocsPage
	isFiltered?: boolean
	/** `onClearFilters`: the Message the "Clear filters" button sends. */
	onClearFilters?: M
	onWidenRange?: M
	/** Page detail under the description (Traces' excluded-values hint); `null` renders nothing. */
	detail?: Html | null
	className?: string
}>

const detailOf = (detail: Html | null | undefined): ReadonlyArray<Html> =>
	detail === undefined || detail === null ? [] : [detail]

/** `FilteredEmpty`: the list is empty because the user's own filters excluded everything. */
export const filteredEmpty = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		noun: string
		title?: string
		/** `""` drops the description line. */
		description?: string
		onClear?: M
		clearLabel?: string
		icon?: Html
		/** Page detail above the clear button; `null` renders nothing. */
		detail?: Html | null
		className?: string
	}>,
): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				options.icon === undefined ? iconMedia(h, "SlidersIcon") : emptyMedia(h, { variant: "icon" }, [options.icon]),
				emptyTitle(h, [options.title ?? `No ${options.noun} match these filters`]),
				...(options.description === ""
					? []
					: [
							emptyDescription(h, [
								options.description ?? "Everything in this window was excluded by the current filters.",
							]),
						]),
			]),
			...(options.onClear === undefined && options.detail === undefined
				? []
				: [
						emptyContent(h, [
							...detailOf(options.detail),
							...(options.onClear === undefined
								? []
								: [
										button(
											h,
											{ variant: "outline", size: "sm", attributes: [h.OnClick(options.onClear)] },
											[options.clearLabel ?? "Clear filters"],
										),
									]),
						]),
					]),
		],
		options.className,
	)

/** Presence still loading: the empty state's frame in skeleton, so no copy paints and then flips. */
export const presenceLoading = <M>(h: HtmlBuilder<M>, className?: string): Html =>
	h.div(
		[h.AriaBusy(true), h.AriaLabel("Loading"), h.DataAttribute("slot", "presence-loading")],
		[
			empty(
				h,
				[
					emptyHeader(h, [
						skeleton(h, "size-10 rounded-md"),
						skeleton(h, "h-5 w-40"),
						skeleton(h, "h-4 w-64"),
					]),
				],
				className,
			),
		],
	)

/** `SignalEmptyStateView`: filtered, loading, absent (setup), present (quiet window), else unknown. */
export const signalEmptyState = <M>(h: HtmlBuilder<M>, options: SignalEmptyStateOptions<M>): Html => {
	const copy = SIGNAL_COPY[options.signal]
	const subject = options.noun ?? copy.noun
	if (options.isFiltered === true)
		return filteredEmpty(h, {
			noun: subject,
			onClear: options.onClearFilters,
			className: options.className,
			detail: options.detail,
		})
	const { presence } = options
	if (presence.status === "loading") return presenceLoading(h, options.className)
	if (presence.status === "absent") {
		return empty(
			h,
			[
				emptyHeader(h, [
					iconMedia(h, copy.icon),
					// Split where the JSX interpolates, so text runs shape the same.
					emptyTitle(h, ["No ", subject, " yet"]),
					emptyDescription(h, [options.purpose ?? copy.purpose, " ", copy.source]),
				]),
				emptyContent(h, [
					...detailOf(options.detail),
					emptyActions(h, [
						linkButton(h, { size: "sm", className: "gap-2", href: "/settings?tab=ingestion" }, [
							icon(h, "ConnectionIcon"),
							options.action ?? copy.action,
						]),
						docsLink(h, options.setupDocs ?? copy.setupDocs, "Setup guide"),
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
					emptyTitle(h, ["No ", subject, " in this window"]),
					emptyDescription(h, [
						presence.lastSeenMs === null
							? `Maple is receiving ${copy.noun}, just none in this window.`
							: `Maple last received ${copy.noun} ${formatRelativeTime(presence.lastSeenMs, options.nowMs)}. Widen the range to see them.`,
					]),
				]),
				emptyContent(h, [
					...detailOf(options.detail),
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
						docsLink(h, options.guideDocs ?? copy.guideDocs),
					]),
				]),
			],
			options.className,
		)
	}
	return empty(
		h,
		[
			emptyHeader(h, [
				emptyTitle(h, ["No ", subject, " found"]),
				emptyDescription(h, [options.purpose ?? copy.purpose]),
			]),
			emptyContent(h, [...detailOf(options.detail), docsLink(h, options.guideDocs ?? copy.guideDocs)]),
		],
		options.className,
	)
}
