import { useMemo } from "react"

import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Button } from "@maple/ui/components/ui/button"
import { Badge } from "@maple/ui/components/ui/badge"
import { KeyValue, KeyValueList } from "@maple/ui/components/ui/key-value"
import { cn } from "@maple/ui/lib/utils"

import { Result, useAtomValue } from "@/lib/effect-atom"
import {
	billingCustomerAtom,
	billingDailySpendAtom,
	billingPlansAtom,
	billingUsageAtom,
} from "@/lib/services/atoms/billing-atoms"
import { useBillingActions } from "@/hooks/use-billing-actions"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { formatDateInTimezone } from "@/lib/timezone-format"
import { SettingsSection, SettingsSections } from "@/components/settings/settings-section"
import { getLegacyPlanInfo, getTrialStatus, type TrialStatus } from "@/lib/billing/plan-gating"
import { buildSpendModel } from "@/lib/billing/spend"
import { estimateCycleCost } from "@/lib/billing/cost-estimate"
import { maximumInvoiceCents, spendLimitFor } from "@/lib/billing/controls"
import { BillingKpis, BillingKpisSkeleton } from "./billing-kpis"
import { FeatureUsageCards, FeatureUsageCardsSkeleton } from "./feature-usage-cards"
import { SpendChart, SpendChartSkeleton } from "./spend-chart"
import { BillingControlsCard, BillingControlsCardSkeleton } from "./billing-controls-card"
import { PlanOffer } from "./plan-offer"
import { CostBreakdown, CostBreakdownSkeleton } from "./cost-breakdown"
import { InvoicesSection } from "./invoices-section"
import { BillingDetailsSection } from "./billing-details-section"

/**
 * Billing, spend-first.
 *
 * Reading order matches the question a customer actually arrives with: what am I
 * on → what is this cycle costing → which signals are driving it → how it accrues
 * → what stops it → the itemized proof → what plan options exist. The four
 * feature cards sit ABOVE the chart deliberately: they are the things being
 * billed, and the chart is only their sum over time.
 */

function SubscriptionStrip({
	trial,
	isLegacy,
	billingPeriodLabel,
	isLoading,
	onManageBilling,
}: {
	trial: TrialStatus
	isLegacy: boolean
	billingPeriodLabel: string
	isLoading: boolean
	onManageBilling: () => void
}) {
	const { effectiveTimezone } = useTimezonePreference()
	if (isLoading) {
		return (
			<div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
				<div className="flex flex-wrap items-baseline gap-x-8 gap-y-3">
					<div className="flex flex-col gap-1.5">
						<Skeleton className="h-2.5 w-10" />
						<Skeleton className="h-4 w-20" />
					</div>
					<div className="flex flex-col gap-1.5">
						<Skeleton className="h-2.5 w-12" />
						<Skeleton className="h-4 w-24" />
					</div>
					<div className="flex flex-col gap-1.5">
						<Skeleton className="h-2.5 w-12" />
						<Skeleton className="h-4 w-32" />
					</div>
				</div>
				<Skeleton className="h-8 w-32" />
			</div>
		)
	}

	const { isTrialing, daysRemaining, trialEndsAt, planName, planStatus } = trial
	if (!planStatus || !planName) return null

	const statusValue = isTrialing && daysRemaining != null ? `Trial · ${daysRemaining}d left` : "Active"

	return (
		<div>
			<div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
				<KeyValueList layout="stacked" className="flex flex-wrap gap-x-8 gap-y-3">
					<KeyValue label="Plan" valueClassName="gap-2 text-sm">
						<span className="capitalize">{planName}</span>
						{isLegacy ? (
							<Badge size="sm" variant="warn" className="ml-2">
								Legacy
							</Badge>
						) : null}
					</KeyValue>
					<KeyValue
						label="Status"
						valueClassName={cn("text-sm tabular-nums", isTrialing && "text-primary")}
					>
						{statusValue}
					</KeyValue>
					<KeyValue label="Period" valueClassName="text-sm tabular-nums">
						{billingPeriodLabel}
					</KeyValue>
				</KeyValueList>
				<Button variant="outline" size="sm" onClick={onManageBilling}>
					Manage billing
				</Button>
			</div>
			{isLegacy && (
				<p className="mt-3 text-xs text-muted-foreground">
					You're on a legacy plan that's no longer offered. Switch to a current plan below for the
					latest pricing and features.
				</p>
			)}
			{isTrialing && trialEndsAt && (
				<p className="mt-3 text-xs text-muted-foreground">
					Card charges when trial ends on{" "}
					{formatDateInTimezone(trialEndsAt, { timeZone: effectiveTimezone, withYear: false })}.
					Cancel anytime before to avoid charges.
				</p>
			)}
		</div>
	)
}

