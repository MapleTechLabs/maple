import { StatusMarker } from "@/components/ai-elements/status-marker"
import { DOT_LOADER_VARIANTS, DotLoader } from "@/components/ai-elements/dot-loader"

/**
 * Every loader in the chat's pool, at the two sizes it is actually used at, on the line it is
 * actually used on.
 *
 * The point of the harness is the baseline: each row sets its glyph beside real text in the
 * real type ramp, so a matrix that sits a pixel high or drifts off its 18px box shows up as a
 * step in a column of sixteen rather than something you have to catch mid-animation. The last
 * block renders the production `StatusMarker` sixteen times so the random pick can be compared
 * against the fixed grid above it.
 */
export function LoadersLab() {
	return (
		<div className="mx-auto flex max-w-3xl flex-col gap-10 p-8">
			<header className="flex flex-col gap-1">
				<h1 className="font-semibold text-lg">Chat loaders</h1>
				<p className="text-muted-foreground text-sm">
					{DOT_LOADER_VARIANTS.length} dot-matrix variants. The chat picks one at random per
					mount.
				</p>
			</header>

			<section className="flex flex-col gap-1">
				<h2 className="mb-2 text-muted-foreground text-xs uppercase tracking-[0.14em]">
					Inline at 18px — the tool row and thinking row
				</h2>
				{DOT_LOADER_VARIANTS.map(({ name, Component, dotSize }) => (
					<div key={name} className="flex items-center gap-2 py-0.5 text-xs">
						<span className="flex size-5 shrink-0 items-center justify-center">
							<Component size={18} dotSize={dotSize} color="currentColor" ariaLabel={name} />
						</span>
						<span className="min-w-0 flex-1 truncate font-medium text-foreground">
							Searching Traces
						</span>
						<span className="w-32 shrink-0 text-right font-mono text-muted-foreground/60">
							{name}
						</span>
					</div>
				))}
			</section>

			<section className="flex flex-col gap-1">
				<h2 className="mb-2 text-muted-foreground text-xs uppercase tracking-[0.14em]">
					Inline at 14px — the sidebar tab
				</h2>
				{DOT_LOADER_VARIANTS.map(({ name, Component, dotSize }) => (
					<div key={name} className="flex items-center gap-2 py-0.5 text-sm">
						<Component size={14} dotSize={dotSize} color="var(--primary)" ariaLabel={name} />
						<span className="min-w-0 flex-1 truncate">Investigating checkout latency</span>
						<span className="w-32 shrink-0 text-right font-mono text-muted-foreground/60 text-xs">
							{name}
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
					The checkout path is still degraded <DotLoader label="Working" /> and the paywall
					worker is the one dragging it down <DotLoader label="Working" /> so I am pulling the
					last hour of spans <DotLoader label="Working" /> before saying anything firmer.
				</p>
			</section>
		</div>
	)
}
