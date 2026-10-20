import { resolveRange, WIDEST_RANGE } from "../../lib/time"
import { formatRelativeFrom } from "@maple/ui/lib/time-format"
import { button } from "@maple/web/ui/button"
import { empty, emptyContent, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "@maple/web/ui/empty"
import { icon, type IconName } from "@maple/web/ui/icon"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { SignalPresence, TelemetrySignal } from "../../data/signal-presence"
import { type ConnectGuideOptions, connectGuide } from "./connect-guide"

// A signal's empty state. "No traces" means three things: filters
// excluded everything, this window is quiet, or nothing was ever sent (the on-ramp).

const code = <M>(h: HtmlBuilder<M>, text: string): Html =>
	h.code([h.Class("rounded bg-muted px-1 font-mono text-[0.85em]")], [text])

const COPY: ReadonlyMap<TelemetrySignal, Readonly<{ noun: string; icon: IconName }>> = new Map([
	["traces", { noun: "traces", icon: "NetworkNodesIcon" }],
	["logs", { noun: "logs", icon: "CodeIcon" }],
	["metrics", { noun: "metrics", icon: "PulseIcon" }],
	["sessions", { noun: "sessions", icon: "EyeIcon" }],
] as const)

const sourceOf = <M>(h: HtmlBuilder<M>, signal: TelemetrySignal): ReadonlyArray<Html | string> => {
	if (signal === "traces") return ["Traces come from an OpenTelemetry SDK in your app, exporting to this endpoint."]
	if (signal === "logs")
		return ["Logs come from an OTLP log bridge under your logger. Printing to stdout alone never reaches Maple."]
	if (signal === "metrics") return ["Metrics come from an OpenTelemetry metric reader exporting to this endpoint."]
	// The JSX's text nodes, `{" "}` separators included: they decide where the line breaks.
	return [
		"Sessions come from the browser SDK: install",
		" ",
		code(h, "@maple-dev/browser"),
		" and call",
		" ",
		code(h, "MapleBrowser.init()"),
		" ",
		"with this endpoint.",
	]
}

export type SignalEmptyStateOptions<M> = Readonly<{
	signal: TelemetrySignal
	noun?: string
	isFiltered?: boolean
	onClearFilters?: M
	range: string
	onWidenRange?: M
	detail?: Html
	maybePresence: Option.Option<SignalPresence>
	nowMs: number
	guide: Omit<ConnectGuideOptions<M>, "note">
}>

export const signalEmptyState = <M>(h: HtmlBuilder<M>, options: SignalEmptyStateOptions<M>): Html => {
	const copy = COPY.get(options.signal) ?? { noun: options.signal, icon: "PulseIcon" }
	const subject = options.noun ?? copy.noun
	const canWiden = options.onWidenRange !== undefined && options.range !== WIDEST_RANGE
	const detail = options.detail === undefined ? [] : [options.detail]
	const widen = (variant: "outline" | "ghost") =>
		options.onWidenRange === undefined || !canWiden
			? []
			: [button(h, { variant, size: "sm", attributes: [h.OnClick(options.onWidenRange)] }, ["Widen to 30 days"])]

	if (options.isFiltered === true)
		return empty(
			h,
			[
				emptyHeader(h, [
					emptyMedia(h, { variant: "icon" }, [icon(h, "FilterIcon")]),
					emptyTitle(h, ["No ", subject, " match these filters"]),
					emptyDescription(h, [
						"Nothing in the ",
						resolveRange(options.range).label,
						" window matched. Clear the filters",
						...(canWiden ? [" or widen the range"] : []),
						" to see more.",
					]),
				]),
				emptyContent(h, [
					...detail,
					h.div(
						[h.Class("flex flex-wrap items-center justify-center gap-2")],
						[
							...(options.onClearFilters === undefined
								? []
								: [button(h, { variant: "outline", size: "sm", attributes: [h.OnClick(options.onClearFilters)] }, ["Clear filters"])]),
							...widen("ghost"),
						],
					),
				]),
			],
			"h-full",
		)

	return Option.match(options.maybePresence, {
		// Presence unknown (loading or unreadable): state the fact, give no advice.
		onNone: () =>
			empty(
				h,
				[emptyHeader(h, [emptyTitle(h, ["No ", subject, " found"])]), ...(detail.length > 0 ? [emptyContent(h, detail)] : [])],
				"h-full",
			),
		onSome: (presence) =>
			presence.status === "absent"
				? empty(
						h,
						[
							emptyHeader(h, [
								emptyMedia(h, { variant: "icon" }, [icon(h, copy.icon)]),
								emptyTitle(h, ["No ", subject, " yet"]),
								emptyDescription(h, sourceOf(h, options.signal)),
							]),
							emptyContent(h, [...detail, connectGuide(h, options.guide)], "w-full max-w-md"),
						],
						"h-full",
					)
				: empty(
						h,
						[
							emptyHeader(h, [
								emptyMedia(h, { variant: "icon" }, [icon(h, "ClockIcon")]),
								emptyTitle(h, ["No ", subject, " in this time range"]),
								emptyDescription(h, [
									presence.lastSeenMs === null
										? `Maple has ${copy.noun}, just none in the selected window.`
										: `Maple last received ${copy.noun} ${formatRelativeFrom(presence.lastSeenMs, options.nowMs)}.`,
								]),
							]),
							...(detail.length > 0 || canWiden ? [emptyContent(h, [...detail, ...widen("outline")])] : []),
						],
						"h-full",
					),
	})
}
