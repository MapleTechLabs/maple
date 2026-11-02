import { formatRelativeTime } from "@maple/ui/lib/time-format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "./button"
import { empty, emptyContent, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "./empty"
import { icon, type IconName } from "./icon"
import { skeleton } from "./skeleton"
import type { PresenceState, TelemetrySignalKind } from "../data/signal-presence"

// `SignalEmptyState` and `FilteredEmpty`. Presence comes from the page's Model; what the
// never-sent state offers (a setup link, an endpoint to copy) is the app's.

type Children = ReadonlyArray<Html | string>

const SIGNAL_COPY = {
	traces: {
		noun: "traces",
		icon: "NetworkNodesIcon",
		purpose: "Follow every request through your services, with timing for each step.",
	},
	logs: { noun: "logs", icon: "FileIcon", purpose: "Search every log line and jump to the trace that wrote it." },
	metrics: {
		noun: "metrics",
		icon: "ChartLineIcon",
		purpose: "Chart the counters, gauges and histograms your services and hosts report.",
	},
	sessions: {
		noun: "sessions",
		icon: "EyeIcon",
		purpose: "Watch what a user saw and did, next to the requests their browser made.",
	},
	product_events: {
		noun: "events",
		icon: "ConnectionIcon",
		purpose: "Record what users do in your app, for funnels and web analytics.",
	},
} satisfies Record<TelemetrySignalKind, Readonly<{ noun: string; icon: IconName; purpose: string }>>

/** `EmptyActions`: an empty state's row of buttons and links. */
export const emptyActions = <M>(h: HtmlBuilder<M>, children: ReadonlyArray<Html>): Html =>
	h.div([h.Class("flex flex-wrap items-center justify-center gap-x-4 gap-y-2")], children)

const iconMedia = <M>(h: HtmlBuilder<M>, name: IconName): Html =>
	emptyMedia(h, { variant: "icon" }, [icon(h, name)])

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
		/** More ways out beside the clear button (a ghost "widen the range"). */
		actions?: ReadonlyArray<Html>
		className?: string
	}>,
): Html => {
	const clear =
		options.onClear === undefined
			? []
			: [
					button(h, { variant: "outline", size: "sm", attributes: [h.OnClick(options.onClear)] }, [
						options.clearLabel ?? "Clear filters",
					]),
				]
	const actions = options.actions ?? []
	const ways =
		actions.length === 0
			? clear
			: [h.div([h.Class("flex flex-wrap items-center justify-center gap-2")], [...clear, ...actions])]
	return empty(
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
			...(ways.length === 0 && options.detail === undefined
				? []
				: [emptyContent(h, [...detailOf(options.detail), ...ways])]),
		],
		options.className,
	)
}

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

/** What the never-sent state says and offers: where the signal comes from, and the way to send it. */
export type SignalOnramp = Readonly<{
	source: Children
	content: ReadonlyArray<Html>
	contentClassName?: string
}>

export type SignalEmptyStateOptions<M> = Readonly<{
	signal: TelemetrySignalKind
	presence: PresenceState
	nowMs: number
	noun?: string
	/** The page's own sentence in place of the signal's. */
	purpose?: string
	isFiltered?: boolean
	/** `onClearFilters`: the Message the "Clear filters" button sends. */
	onClearFilters?: M
	/** The filtered state's sentence (naming the window) and actions beside "Clear filters". */
	filteredDescription?: string
	filteredActions?: ReadonlyArray<Html>
	onWidenRange?: M
	/** Page detail under the description (Traces' excluded-values hint); `null` renders nothing. */
	detail?: Html | null
	className?: string
	onramp: SignalOnramp
	/** The guide link under the quiet-window and unknown states. */
	guide?: Html
}>

const contentOf = <M>(h: HtmlBuilder<M>, detail: ReadonlyArray<Html>, actions: ReadonlyArray<Html>) =>
	detail.length === 0 && actions.length === 0 ? [] : [emptyContent(h, [...detail, ...actions])]

/** `SignalEmptyStateView`: filtered, loading, absent (the on-ramp), present (quiet window), else unknown. */
export const signalEmptyState = <M>(h: HtmlBuilder<M>, options: SignalEmptyStateOptions<M>): Html => {
	const copy = SIGNAL_COPY[options.signal]
	const subject = options.noun ?? copy.noun
	const purpose = options.purpose ?? copy.purpose
	const detail = detailOf(options.detail)
	const guide = options.guide === undefined ? [] : [options.guide]
	if (options.isFiltered === true)
		return filteredEmpty(h, {
			noun: subject,
			onClear: options.onClearFilters,
			className: options.className,
			detail: options.detail,
			description: options.filteredDescription,
			actions: options.filteredActions,
		})
	const { presence } = options
	if (presence.status === "loading") return presenceLoading(h, options.className)
	if (presence.status === "absent")
		return empty(
			h,
			[
				emptyHeader(h, [
					iconMedia(h, copy.icon),
					// Split where the JSX interpolates, so text runs shape the same.
					emptyTitle(h, ["No ", subject, " yet"]),
					emptyDescription(h, [purpose, " ", ...options.onramp.source]),
				]),
				emptyContent(h, [...detail, ...options.onramp.content], options.onramp.contentClassName),
			],
			options.className,
		)
	if (presence.status === "present") {
		const widen =
			options.onWidenRange === undefined
				? []
				: [
						button(h, { variant: "outline", size: "sm", attributes: [h.OnClick(options.onWidenRange)] }, [
							"Widen time range",
						]),
					]
		const actions = [...widen, ...guide]
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
				...contentOf(h, detail, actions.length === 0 ? [] : [emptyActions(h, actions)]),
			],
			options.className,
		)
	}
	return empty(
		h,
		[
			emptyHeader(h, [emptyTitle(h, ["No ", subject, " found"]), emptyDescription(h, [purpose])]),
			...contentOf(h, detail, guide),
		],
		options.className,
	)
}
