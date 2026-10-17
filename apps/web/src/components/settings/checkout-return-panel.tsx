import { Panel } from "@maple/ui/components/ui/panel"
import { Spinner } from "@maple/ui/components/ui/spinner"
import { cn } from "@maple/ui/lib/utils"

/**
 * What the buyer sees between Stripe sending them back and Autumn confirming
 * the subscription, so the "Start trial" button they just used cannot be shown
 * to them a second time. `row` is the slim variant for the top of a settings tab.
 */
export function CheckoutConfirmingPanel({ layout = "centered" }: { layout?: "centered" | "row" }) {
	if (layout === "row") {
		return (
			<Panel role="status" aria-live="polite" className="flex-row items-center gap-3 px-4 py-3">
				<Spinner className="size-4 shrink-0" />
				<p className="text-sm">
					Confirming your subscription.{" "}
					<span className="text-muted-foreground">
						This usually takes a few seconds; there's nothing else to click.
					</span>
				</p>
			</Panel>
		)
	}
	return (
		<Panel
			role="status"
			aria-live="polite"
			className="mx-auto max-w-md items-center gap-3 px-6 py-10 text-center"
		>
			<Spinner className="size-5" />
			<p className="text-sm font-medium">Confirming your subscription…</p>
			<p className="text-sm text-muted-foreground">
				Stripe is letting us know your checkout finished. This usually takes a few seconds; there's
				nothing else to click.
			</p>
		</Panel>
	)
}

/** Shown once the wait gave up, so a slow sync doesn't read as "it failed". */
export function CheckoutTimedOutNotice({
	pickPlan = "pick a plan below",
	className,
}: {
	/** Where a buyer who left checkout picks a plan instead. */
	pickPlan?: string
	className?: string
}) {
	return (
		<Panel
			role="status"
			tone="muted"
			className={cn("px-4 py-3 text-sm text-muted-foreground", className)}
		>
			We haven't heard back from Stripe yet. If you completed checkout, your plan will appear here
			shortly; there's no need to subscribe again. If you left checkout, {pickPlan}.
		</Panel>
	)
}