export function BillingSection({ isAdmin = true }: { isAdmin?: boolean }) {
	const customerResult = useAtomValue(billingCustomerAtom)
	const plansResult = useAtomValue(billingPlansAtom)
	const usageResult = useAtomValue(billingUsageAtom)
	const dailySpendResult = useAtomValue(billingDailySpendAtom)
	const { openCustomerPortal } = useBillingActions()
	const { effectiveTimezone } = useTimezonePreference()

	const customer = Result.isSuccess(customerResult) ? customerResult.value : undefined
	const plans = Result.isSuccess(plansResult) ? plansResult.value.plans : undefined
	const usageTotal = Result.isSuccess(usageResult) ? usageResult.value.total : undefined
	const daily = Result.isSuccess(dailySpendResult) ? dailySpendResult.value : undefined

	const isLoading = Result.isInitial(customerResult) || Result.isInitial(usageResult)
	// The estimate also needs the plan catalog (for base price + overage rates);
	// without it a legacy-looking partial estimate would flash during load.
	const isCostLoading = isLoading || Result.isInitial(plansResult)

	const trial = getTrialStatus(customer)
	const { isLegacy } = getLegacyPlanInfo(customer, plans)

	const billingPeriodLabel = useMemo(() => {
		const timeZone = effectiveTimezone
		const range = (start: Date, end: Date) =>
			`${formatDateInTimezone(start, { timeZone, withYear: false })} – ${formatDateInTimezone(end, { timeZone })}`
		const activeSub = customer?.subscriptions?.find((s) => s.status === "active")
		if (activeSub?.currentPeriodStart && activeSub?.currentPeriodEnd) {
			return range(new Date(activeSub.currentPeriodStart), new Date(activeSub.currentPeriodEnd))
		}
		const now = new Date()
		return range(new Date(now.getFullYear(), now.getMonth(), 1), now)
	}, [customer, effectiveTimezone])

	const costEstimate = useMemo(
		() => estimateCycleCost({ customer, plans, usage: usageTotal }),
		[customer, plans, usageTotal],
	)

	// One spend model feeds the KPI row, the feature cards, and the chart, so the
	// three can't disagree about what this cycle costs.
	const model = useMemo(
		() => buildSpendModel({ customer, plans, usage: usageTotal, nowMs: Date.now() }),
		[customer, plans, usageTotal],
	)
	const maximumInvoice = maximumInvoiceCents(model, customer)
	const overageCaps = Object.fromEntries(
		(model?.features ?? []).map((feature) => [
			feature.featureId,
			spendLimitFor(customer, feature.featureId)?.overageLimit ?? null,
		]),
	)

	return (
		<SettingsSections>
			<SubscriptionStrip
				trial={trial}
				isLegacy={isLegacy}
				billingPeriodLabel={billingPeriodLabel}
				isLoading={Result.isInitial(customerResult)}
				onManageBilling={() => openCustomerPortal({ returnUrl: window.location.href })}
			/>

			{isLoading || model === null ? (
				<BillingKpisSkeleton />
			) : (
				<BillingKpis model={model} maximumInvoiceCents={maximumInvoice} />
			)}

			<SettingsSection title="Usage by feature" description={billingPeriodLabel} framed={false}>
				{isLoading || model === null ? (
					<FeatureUsageCardsSkeleton />
				) : (
					<FeatureUsageCards model={model} overageCaps={overageCaps} />
				)}
			</SettingsSection>

			{isLoading || model === null || Result.isInitial(dailySpendResult) ? (
				<SpendChartSkeleton />
			) : (
				<SpendChart model={model} daily={daily} />
			)}

			<SettingsSection
				title="Billing controls"
				description="Paid overage caps, enforced per feature"
				framed={false}
			>
				{customer === undefined ? (
					<BillingControlsCardSkeleton />
				) : (
					<BillingControlsCard customer={customer} model={model} canEdit={isAdmin} />
				)}
			</SettingsSection>

			<SettingsSection title="Billing details" description="Printed on every invoice" framed={false}>
				<BillingDetailsSection canEdit={isAdmin} />
			</SettingsSection>

			{(isCostLoading || costEstimate !== null) && (
				<SettingsSection title="Estimated costs" description={billingPeriodLabel} framed={false}>
					{isCostLoading || !costEstimate ? (
						<CostBreakdownSkeleton />
					) : (
						<CostBreakdown estimate={costEstimate} />
					)}
				</SettingsSection>
			)}

			<SettingsSection title="Invoices" framed={false}>
				<InvoicesSection
					onManageBilling={() => openCustomerPortal({ returnUrl: window.location.href })}
				/>
			</SettingsSection>

			<SettingsSection
				title="Plans"
				description="Need higher volume or custom retention?"
				framed={false}
			>
				<PlanOffer
					model={model}
					onManageBilling={() => openCustomerPortal({ returnUrl: window.location.href })}
				/>
			</SettingsSection>
		</SettingsSections>
	)
}
