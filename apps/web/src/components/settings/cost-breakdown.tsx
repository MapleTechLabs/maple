import { formatCurrency } from "@maple/domain/format"
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@maple/ui/components/ui/collapsible"

import { ChevronRightIcon } from "@/components/icons"
import { costBreakdown, type SpendModel } from "@/lib/billing/spend"

/**
 * What makes up "Spent so far": the plan, each add-on and one usage overage line.
 * The lines come from the spend model, so they sum to the figure above them.
 */
export function CostBreakdown({ model }: { model: SpendModel }) {
	const lines = costBreakdown(model)

	return (
		<Collapsible>
			<CollapsibleTrigger className="group flex w-full items-center gap-2 px-4 py-2.5 text-left outline-none focus-visible:bg-muted/40">
				<ChevronRightIcon
					aria-hidden
					className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-90 motion-reduce:transition-none"
				/>
				<span className="text-xs font-medium">Cost breakdown</span>
				<span className="truncate text-2xs text-muted-foreground">
					What makes up the amount spent so far
				</span>
			</CollapsibleTrigger>
			<CollapsiblePanel className="px-4 pb-2">
				<div className="divide-y divide-border/60">
					{lines.map((line) => (
						<div key={line.key} className="flex items-baseline justify-between gap-4 py-2">
							<div className="min-w-0">
								<p className="text-sm">{line.label}</p>
								<p className="text-2xs text-muted-foreground">{line.detail}</p>
							</div>
							<span className="shrink-0 font-mono text-sm tabular-nums">
								{line.cents === null
									? "Not itemized"
									: formatCurrency(line.cents / 100, model.currency)}
							</span>
						</div>
					))}
				</div>
				{model.partial && (
					<p className="pt-1 text-2xs text-muted-foreground">
						Some items are on pricing we can't itemize; your invoice has the exact amount.
					</p>
				)}
			</CollapsiblePanel>
		</Collapsible>
	)
}
