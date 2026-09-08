import { useState } from "react"
import { cn } from "@maple/ui/lib/utils"
import { CircleCheckIcon } from "@/components/icons"

const SPANS = [
	{
		label: "GET /checkout",
		offset: 0,
		width: 97,
		duration: "970 ms",
		detail: "The full request, from arrival to response.",
		tone: "root",
	},
	{
		label: "auth.verify",
		offset: 5,
		width: 19,
		duration: "190 ms",
		detail: "Authentication finishes before the order lookup starts.",
		tone: "ok",
	},
	{
		label: "db.query orders",
		offset: 27,
		width: 16,
		duration: "160 ms",
		detail: "The order lookup is shorter than the payment call.",
		tone: "ok",
	},
	{
		label: "payments.charge",
		offset: 46,
		width: 47,
		duration: "470 ms",
		detail: "The payment call takes nearly half the request. A good place to investigate.",
		tone: "slow",
	},
	{
		label: "cache.write",
		offset: 93,
		width: 5,
		duration: "50 ms",
		detail: "A short cache write at the end of the request.",
		tone: "ok",
	},
] as const

export function DemoPreview() {
	const [selected, setSelected] = useState<(typeof SPANS)[number] | null>(null)
	const foundSlowSpan = selected?.tone === "slow"

	return (
		<section aria-label="Interactive sample trace" className="overflow-hidden rounded-xl border bg-card">
			<div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
				<span className="text-xs font-medium">A slow checkout. A trail to follow.</span>
				<span className="text-xs text-muted-foreground">Sample trace · 970 ms</span>
			</div>
			<div className="p-3 sm:p-4">
				<p className="mb-3 text-xs text-muted-foreground">
					Select a span. Can you spot where the time goes?
				</p>
				<div className="space-y-1">
					{SPANS.map((span) => (
						<button
							key={span.label}
							type="button"
							aria-pressed={selected === span}
							aria-label={`${span.label}, ${span.duration}${span.tone === "slow" ? ", slow span" : ""}`}
							onClick={() => setSelected(span)}
							className={cn(
								"group flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left outline-none transition-colors duration-150 motion-reduce:transition-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring sm:gap-3",
								selected === span && "bg-muted",
							)}
						>
							<span className="w-28 shrink-0 truncate text-[11px] sm:w-36">{span.label}</span>
							<span aria-hidden className="relative h-4 min-w-0 flex-1">
								<span
									className={cn(
										"absolute inset-y-0 rounded-sm transition-opacity duration-150 motion-reduce:transition-none",
										selected && selected !== span ? "opacity-40" : "opacity-100",
										span.tone === "slow"
											? "bg-chart-p95"
											: span.tone === "root"
												? "bg-foreground/60"
												: "bg-chart-p50",
									)}
									style={{ left: `${span.offset}%`, width: `${span.width}%` }}
								/>
							</span>
							<span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
								{span.duration}
							</span>
						</button>
					))}
				</div>
			</div>
			<div aria-live="polite" aria-atomic="true" className="min-h-28 border-t px-5 py-4 sm:min-h-24">
				<p className="flex items-center gap-2 text-xs font-medium">
					{foundSlowSpan && <CircleCheckIcon size={14} className="shrink-0 text-primary" />}
					{foundSlowSpan
						? "Found it. Your first slow span."
						: selected
							? selected.label
							: "Every request leaves a trail."}
				</p>
				<p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
					{selected?.detail ??
						"Follow it across services to see what happened, and where. This sample is yours to explore."}
				</p>
			</div>
		</section>
	)
}
