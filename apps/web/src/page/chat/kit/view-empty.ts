import type { Html, HtmlBuilder } from "foldkit/html"
import { icon, type IconName } from "../../../ui/icon"
import { panel } from "../../../ui/panel"
import { docsLink } from "../../kit/signal-empty-state"
import type { PresenceState } from "../../kit/signal-presence"

// The empty state: the opening screen of a fresh
// conversation, its suggestions as openable rows whose glyph and hue are read from the words.

type Tone = Readonly<{ glyph: IconName; chip: string }>

const TONES = {
	errors: { glyph: "CircleWarningIcon", chip: "text-severity-error bg-severity-error/10 border-severity-error/20" },
	traces: { glyph: "PulseIcon", chip: "text-chart-2 bg-chart-2/10 border-chart-2/20" },
	logs: { glyph: "FileIcon", chip: "text-chart-5 bg-chart-5/10 border-chart-5/20" },
	health: { glyph: "ArrowTrendUpIcon", chip: "text-chart-3 bg-chart-3/10 border-chart-3/20" },
	services: { glyph: "ServerIcon", chip: "text-chart-4 bg-chart-4/10 border-chart-4/20" },
	metrics: { glyph: "ChartLineIcon", chip: "text-chart-1 bg-chart-1/10 border-chart-1/20" },
	any: { glyph: "PixelSparkleIcon", chip: "text-primary bg-primary/10 border-primary/20" },
} satisfies Record<string, Tone>

const includesAny = (text: string, words: ReadonlyArray<string>): boolean => words.some((word) => text.includes(word))

export const toneFor = (suggestion: string): Tone => {
	const s = suggestion.toLowerCase()
	if (includesAny(s, ["metric", "throughput", "rate", "p95", "p99"])) return TONES.metrics
	if (includesAny(s, ["error", "fail", "exception"])) return TONES.errors
	if (includesAny(s, ["trace", "span", "slow", "latency"])) return TONES.traces
	if (s.includes("log")) return TONES.logs
	if (includesAny(s, ["health", "overall", "status"])) return TONES.health
	if (includesAny(s, ["service", "host", "container"])) return TONES.services
	return TONES.any
}

export const chatEmptyState = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		suggestions: ReadonlyArray<string>
		onSelect: (suggestion: string) => M
		tracePresence: PresenceState
	}>,
): Html =>
	h.div(
		[h.Class("flex w-full min-w-0 max-w-xl flex-col px-4")],
		[
			h.div(
				[h.Class("flex flex-col items-center gap-2.5 text-center")],
				[
					h.span(
						[h.Class("relative flex size-11 items-center justify-center")],
						[
							h.span([h.AriaHidden(true), h.Class("absolute inset-0 rounded-full bg-primary/20 blur-lg")], []),
							icon(h, "PixelSparkleIcon", { size: 24, className: "relative text-primary" }),
						],
					),
					h.h3([h.Class("font-medium text-base tracking-tight")], ["Maple AI"]),
					h.p(
						[h.Class("max-w-sm text-muted-foreground text-sm")],
						["Answers from your live telemetry: traces, logs, errors and services."],
					),
					...(options.tracePresence.status === "absent"
						? [
								h.p(
									[h.Class("flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-muted-foreground text-sm")],
									["Maple AI answers from your telemetry. Send some first.", docsLink(h, "instrumentation", "Setup guide")],
								),
							]
						: []),
				],
			),
			panel(
				h,
				{ className: "mt-6 border-border/60 bg-transparent bg-gradient-to-b from-card/70 to-card/20" },
				options.suggestions.map((suggestion, index) => {
					const tone = toneFor(suggestion)
					return h.button(
						[
							h.Type("button"),
							h.OnClick(options.onSelect(suggestion)),
							h.Style({ "animation-delay": `${60 + index * 45}ms`, "animation-fill-mode": "backwards" }),
							h.Class(
								"group flex w-full cursor-pointer items-center gap-3 border-border/50 border-t px-3 py-2.5 text-left transition-colors first:border-t-0 hover:bg-muted/40 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 [animation-duration:300ms]",
							),
						],
						[
							h.span(
								[
									h.Class(
										`flex size-7 shrink-0 items-center justify-center rounded-md border transition-transform group-hover:scale-105 ${tone.chip}`,
									),
								],
								[icon(h, tone.glyph, { size: 14 })],
							),
							h.span(
								[h.Class("min-w-0 flex-1 truncate text-sm transition-colors group-hover:text-foreground")],
								[suggestion],
							),
							icon(h, "CornerDownLeftIcon", {
								size: 12,
								className: "shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100",
							}),
						],
					)
				}),
			),
			h.p([h.Class("mt-3 text-center text-muted-foreground/60 text-xs")], ["Or just start typing. Your keystrokes land in the composer."]),
			h.div([h.Class("mt-4 flex justify-center")], [docsLink(h, "aiAgents", "Use Maple from your editor")]),
		],
	)
