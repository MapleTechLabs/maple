import { resolveRange, WIDEST_RANGE } from "../../lib/time"
import { button } from "@maple/views/ui/button"
import type { PresenceState, TelemetrySignalKind } from "@maple/views/data/signal-presence"
import { inlineCode } from "@maple/views/ui/inline-code"
import { signalEmptyState as sharedSignalEmptyState } from "@maple/views/ui/signal-empty-state"
import type { Html, HtmlBuilder } from "foldkit/html"
import { type ConnectGuideOptions, connectGuide } from "./connect-guide"

// The shared `SignalEmptyState` with Maple Local's on-ramp: this server's OTLP endpoint to copy.

const code = <M>(h: HtmlBuilder<M>, text: string): Html => inlineCode(h, {}, [text])

const sourceOf = <M>(h: HtmlBuilder<M>, signal: TelemetrySignalKind): ReadonlyArray<Html | string> => {
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
	signal: Exclude<TelemetrySignalKind, "product_events">
	noun?: string
	isFiltered?: boolean
	onClearFilters?: M
	range: string
	/** Offered until the range is already the widest. */
	onWidenRange?: M
	detail?: Html
	presence: PresenceState
	nowMs: number
	guide: Omit<ConnectGuideOptions<M>, "note">
}>

export const signalEmptyState = <M>(h: HtmlBuilder<M>, options: SignalEmptyStateOptions<M>): Html => {
	const onWiden = options.range === WIDEST_RANGE ? undefined : options.onWidenRange
	return sharedSignalEmptyState(h, {
		signal: options.signal,
		noun: options.noun,
		isFiltered: options.isFiltered,
		onClearFilters: options.onClearFilters,
		filteredDescription: `Nothing in the ${resolveRange(options.range).label} window matched. Clear the filters${onWiden === undefined ? "" : " or widen the range"} to see more.`,
		filteredActions:
			onWiden === undefined
				? []
				: [button(h, { variant: "ghost", size: "sm", attributes: [h.OnClick(onWiden)] }, ["Widen to 30 days"])],
		onWidenRange: onWiden,
		detail: options.detail,
		presence: options.presence,
		nowMs: options.nowMs,
		className: "h-full",
		onramp: {
			source: sourceOf(h, options.signal),
			content: [connectGuide(h, options.guide)],
			contentClassName: "w-full max-w-md",
		},
	})
}
