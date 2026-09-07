import { useState } from "react"
import { brandMark, markColor, type BrandMarkId } from "../lib/brand-marks"
import { competitorConfigs, PricingCalculator, type Competitor } from "./PricingCalculator"

const COMPETITORS: Competitor[] = ["datadog", "grafana", "new-relic", "dash0", "openobserve", "signoz"]

const MARKS: Record<Competitor, BrandMarkId> = {
	datadog: "datadog",
	grafana: "grafana",
	"new-relic": "newrelic",
	dash0: "dash0",
	openobserve: "openobserve",
	signoz: "signoz",
}

/** The vendor's mark in its brand colour; on the active (amber) tab it takes the tab's foreground instead. */
function VendorMark({ id, active }: { id: BrandMarkId; active: boolean }) {
	const mark = brandMark(id)
	return (
		<svg
			viewBox={mark.viewBox ?? "0 0 24 24"}
			className="h-3.5 w-3.5 shrink-0"
			style={active ? undefined : { color: markColor(mark) }}
			fill="currentColor"
			aria-hidden="true"
		>
			<path d={mark.path} />
			{mark.overlay && <path d={mark.overlay.path} fill={mark.overlay.fill} fillRule={mark.overlay.fillRule} />}
		</svg>
	)
}

/**
 * Wraps PricingCalculator with a competitor switcher so the /pricing page can
 * compare Maple against any vendor. The inner calculator is remounted via `key`
 * on each switch so its slider state re-seeds to the selected competitor's
 * defaults (its useState initializer runs once per mount).
 */
export function PricingComparisonCalculator() {
	const [competitor, setCompetitor] = useState<Competitor>("datadog")

	return (
		<div>
			<div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
				<span className="text-[10px] uppercase tracking-wider text-fg-muted">Compare against</span>
				<div role="tablist" aria-label="Compare against" className="inline-flex flex-wrap gap-1">
					{COMPETITORS.map((c) => {
						const active = c === competitor
						return (
							<button
								key={c}
								type="button"
								role="tab"
								aria-selected={active}
								onClick={() => setCompetitor(c)}
								className={`inline-flex h-8 items-center gap-2 rounded-lg pl-2.5 pr-3 text-xs font-medium transition-colors ${
									active
										? "bg-primary text-primary-foreground"
										: "border border-border bg-bg text-fg-muted hover:bg-bg-elevated hover:text-fg"
								}`}
							>
								<VendorMark id={MARKS[c]} active={active} />
								{competitorConfigs[c].name}
							</button>
						)
					})}
				</div>
			</div>
			<PricingCalculator key={competitor} competitor={competitor} />
		</div>
	)
}
