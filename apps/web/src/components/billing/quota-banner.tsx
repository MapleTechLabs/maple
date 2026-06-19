import { useState } from "react"
import { useMapleCustomer } from "@/hooks/use-maple-customer"
import { Link } from "@tanstack/react-router"

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@maple/ui/components/ui/alert"
import { Button } from "@maple/ui/components/ui/button"
import { CircleWarningIcon, XmarkIcon } from "@/components/icons"
import { getActivePlan, getQuotaStatus, type QuotaLevel } from "@/lib/billing/plan-gating"

// Dev-only escape hatch so the banner can be eyeballed without an over-quota
// Autumn customer: load any page with `?quota_preview=approaching` or
// `?quota_preview=over`. Compiled out of production builds (import.meta.env.DEV).
function previewLevel(): QuotaLevel | null {
	if (!import.meta.env.DEV || typeof window === "undefined") return null
	const value = new URLSearchParams(window.location.search).get("quota_preview")
	return value === "approaching" || value === "over" ? value : null
}

// Reads a one-shot dismissal flag from sessionStorage without an effect: the
// initializer runs lazily (guarded for SSR), and `dismiss` writes through.
function useSessionDismiss(key: string) {
	const [dismissed, setDismissed] = useState(() => {
		if (typeof window === "undefined") return false
		return window.sessionStorage.getItem(key) === "1"
	})
	const dismiss = () => {
		setDismissed(true)
		if (typeof window !== "undefined") window.sessionStorage.setItem(key, "1")
	}
	return [dismissed, dismiss] as const
}

/**
 * Informational usage alert shown in the app shell when a base-plan org
 * approaches or exceeds the usage included in its plan. Purely a heads-up to
 * prompt an upgrade — nothing is blocked. Usage-based and unlimited orgs never
 * see it (they have no fixed cap). The "approaching" variant is dismissible for
 * the session; the "over" variant stays put.
 */
export function QuotaBanner() {
	const { data: customer } = useMapleCustomer()
	const status = previewLevel() ?? getQuotaStatus(customer)
	const [approachingDismissed, dismissApproaching] = useSessionDismiss("quota-banner-approaching")

	if (status === "ok") return null
	if (status === "approaching" && approachingDismissed) return null

	const planName = getActivePlan(customer)?.plan?.name ?? "plan"
	const isOver = status === "over"

	return (
		<div className="px-4 pt-3">
			<Alert variant={isOver ? "error" : "warning"}>
				<CircleWarningIcon size={16} />
				<AlertTitle>
					{isOver
						? `You've reached your ${planName} usage limit`
						: `You're nearing your ${planName} usage limit`}
				</AlertTitle>
				<AlertDescription>
					{isOver
						? "You've used all the logs, traces, or metrics included in your plan this period. Upgrade for more headroom."
						: "You're approaching the usage included in your plan. Upgrade for more headroom before you reach the limit."}
				</AlertDescription>
				<AlertAction className="flex items-center gap-2">
					<Button
						size="sm"
						variant={isOver ? "default" : "outline"}
						render={<Link to="/settings" search={{ tab: "billing" }} />}
					>
						{isOver ? "Upgrade plan" : "View usage"}
					</Button>
					{!isOver && (
						<Button
							size="icon-sm"
							variant="ghost"
							aria-label="Dismiss"
							onClick={dismissApproaching}
						>
							<XmarkIcon size={16} />
						</Button>
					)}
				</AlertAction>
			</Alert>
		</div>
	)
}
