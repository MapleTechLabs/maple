import type { BillingCustomer } from "@maple/domain/http"
import { maximumInvoiceCents, uncappedFeatures } from "./controls"
import {
	getLegacyPlanInfo,
	getNoCardTrial,
	getTrialStatus,
	type NoCardTrial,
} from "../../kit/billing/plan-gating"
import { STARTUP_PLAN_ID, TRIAL_SIGNAL_GB } from "@maple/domain/billing"
import { formatDateInTimezone } from "@maple/ui/lib/timezone-format"
import { badge } from "@maple/views/ui/display"
import { hstack, vstack } from "@maple/views/ui/stack"
import { Array as Arr, Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { LoadFailure } from "@maple/views/data/load-failure"
import { button } from "@maple/views/ui/button"
import { errorState } from "@maple/views/ui/error-state"
import { panel } from "@maple/views/ui/panel"
import { spinner } from "@maple/views/ui/spinner"
import { adminOnlyNotice } from "../kit/members"
import { settingsSection, settingsSections } from "../../kit/settings-section"
import { canManage, Message, type Model } from "./model"
import { gatedControl } from "../../kit/session-grants"
import { accountOf, spendModelOf, USAGE_HEADING_ID } from "./update"
import { accountDialogs, billedOrgsSection, linkSection, memberSection } from "./view-account"
import { cyclePanel, cyclePanelSkeleton } from "./view-cycle"
import { planSection } from "./view-plan"
import { detailsSection, invoicesSection, unpaidInvoicesNotice } from "./view-records"
import { usageTable, usageTableSkeleton } from "./view-usage"
import { typography, typographyClass } from "@maple/views/ui/typography"

export type ViewInputs = Readonly<{
	/** The settings page's billing customer. */
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
		isKnownMember: inputs.isKnownMember && !canManage(model),
		permission: "billing:manage",
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
			invoicesSection(h, model, inputs.timeZone, inputs.nowMs),
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
	const noCardTrial = getNoCardTrial(customer, inputs.nowMs)
	return settingsSections(h, [
		...checkoutReturnPanel(h, model),
		...(noCardTrial === null || model.checkoutReturn !== "Idle"
			? []
			: [trialPanel(h, model, noCardTrial, inputs.timeZone)]),
		...unpaidInvoicesNotice(h, model, inputs.timeZone),
		...notice,
		settingsSection(
			h,
			{
				id: "settings-billing-cycle",
				title: "This cycle",
				description: ["Estimated spend for the current billing period."],
				framed: false,
				actions: gatedControl(h, model, "billing:manage", (isDisabled) =>
					button(
						h,
						{
							variant: "outline",
							size: "sm",
							isDisabled,
							attributes: isDisabled ? [] : [h.OnClick(Message.ClickedManageBilling())],
						},
						["Manage billing"],
					),
				),
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
							"Included usage resets each cycle. A cap limits paid overage for one feature; once it is reached, new data for that feature is rejected (for AI credits, AI features pause) until the cycle resets or the cap is raised.",
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
			canManage: canManage(model),
		}),
		...(account !== null && account.role === "billing_org" && account.members.length > 0
			? [billedOrgsSection(h, model, account, inputs.timeZone)]
			: []),
		invoicesSection(h, model, inputs.timeZone, inputs.nowMs),
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

/** What the card buys once the trial ends, from the catalog: "Startup is $39/month plus usage." */
const afterTrial = (model: Model): string =>
	Option.match(
		Arr.findFirst(
			AsyncData.getOrElse(model.plans, () => []),
			(plan) => plan.id === STARTUP_PLAN_ID,
		),
		{
			onNone: () => "",
			onSome: (plan) =>
				plan.price?.amount == null
					? ""
					: ` After that, ${plan.name} is $${plan.price.amount}/${plan.price.interval ?? "month"} plus usage.`,
		},
	)

/**
 * The no-card trial: when it ends, its caps, and "Add card", which buys Startup through Stripe with
 * the trial's days left (the server sets them), so nothing is charged before the trial ends.
 */
const trialPanel = (h: H, model: Model, trial: NoCardTrial, timeZone: string): Html => {
	const endsOn = formatDateInTimezone(trial.endsAt, { timeZone, withYear: false })
	return panel(h, { padded: true, className: "gap-4 sm:flex-row sm:items-center sm:justify-between" }, [
		vstack(h, { gap: "1.5", className: "max-w-xl" }, [
			hstack(h, { gap: "2", align: "center" }, [
				typography(h, { size: "sm", weight: "medium" }, ["Free trial"]),
				badge(h, { variant: "secondary", size: "xs", className: "tabular-nums" }, [
					trial.daysRemaining <= 1 ? "Last day" : `${trial.daysRemaining} days left`,
				]),
			]),
			typography(h, { size: "xs", tone: "muted", as: "p", className: "leading-relaxed" }, [
				`Logs, traces and metrics each include ${TRIAL_SIGNAL_GB} GB until ${endsOn}; ingest for a signal pauses at its cap. Add a card to lift the caps now. You won't be charged before ${endsOn}.${afterTrial(model)}`,
			]),
		]),
		vstack(h, { gap: "1.5", className: "shrink-0 sm:w-44" }, [
			gatedControl(h, model, "billing:manage", (isDisabled) =>
				button(
					h,
					{
						size: "sm",
						isDisabled,
						isLoading: model.attaching === STARTUP_PLAN_ID,
						attributes: isDisabled
							? []
							: [h.OnClick(Message.ClickedSubscribe({ planId: STARTUP_PLAN_ID }))],
					},
					["Add card"],
				),
			),
			typography(h, { size: "2xs", tone: "muted", as: "p", className: "text-center" }, [
				"$0 due today",
			]),
		]),
	])
}

/** The checkout return above the tab: still confirming (as a row), or timed out. */
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
						typography(h, { size: "sm", as: "p" }, [
							"Confirming your subscription.",
							" ",
							typography(h, { tone: "muted" }, [
								"This usually takes a few seconds; there's nothing else to click.",
							]),
						]),
					],
				),
			]
		case "TimedOut":
			return [
				panel(
					h,
					{
						tone: "muted",
						className: typographyClass({ size: "sm", tone: "muted", className: "px-4 py-3" }),
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
