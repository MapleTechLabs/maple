import type { ComponentType } from "react"
import {
	ArrowTrendUpIcon,
	ChartLineIcon,
	CompactLinesIcon,
	CornerDownLeftIcon,
	PixelNodesIcon,
	PixelSparkleIcon,
	PixelTriangleWarningIcon,
	ServerIcon,
} from "@/components/icons"
import type { IconProps } from "@/components/icons/icon"

interface Tone {
	Glyph: ComponentType<IconProps>
	/** Glyph chip: hue as text, the same hue at low alpha as fill and hairline. */
	chip: string
}

const TONES = {
	errors: {
		Glyph: PixelTriangleWarningIcon,
		chip: "text-destructive bg-destructive/10 border-destructive/20",
	},
	traces: { Glyph: PixelNodesIcon, chip: "text-chart-2 bg-chart-2/10 border-chart-2/20" },
	logs: { Glyph: CompactLinesIcon, chip: "text-chart-5 bg-chart-5/10 border-chart-5/20" },
	health: { Glyph: ArrowTrendUpIcon, chip: "text-chart-3 bg-chart-3/10 border-chart-3/20" },
	services: { Glyph: ServerIcon, chip: "text-chart-4 bg-chart-4/10 border-chart-4/20" },
	metrics: { Glyph: ChartLineIcon, chip: "text-chart-1 bg-chart-1/10 border-chart-1/20" },
	any: { Glyph: PixelSparkleIcon, chip: "text-primary bg-primary/10 border-primary/20" },
} satisfies Record<string, Tone>

/**
 * A suggestion is a plain string — the generators build it from the page the user
 * came from — so the row's glyph and hue are read back out of the words. Wrong
 * guesses cost nothing (the fallback is the neutral sparkle) and a right one says
 * which signal the question lands in before the user clicks it.
 */
function toneFor(suggestion: string): Tone {
	const s = suggestion.toLowerCase()
	if (
		s.includes("metric") ||
		s.includes("throughput") ||
		s.includes("rate") ||
		s.includes("p95") ||
		s.includes("p99")
	) {
		return TONES.metrics
	}
	if (s.includes("error") || s.includes("fail") || s.includes("exception")) return TONES.errors
	if (s.includes("trace") || s.includes("span") || s.includes("slow") || s.includes("latency")) {
		return TONES.traces
	}
	if (s.includes("log")) return TONES.logs
	if (s.includes("health") || s.includes("overall") || s.includes("status")) return TONES.health
	if (s.includes("service") || s.includes("host") || s.includes("container")) return TONES.services
	return TONES.any
}

/**
 * The opening screen of a fresh conversation. The suggestions are the whole point
 * of it — they teach what Maple AI can be asked — so they read as a list of
 * openable things rather than a wrapped row of pills, where the longest question
 * was truncated to fit a pill's fixed height.
 */
export function ChatEmptyState({
	suggestions,
	onSelect,
}: {
	suggestions: readonly string[]
	onSelect: (suggestion: string) => void
}) {
	return (
		<div className="flex w-full min-w-0 max-w-xl flex-col px-4">
			<div className="flex flex-col items-center gap-2.5 text-center">
				<span className="relative flex size-11 items-center justify-center">
					{/* The lit ground behind the mark: one soft primary bloom, no border. */}
					<span
						aria-hidden
						className="absolute inset-0 rounded-full bg-primary/20 blur-lg motion-safe:animate-pulse [animation-duration:4s]"
					/>
					<PixelSparkleIcon size={24} className="relative text-primary" />
				</span>
				<h3 className="font-medium text-base tracking-tight">Maple AI</h3>
				<p className="max-w-sm text-muted-foreground text-sm">
					Answers from your live telemetry — traces, logs, errors and services.
				</p>
			</div>

			<div className="mt-6 overflow-hidden rounded-xl border border-border/60 bg-gradient-to-b from-card/70 to-card/20">
				{suggestions.map((suggestion, index) => {
					const { Glyph, chip } = toneFor(suggestion)
					return (
						<button
							key={suggestion}
							type="button"
							onClick={() => onSelect(suggestion)}
							style={{ animationDelay: `${60 + index * 45}ms`, animationFillMode: "backwards" }}
							className="group flex w-full cursor-pointer items-center gap-3 border-border/50 border-t px-3 py-2.5 text-left transition-colors first:border-t-0 hover:bg-muted/40 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 [animation-duration:300ms]"
						>
							<span
								className={`flex size-7 shrink-0 items-center justify-center rounded-md border transition-transform group-hover:scale-105 ${chip}`}
							>
								<Glyph size={14} />
							</span>
							<span className="min-w-0 flex-1 truncate text-sm transition-colors group-hover:text-foreground">
								{suggestion}
							</span>
							<CornerDownLeftIcon
								size={12}
								className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
							/>
						</button>
					)
				})}
			</div>

			<p className="mt-3 text-center text-muted-foreground/60 text-xs">
				Or just start typing — your keystrokes land in the composer.
			</p>
		</div>
	)
}
