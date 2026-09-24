import { StatusMarker } from "@/components/ai-elements/status-marker"
import { DotLoader } from "@/components/ai-elements/dot-loader"

/**
 * The chat's loader, on the lines it actually sits on.
 *
 * The point of the harness is the baseline: the same glyph beside real text in the real type
 * ramp, next to the settled icons it hands off to, so a matrix that sits a pixel high or renders
 * short of its box shows up as a step in a column rather than as something you have to catch
 * mid-animation. Stacked rows are the other half — one loader reads fine anywhere, and the thing
 * worth checking is that a page full of them stays still.
 */
export function LoadersLab() {
	return (
		<div className="mx-auto flex max-w-3xl flex-col gap-10 p-8">
			<header className="flex flex-col gap-1">
				<h1 className="font-semibold text-lg">Chat loader</h1>
				<p className="text-muted-foreground text-sm">
					One dot-matrix animation, one 14px box, everywhere the chat reports work in flight.
				</p>
			</header>

			<section className="flex flex-col gap-1">
				<h2 className="mb-2 text-muted-foreground text-xs uppercase tracking-[0.14em]">
					The tool row — running, then settled
				</h2>
				{["Searching Traces", "Reading spans", "Grouping by service"].map((line) => (
					<div key={line} className="flex items-center gap-2 py-0.5 text-xs">
						<span className="flex size-5 shrink-0 items-center justify-center">
							<DotLoader />
						</span>
						<span className="min-w-0 flex-1 truncate font-medium text-foreground">{line}</span>
					</div>
				))}
			</section>

			<section className="flex flex-col gap-1">
				<h2 className="mb-2 text-muted-foreground text-xs uppercase tracking-[0.14em]">
					The sidebar tab
				</h2>
				<div className="flex items-center gap-2 py-0.5 text-sm">
					<DotLoader color="var(--primary)" label="Working" />
					<span className="min-w-0 flex-1 truncate">Investigating checkout latency</span>
				</div>
			</section>

			<section className="flex flex-col gap-1">
				<h2 className="mb-2 text-muted-foreground text-xs uppercase tracking-[0.14em]">
					The thinking row
				</h2>
				<StatusMarker />
			</section>

			<section className="flex flex-col gap-2">
				<h2 className="mb-2 text-muted-foreground text-xs uppercase tracking-[0.14em]">
					In running prose
				</h2>
				<p className="text-sm leading-relaxed">
					The checkout path is still degraded <DotLoader /> and the paywall worker is the one
					dragging it down <DotLoader /> so I am pulling the last hour of spans <DotLoader />
					before saying anything firmer.
				</p>
			</section>
		</div>
	)
}
