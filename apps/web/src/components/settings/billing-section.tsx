import { useMemo, useRef, useState } from "react"

import { Button } from "@maple/ui/components/ui/button"

import { Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import {
	billingCustomerAtom,
	billingDailySpendAtom,
	billingPlansAtom,
	billingUsageAtom,
} from "@/lib/services/atoms/billing-atoms"
import { useBillingActions } from "@/hooks/use-billing-actions"
import { SettingsSection, SettingsSections } from "@/components/settings/settings-section"
import { getLegacyPlanInfo, getTrialStatus } from "@/lib/billing/plan-gating"
import { buildSpendModel, type SpendFeatureId } from "@/lib/billing/spend"
import { maximumInvoiceCents, uncappedFeatures } from "@/lib/billing/controls"
import { BillingCyclePanel, BillingCyclePanelSkeleton } from "./billing-cycle-panel"
import { BillingUsageTable, BillingUsageTableSkeleton } from "./billing-usage-table"
import { SpendChart, SpendChartError, SpendChartSkeleton } from "./spend-chart"
import { BillingPlanSection } from "./billing-plan-section"
import { AdminOnlyNotice } from "./admin-only-notice"
import { CheckoutConfirmingPanel, CheckoutTimedOutNotice } from "./checkout-return-panel"
import { useCheckoutReturn } from "@/hooks/use-checkout-return"
import { InvoicesSection } from "./invoices-section"
import { BillingDetailsSection } from "./billing-details-section"
import { ErrorState } from "@/components/common/error-state"

/**
 * Billing, spend-first: what this cycle costs, which feature drives it and where
 * its caps sit, then the plan, the invoices and the details printed on them.
 * One spend model feeds every figure, so no two numbers on the tab can disagree.
 */
export function BillingSection({ isAdmin }: { isAdmin: boolean }) {
	const customerResult = useAtomValue(billingCustomerAtom)
	const refreshCustomer = useAtomRefresh(billingCustomerAtom)
	const plansResult = useAtomValue(billingPlansAtom)
	const usageResult = useAtomValue(billingUsageAtom)
	const dailySpendResult = useAtomValue(billingDailySpendAtom)
	const refreshDailySpend = useAtomRefresh(billingDailySpendAtom)
	const { openCustomerPortal } = useBillingActions()
	const [editingCap, setEditingCap] = useState<SpendFeatureId | null>(null)
	const [savingCap, setSavingCap] = useState(false)
	const usageRef = useRef<HTMLDivElement>(null)
	const checkoutReturn = useCheckoutReturn()

	const customer = Result.isSuccess(customerResult) ? customerResult.value : undefined
	const plans = Result.isSuccess(plansResult) ? plansResult.value.plans : undefined
	const usageTotal = Result.isSuccess(usageResult) ? usageResult.value.total : undefined
	const daily = Result.isSuccess(dailySpendResult) ? dailySpendResult.value : undefined

	// The model also needs the plan catalog (base price and overage rates);
	// without it a legacy-looking partial estimate would flash during load.
	const isLoading =
		Result.isInitial(customerResult) || Result.isInitial(usageResult) || Result.isInitial(plansResult)

	const trial = getTrialStatus(customer)
	const { isLegacy } = getLegacyPlanInfo(customer, plans)

	const model = useMemo(
		() => buildSpendModel({ customer, plans, usage: usageTotal, nowMs: Date.now() }),
		[customer, plans, usageTotal],
	)
	const maximumInvoice = maximumInvoiceCents(model, customer)
	const uncapped = model === null ? [] : uncappedFeatures(model, customer)
	const manageBilling = () => openCustomerPortal({ returnUrl: window.location.href })

	const setCaps = () => {
		if (savingCap) return
		setEditingCap(uncapped[0]?.featureId ?? null)
		usageRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
	}

	const billingDetails = <BillingDetailsSection canEdit={isAdmin} />
	const invoices = <InvoicesSection canManageBilling={isAdmin} onManageBilling={manageBilling} />

	// Every spend view is derived from the customer, so a failed read would otherwise
	// leave them all on skeletons forever. Details and invoices load on their own.
	if (Result.isFailure(customerResult)) {
		return (
			<SettingsSections>
				<AdminOnlyNotice subject="billing" />
				<ErrorState
					variant="row"
					error={customerResult.cause}
					title="Couldn't load your billing account"
					onRetry={refreshCustomer}
				/>
				{billingDetails}
				{invoices}
			</SettingsSections>
		)
	}

	return (
		<SettingsSections>
			{checkoutReturn === "confirming" && <CheckoutConfirmingPanel layout="row" />}
			{checkoutReturn === "timed_out" && (
				<CheckoutTimedOutNotice pickPlan="use Compare plans under Plan" />
			)}
			<AdminOnlyNotice subject="billing" />

			<SettingsSection
				title="This cycle"
				description="Estimated spend for the current billing period."
				framed={false}
				actions={
					isAdmin ? (
						<Button variant="outline" size="sm" onClick={manageBilling}>
							Manage billing
						</Button>
					) : undefined
				}
			>
				{isLoading || model === null ? (
					<BillingCyclePanelSkeleton />
				) : (
					<BillingCyclePanel
						model={model}
						trial={trial}
						isLegacy={isLegacy}
						maximumInvoiceCents={maximumInvoice}
						uncappedCount={uncapped.length}
						onSetCaps={isAdmin ? setCaps : undefined}
						setCapsDisabled={savingCap}
						chart={
							Result.isInitial(dailySpendResult) ? (
								<SpendChartSkeleton />
							) : Result.isFailure(dailySpendResult) ? (
								<SpendChartError error={dailySpendResult.cause} onRetry={refreshDailySpend} />
							) : (
								<SpendChart model={model} daily={daily} />
							)
						}
					/>
				)}
			</SettingsSection>

			<div ref={usageRef} className="scroll-mt-6">
				<SettingsSection
					title="Usage"
					description="Included usage resets each cycle. A cap limits paid overage for one feature; once it is reached, new data for that feature is rejected until the cycle resets or the cap is raised."
					framed={false}
				>
					{isLoading || model === null || customer === undefined ? (
						<BillingUsageTableSkeleton />
					) : (
						<BillingUsageTable
							model={model}
							customer={customer}
							canEdit={isAdmin}
							editing={editingCap}
							onEditingChange={setEditingCap}
							saving={savingCap}
							onSavingChange={setSavingCap}
						/>
					)}
				</SettingsSection>
			</div>

			<BillingPlanSection
				model={isLoading ? null : model}
				plans={Result.isFailure(plansResult) ? [] : plans}
				isLegacy={isLegacy}
				// Back from Stripe with the plan not yet synced: never re-offer the plan just bought.
				canManage={isAdmin && checkoutReturn !== "confirming"}
			/>

			{invoices}

			{billingDetails}
		</SettingsSections>
	)
}
