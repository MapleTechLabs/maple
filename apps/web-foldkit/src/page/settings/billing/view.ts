import type { BillingCustomer } from "@maple/domain/http"
import { maximumInvoiceCents, uncappedFeatures } from "@maple/web/lib/billing/controls"
import { getLegacyPlanInfo, getTrialStatus } from "@maple/web/lib/billing/plan-gating"
import { AsyncData, Submodel } from "foldkit"
import type { LoadFailure } from "../../../data/load-failure"
import { button } from "../../../ui/button"
import { errorState } from "../../../ui/error-state"
import { adminOnlyNotice } from "../kit/members"
import { settingsSection, settingsSections } from "../kit/section"
import { Message, type Model } from "./model"
import { spendModelOf, USAGE_HEADING_ID } from "./update"
import { cyclePanel, cyclePanelSkeleton } from "./view-cycle"
import { planSection } from "./view-plan"
import { detailsSection, invoicesSection } from "./view-records"
import { usageTable, usageTableSkeleton } from "./view-usage"

export type ViewInputs = Readonly<{
	/** The settings page's `billingCustomerAtom`. */
	customer: AsyncData.AsyncData<BillingCustomer, LoadFailure>
	adminName: string | null
	nowMs: number
	timeZone: string
}>

/** Billing, spend-first: this cycle, its usage and caps, the plan, invoices and details. */
export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) => {
	const notice = adminOnlyNotice(h, { isAdmin: model.isAdmin, subject: "billing", adminName: inputs.adminName })
	// Every spend view derives from the customer; details and invoices load on their own.
	if (AsyncData.isFailure(inputs.customer))
		return settingsSections(h, "standard", [
			...notice,
			...AsyncData.matchDataSplitEmpty(inputs.customer, {
				onIdle: () => [],
				onLoading: () => [],
				onData: () => [],
				onFailure: (failure) => [
					errorState(h, {
						variant: "row",
						failure,
						title: "Couldn't load your billing account",
						onRetry: Message.ClickedRetryCustomer(),
					}),
				],
			}),
			detailsSection(h, model),
			invoicesSection(h, model, inputs.timeZone),
		])
	const customer = AsyncData.getOrElse(inputs.customer, () => null)
	const plans = AsyncData.getOrElse(model.plans, () => undefined)
	const isLoading = customer === null || AsyncData.isLoading(model.usage) || AsyncData.isLoading(model.plans)
	const spend = spendModelOf(model, customer, inputs.nowMs)
	const trial = getTrialStatus(customer ?? undefined)
	const { isLegacy } = getLegacyPlanInfo(customer ?? undefined, plans)
	const uncapped = spend === null ? [] : uncappedFeatures(spend, customer ?? undefined)
	return settingsSections(h, "standard", [
		...notice,
		settingsSection(
			h,
			{
				id: "settings-billing-cycle",
				title: "This cycle",
				description: ["Estimated spend for the current billing period."],
				framed: false,
				...(model.isAdmin && {
					actions: button(
						h,
						{ variant: "outline", size: "sm", attributes: [h.OnClick(Message.ClickedManageBilling())] },
						["Manage billing"],
					),
				}),
			},
			[
				isLoading || spend === null
					? cyclePanelSkeleton(h)
					: cyclePanel(h, model, {
							spend,
							trial,
							isLegacy,
							maximumInvoiceCents: maximumInvoiceCents(spend, customer ?? undefined),
							uncappedCount: uncapped.length,
							timeZone: inputs.timeZone,
						}),
			],
		),
		h.div(
			[h.Class("scroll-mt-6")],
			[
				settingsSection(
					h,
					{
						id: USAGE_HEADING_ID,
						title: "Usage",
						description: [
							"Included usage resets each cycle. A cap limits paid overage for one feature; once it is reached, new data for that feature is rejected until the cycle resets or the cap is raised.",
						],
						framed: false,
					},
					[isLoading || spend === null || customer === null ? usageTableSkeleton(h) : usageTable(h, model, spend, customer)],
				),
			],
		),
		planSection(h, model, { spend: isLoading ? null : spend, customer, isLegacy, canManage: model.isAdmin }),
		invoicesSection(h, model, inputs.timeZone),
		detailsSection(h, model),
	])
})
