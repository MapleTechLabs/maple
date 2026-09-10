import { StatusMarker } from "@/components/ai-elements/status-marker"
import { DOT_LOADER_VARIANTS, DotLoader } from "@/components/ai-elements/dot-loader"

/**
 * Every loader in the chat's pool, at the two sizes it is actually used at, on the line it is
 * actually used on.
 *
 * The point of the harness is the baseline: each row sets its glyph beside real text in the real
 * type ramp, so a matrix that sits a pixel high or renders short of its box shows up as a step in
 * a column of sixteen rather than as something you have to catch mid-animation. Every row goes
 * through `DotLoader` with a pinned `variant` rather than rendering the matrix directly, so what
 * the gallery shows is what the chat ships, geometry and tempo included.
 */
export function LoadersLab() {
	return (
		<div className="mx-auto flex max-w-3xl flex-col gap-10 p-8">
			<header className="flex flex-col gap-1">
				<h1 className="font-semibold text-lg">Chat loaders</h1>
				<p className="text-muted-foreground text-sm">
					{DOT_LOADER_VARIANTS.length} dot-matrix variants. The chat picks one at random per mount.
				</p>
			</header>

			<section className="flex flex-col gap-1">
				<h2 className="mb-2 text-muted-foreground text-xs uppercase tracking-[0.14em]">
					Inline at 18px — the tool row and thinking row
				</h2>
				{DOT_LOADER_VARIANTS.map((variant) => (
					<div key={variant.name} className="flex items-center gap-2 py-0.5 text-xs">
						<span className="flex size-5 shrink-0 items-center justify-center">
							<DotLoader variant={variant} />
						</span>
						<span className="min-w-0 flex-1 truncate font-medium text-foreground">
							Searching Traces
						</span>
						<span className="w-32 shrink-0 text-right font-mono text-muted-foreground/60">
							{variant.name}
						</span>
					</div>
				))}
			</section>

			<section className="flex flex-col gap-1">
				<h2 className="mb-2 text-muted-foreground text-xs uppercase tracking-[0.14em]">
					Inline at 14px — the sidebar tab
				</h2>
				{DOT_LOADER_VARIANTS.map((variant) => (
					<div key={variant.name} className="flex items-center gap-2 py-0.5 text-sm">
						<DotLoader variant={variant} size={14} color="var(--primary)" />
						<span className="min-w-0 flex-1 truncate">Investigating checkout latency</span>
						<span className="w-32 shrink-0 text-right font-mono text-muted-foreground/60 text-xs">
							{variant.name}
						</span>
					</div>
				))}
			</section>

			<section className="flex flex-col gap-1">
				<h2 className="mb-2 text-muted-foreground text-xs uppercase tracking-[0.14em]">
					Random picks, as the chat renders them
				</h2>
				{Array.from({ length: DOT_LOADER_VARIANTS.length }, (_, i) => (
					<StatusMarker key={i} />
				))}
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
