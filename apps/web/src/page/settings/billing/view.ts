import type { BillingCustomer } from "@maple/domain/http"
import { maximumInvoiceCents, uncappedFeatures } from "../../../lib/billing/controls"
import { getLegacyPlanInfo, getTrialStatus } from "../../../lib/billing/plan-gating"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { LoadFailure } from "../../../data/load-failure"
import { button } from "../../../ui/button"
import { errorState } from "../../../ui/error-state"
import { panel } from "../../../ui/panel"
import { spinner } from "../../../ui/spinner"
import { adminOnlyNotice } from "../kit/members"
import { settingsSection, settingsSections } from "../kit/section"
import { Message, type Model } from "./model"
import { accountOf, spendModelOf, USAGE_HEADING_ID } from "./update"
import { accountDialogs, billedOrgsSection, linkSection, memberSection } from "./view-account"
import { cyclePanel, cyclePanelSkeleton } from "./view-cycle"
import { planSection } from "./view-plan"
import { detailsSection, invoicesSection, unpaidInvoicesNotice } from "./view-records"
import { usageTable, usageTableSkeleton } from "./view-usage"

export type ViewInputs = Readonly<{
	/** The settings page's `billingCustomerAtom`. */
	customer: AsyncData.AsyncData<BillingCustomer, LoadFailure>
	adminName: string | null
	/** The session says the viewer is a member; the admin-only notice shows only then. */
	isKnownMember: boolean
	nowMs: number
	timeZone: string
}>

/** Billing, spend-first: this cycle, its usage and caps, the plan, invoices and details. */
export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) => {
	const notice = adminOnlyNotice(h, {
		isKnownMember: inputs.isKnownMember && !model.isAdmin,
		subject: "billing",
		adminName: inputs.adminName,
	})
	const account = accountOf(model)
	if (AsyncData.isFailure(model.account))
		return settingsSections(h, [
			errorState(h, {
				variant: "row",
				failure: model.account.error,
				title: "Couldn't load your billing account",
				onRetry: Message.ClickedRetryAccount(),
			}),
		])
	// Until the account says who pays, nothing renders a control a member org would be refused.
	if (account === null) return settingsSections(h, [cyclePanelSkeleton(h)])
	// A member org's plan, caps and invoices are its billing org's: only who pays shows here.
	if (account !== null && account.role === "member")
		return settingsSections(h, [memberSection(h, model, account), ...accountDialogs(h, model, account)])
	// Every spend view derives from the customer; details and invoices load on their own.
	const accountFailure = accountFailureOf(model, inputs.customer)
	if (accountFailure !== null)
		return settingsSections(h, [
			...notice,
			errorState(h, {
				variant: "row",
				failure: accountFailure,
				title: "Couldn't load your billing account",
				onRetry: Message.ClickedRetryCustomer(),
			}),
			detailsSection(h, model),
			invoicesSection(h, model, inputs.timeZone),
			...accountDialogs(h, model, account),
		])
	const customer = AsyncData.getOrElse(inputs.customer, () => null)
	const plans = AsyncData.getOrElse(model.plans, () => undefined)
	const isLoading =
		customer === null || AsyncData.isLoading(model.usage) || AsyncData.isLoading(model.plans)
	const spend = spendModelOf(model, customer, inputs.nowMs)
	const trial = getTrialStatus(customer ?? undefined)
	const { isLegacy } = getLegacyPlanInfo(customer ?? undefined, plans)
	const uncapped = spend === null ? [] : uncappedFeatures(spend, customer ?? undefined)
	return settingsSections(h, [
		...checkoutReturnPanel(h, model),
		...unpaidInvoicesNotice(h, model, inputs.timeZone),
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
						{
							variant: "outline",
							size: "sm",
							attributes: [h.OnClick(Message.ClickedManageBilling())],
						},
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
					[
						isLoading || spend === null || customer === null
							? usageTableSkeleton(h)
							: usageTable(h, model, spend, customer),
					],
				),
			],
		),
		planSection(h, model, {
			spend: isLoading ? null : spend,
			customer,
			isLegacy,
			canManage: model.isAdmin,
		}),
		...(account !== null && account.role === "billing_org" && account.members.length > 0
			? [billedOrgsSection(h, model, account, inputs.timeZone)]
			: []),
		invoicesSection(h, model, inputs.timeZone),
		detailsSection(h, model),
		...(account !== null && account.role === "standalone" ? linkSection(h, model) : []),
		...accountDialogs(h, model, account),
	])
})

type H = HtmlBuilder<Message>

/** The customer, usage or plans failed: every spend view derives from all three, so none can resolve. */
const accountFailureOf = (
	model: Model,
	customer: AsyncData.AsyncData<BillingCustomer, LoadFailure>,
): LoadFailure | null => {
	if (AsyncData.isFailure(customer)) return customer.error
	if (AsyncData.isFailure(model.usage)) return model.usage.error
	if (AsyncData.isFailure(model.plans)) return model.plans.error
	return null
}

/** `CheckoutConfirmingPanel layout="row"` and `CheckoutTimedOutNotice` above the tab. */
const checkoutReturnPanel = (h: H, model: Model): ReadonlyArray<Html> => {
	switch (model.checkoutReturn) {
		case "Idle":
			return []
		case "Confirming":
			return [
				panel(
					h,
					{
						className: "flex-row items-center gap-3 px-4 py-3",
						attributes: [h.Role("status"), h.AriaLive("polite")],
					},
					[
						spinner(h, "size-4 shrink-0"),
						h.p(
							[h.Class("text-sm")],
							[
								"Confirming your subscription.",
								" ",
								h.span(
									[h.Class("text-muted-foreground")],
									["This usually takes a few seconds; there's nothing else to click."],
								),
							],
						),
					],
				),
			]
		case "TimedOut":
			return [
				panel(
					h,
					{
						tone: "muted",
						className: "px-4 py-3 text-sm text-muted-foreground",
						attributes: [h.Role("status")],
					},
					[
						"We haven't heard back from Stripe yet. If you completed checkout, your plan will appear here shortly; there's no need to subscribe again. If you left checkout, ",
						"use Compare plans under Plan",
						".",
					],
				),
			]
	}
}
