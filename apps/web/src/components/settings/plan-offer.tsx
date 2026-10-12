import { useState } from "react"
import { toastManager } from "@maple/ui/components/ui/toast"
import { Eyebrow } from "@maple/ui/components/ui/eyebrow"

import type { CatalogPlan } from "@maple/domain/http"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Panel } from "@maple/ui/components/ui/panel"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/lib/utils"

import { Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import { billingCustomerAtom, billingPlansAtom } from "@/lib/services/atoms/billing-atoms"
import { useBillingActions } from "@/hooks/use-billing-actions"
import { showErrorToast } from "@/lib/error-toast"
import { formatCount } from "@/lib/billing/usage"
import { getTrialStatus } from "@/lib/billing/plan-gating"
import { buildCheckoutSuccessUrl } from "@/lib/billing/checkout-return"
import { useCheckoutReturn } from "@/hooks/use-checkout-return"
import { CheckoutConfirmingPanel, CheckoutTimedOutNotice } from "@/components/settings/checkout-return-panel"
import { getPlanFeatures, TRIAL_DURATION_DAYS } from "@/lib/billing/plans"
import { featureUnit, type SpendModel } from "@/lib/billing/spend"
import { ErrorState } from "@/components/common/error-state"

/**
 * The plans section: one offer, not a tier ladder.
 *
 * `apps/api/autumn.config.ts` sells exactly one self-serve plan, so a card-per-
 * tier grid manufactured a choice that doesn't exist: the same conclusion
 * `apps/landing/src/components/PricingTable.astro` reached for marketing. This is
 * the in-app version of that layout: a plate for the offer, and Enterprise as a
 * one-line rail beneath it rather than a peer card that competes with it.
 *
 * If a second self-serve plan is ever added, the plate lists them stacked and
 * this comment is the signal to revisit the layout.
 */

const ENTERPRISE_CALL_URL = "https://cal.com/david-granzin/30min?overlayCalendar=true"
const ENTERPRISE_FROM_PRICE = "From $2,000"

const includedRun = (plan: CatalogPlan): string =>
	plan.items
		.flatMap((item) => {
			if (!item.featureId || item.included == null) return []
			if (item.featureId === "ai_credits") return [`$${formatCount(item.included)} AI usage`]
			const unit = featureUnit(item.featureId)
			const amount = formatCount(item.included)
			return [unit === "GB" ? `${amount} GB ${item.featureId}` : `${amount} ${unit}`]
		})
		.join(" · ")

export function PlanOfferSkeleton() {
	return (
		<div className="space-y-3">
			<Skeleton className="h-32 w-full rounded-md" />
			<Skeleton className="h-16 w-full rounded-md" />
		</div>
	)
}

/**
 * The plan a custom-priced customer is actually on, rendered as their current
 * plan. Their plan is not for sale, so it can never come from the catalog; the
 * numbers here are their own, from the expanded subscription plus balances.
 */
function CustomPlanPlate({ model, onManageBilling }: { model: SpendModel; onManageBilling: () => void }) {
	const price = model.basePlan?.price?.amount
	const interval = model.basePlan?.price?.interval ?? "month"
	// A hard-capped plan bills nothing past its allotments, so "+ usage" would be
	// a straight untruth on it.
	const billsUsage = model.features.some(
		(feature) => feature.overageAllowed !== false && feature.ratePerUnit !== null,
	)
	const included = model.features
		.filter((feature) => feature.included != null || feature.unlimited)
		.map((feature) =>
			feature.unlimited
				? `unlimited ${feature.label.toLowerCase()}`
				: `${formatCount(Number(feature.included))} ${featureUnit(feature.featureId) === "GB" ? "GB" : ""} ${feature.label.toLowerCase()}`.replace(
						/\s+/g,
						" ",
					),
		)
		.join(" · ")

	return (
		<Panel
			padded
			className="gap-6 border-primary/40 bg-primary/[0.03] lg:flex-row lg:items-start lg:justify-between"
		>
			<div className="max-w-sm">
				<div className="flex items-center gap-2">
					<span className="text-sm">{model.planName ?? "Your plan"}</span>
					<Badge variant="muted" pill size="xs" mono className="px-2 bg-primary/15 text-primary">
						Current plan
					</Badge>
				</div>
				<div className="mt-3 flex items-baseline gap-2">
					<span className="font-mono text-3xl tabular-nums">
						{price == null ? "Custom" : `$${price}`}
					</span>
					<span className="text-2xs text-muted-foreground">
						{price == null
							? "negotiated pricing"
							: billsUsage
								? `/${interval} + usage`
								: `/${interval}`}
					</span>
				</div>
				<p className="mt-3 text-2xs leading-relaxed text-muted-foreground">
					{billsUsage
						? "A custom plan: your allotments and rates are your own, not the published ones."
						: "A custom plan with hard caps: usage past your allotments is rejected, never billed."}
				</p>
			</div>

			<div className="flex-1 lg:px-6">
				<Eyebrow>Included every cycle</Eyebrow>
				<p className="mt-2 font-mono text-2xs leading-relaxed text-foreground/85">
					{included.length > 0 ? included : "Allotments are set on your contract."}
				</p>
			</div>

			<div className="flex w-full shrink-0 flex-col gap-2 lg:w-44">
				<Button variant="outline" size="sm" onClick={onManageBilling}>
					Manage plan
				</Button>
				<p className="text-center text-2xs text-muted-foreground">Invoices and payment method</p>
			</div>
		</Panel>
	)
}

export function PlanOffer({
	model,
	onManageBilling,
}: {
	/** Needed to render a custom plan, whose terms exist only on the customer. */
	model: SpendModel | null
	onManageBilling: () => void
}) {
	const plansResult = useAtomValue(billingPlansAtom)
	const customerResult = useAtomValue(billingCustomerAtom)
	const { attach } = useBillingActions()
	const refreshCustomer = useAtomRefresh(billingCustomerAtom)
	const [attaching, setAttaching] = useState<string | null>(null)
	const checkoutReturn = useCheckoutReturn()

	const { isTrialing, daysRemaining } = getTrialStatus(
		Result.isSuccess(customerResult) ? customerResult.value : undefined,
	)

	// Back from Stripe with the plan not yet synced: wait it out rather than
	// re-offering the plan the buyer just bought.
	if (checkoutReturn === "confirming") return <CheckoutConfirmingPanel />
	if (Result.isInitial(plansResult)) return <PlanOfferSkeleton />
	if (!Result.isSuccess(plansResult)) {
		return <ErrorState error={plansResult.cause} title="Unable to load pricing plans" variant="row" />
	}

	const plans = plansResult.value.plans
	const offers = plans.filter((plan) => !plan.addOn && !plan.autoEnable)
	const addOns = plans.filter((plan) => plan.addOn)
	// A customer on a plan that isn't in the catalog (custom or grandfathered) must
	// see THEIR plan here. Showing the catalog's offer with a "Current plan" chip
	// would quote them a price they don't pay.
	const showCustomPlate = model?.isCustomPlan === true && model.planName !== null

	function handleSubscribe(planId: string) {
		setAttaching(planId)
		return attach({ planId, successUrl: buildCheckoutSuccessUrl(window.location.href) }).then(
			(result) => {
				if (result.paymentUrl) {
					// Keep the button disabled through the redirect (see the note in
					// pricing-cards.tsx). Clearing it here invites the double-click that
					// Autumn answers with a 409.
					window.location.href = result.paymentUrl
					return
				}
				toastManager.add({ title: "Plan updated successfully", type: "success" })
				refreshCustomer()
				setAttaching(null)
			},
			(error: unknown) => {
				showErrorToast(error, { title: "Failed to update your plan" })
				setAttaching(null)
			},
		)
	}

	return (
		<div className="space-y-3">
			{checkoutReturn === "timed_out" && <CheckoutTimedOutNotice />}
			{showCustomPlate && model && <CustomPlanPlate model={model} onManageBilling={onManageBilling} />}
			{offers.map((plan) => {
				const isActive = !showCustomPlate && plan.customerEligibility?.status === "active"
				const trialAvailable = plan.customerEligibility?.trialAvailable === true
				const platformFeatures = getPlanFeatures(plan.id?.toLowerCase() ?? "startup")
				const retention = platformFeatures.find((feature) => feature.label === "Data retention")

				return (
					<Panel
						key={plan.id}
						padded
						className={cn(
							"gap-6 lg:flex-row lg:items-start lg:justify-between",
							isActive && "border-primary/40 bg-primary/[0.03]",
						)}
					>
						<div className="max-w-sm">
							<div className="flex items-center gap-2">
								<span className="text-sm">{plan.name}</span>
								{isActive && (
									<Badge
										variant="muted"
										pill
										size="xs"
										mono
										className="px-2 bg-primary/15 text-primary"
									>
										{isTrialing && daysRemaining != null
											? `Trial · ${daysRemaining}d left`
											: "Current plan"}
									</Badge>
								)}
							</div>
							<div className="mt-3 flex items-baseline gap-2">
								<span className="font-mono text-3xl tabular-nums">
									${plan.price?.amount ?? 0}
								</span>
								<span className="text-2xs text-muted-foreground">
									/{plan.price?.interval ?? "month"} + usage
								</span>
							</div>
							<p className="mt-3 text-2xs leading-relaxed text-muted-foreground">
								Everything in Maple. Pay per GB past what's included.
							</p>
						</div>

						<div className="flex-1 lg:px-6">
							<Eyebrow>Included every cycle</Eyebrow>
							<p className="mt-2 font-mono text-2xs leading-relaxed text-foreground/85">
								{includedRun(plan)}
								{retention && ` · ${retention.value.toLowerCase()} retention`}
							</p>
							{addOns.length > 0 && (
								<div className="mt-3 space-y-1">
									{addOns.map((addOn) => {
										const addOnActive = addOn.customerEligibility?.status === "active"
										return (
											<p key={addOn.id} className="text-2xs text-muted-foreground">
												{addOnActive ? "Add-on active · " : "Add-on available · "}
												{addOn.name}
												{addOn.price?.amount != null &&
													` +$${addOn.price.amount}/${addOn.price.interval ?? "month"}`}
											</p>
										)
									})}
								</div>
							)}
						</div>

						<div className="flex w-full shrink-0 flex-col gap-2 lg:w-44">
							{isActive ? (
								<Button variant="outline" size="sm" onClick={onManageBilling}>
									Manage plan
								</Button>
							) : (
								<Button
									size="sm"
									loading={attaching === plan.id}
									onClick={() => handleSubscribe(plan.id)}
								>
									{trialAvailable
										? `Start ${plan.freeTrial?.durationLength ?? TRIAL_DURATION_DAYS}-day trial`
										: "Subscribe"}
								</Button>
							)}
							<p className="text-center text-2xs text-muted-foreground">
								{isActive ? "Invoices and payment method" : "$0 due today · cancel anytime"}
							</p>
						</div>
					</Panel>
				)
			})}

			{/* Enterprise is a rail, not a peer: it keeps the "From $2,000" anchor
			    that makes the self-serve price read as small, without spending a
			    full card of attention on a call-us flow. */}
			<Panel
				padded
				className="gap-4 border-primary/25 bg-primary/[0.04] sm:flex-row sm:items-center sm:justify-between"
			>
				<div>
					<Eyebrow className="text-primary">Enterprise</Eyebrow>
					<p className="mt-1.5 max-w-[48ch] text-2xs leading-relaxed text-foreground/85">
						Higher volume, custom retention, priority support.
					</p>
				</div>
				<div className="flex shrink-0 items-center justify-between gap-5 sm:justify-end">
					<span className="whitespace-nowrap font-mono text-sm tabular-nums text-primary">
						{ENTERPRISE_FROM_PRICE}
					</span>
					<Button
						variant="outline"
						size="sm"
						className="border-primary/40 text-primary hover:bg-primary/10"
						onClick={() => window.open(ENTERPRISE_CALL_URL, "_blank", "noopener,noreferrer")}
					>
						Talk to the founder →
					</Button>
				</div>
			</Panel>
		</div>
	)
}
