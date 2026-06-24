import type { ReactNode } from "react"

import { cn } from "@maple/ui/utils"
import { ChartLegendSlotContext } from "@maple/ui/components/ui/chart"
import { Dialog, DialogPopup, DialogTitle } from "@maple/ui/components/ui/dialog"
import { useMemo } from "react"

interface ChartExpandModalProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	title: string
	/** The chart, rendered larger to fill the modal body. */
	children: ReactNode
}

/**
 * A near-fullscreen, centered modal that renders a chart at a larger size.
 * Reused by dashboard chart widgets and the service/home metrics grid so the
 * expand affordance and dialog wiring live in one place.
 *
 * The body provides its own `ChartLegendSlotContext` (the in-modal chart shows
 * its legend inline rather than hoisting it into a widget header), so the
 * expanded chart renders independently of the parent widget's legend slot.
 */
export function ChartExpandModal({ open, onOpenChange, title, children }: ChartExpandModalProps) {
	// The expanded chart renders its legend inline (legend is promoted to
	// "visible"), so the hoist slot is a no-op sink — it just absorbs any items a
	// chart tries to hoist without forcing a wasted re-render of the modal.
	const legendSlot = useMemo(() => ({ setItems: () => {} }), [])

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogPopup
				className={cn(
					"h-[90vh] max-h-[90vh] w-[90vw] max-w-[1600px] origin-center flex-col gap-3 p-6",
				)}
			>
				<DialogTitle className="shrink-0 truncate pe-10 text-base font-semibold">{title}</DialogTitle>
				<div className="min-h-0 flex-1">
					<ChartLegendSlotContext.Provider value={legendSlot}>
						{open ? children : null}
					</ChartLegendSlotContext.Provider>
				</div>
			</DialogPopup>
		</Dialog>
	)
}
