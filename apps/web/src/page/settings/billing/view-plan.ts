import type { CatalogPlan } from "@maple/domain/http"
import { cn } from "@maple/ui/lib/utils"
import { getTrialStatus } from "../../../lib/billing/plan-gating"
import { getPlanFeatures, sentenceCasePlanName, TRIAL_DURATION_DAYS } from "../../../lib/billing/plans"
import { featureUnit, type SpendModel } from "../../../lib/billing/spend"
import { formatCount } from "../../../lib/billing/usage"
import type { BillingCustomer } from "@maple/domain/http"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import * as DialogView from "../../../ui/dialog-view"
import { badge } from "../../../ui/display"
import { errorState } from "../../../ui/error-state"
import { eyebrow } from "../../../ui/eyebrow"
import { icon } from "../../../ui/icon"
import { panel } from "../../../ui/panel"
import { skeleton } from "../../../ui/skeleton"
import { settingsSection } from "../kit/section"
import { Message, type Model } from "./model"

type H = HtmlBuilder<Message>

// `BillingPlanSection` and `PlanOffer` (apps/web/src/components/settings/).

const ENTERPRISE_CALL_URL = "https://cal.com/david-granzin/30min?overlayCalendar=true"
const CURRENT_PLAN_CAPTION = "Change or cancel it in Manage billing"

/** A hard-capped plan bills nothing past its allotments, so "+ usage" would be untrue. */
const billsUsage = (spend: SpendModel) =>
	spend.features.some((feature) => feature.overageAllowed !== false && feature.ratePerUnit !== null)

const priceLabel = (spend: SpendModel): { price: string; suffix: string } => {
	const plan = spend.charges.find((charge) => charge.kind === "plan")
	if (plan === undefined || plan.dollars === null) return { price: "Custom", suffix: "negotiated pricing" }
	const interval = `/${plan.interval ?? "month"}`
	return { price: `$${plan.dollars}`, suffix: billsUsage(spend) ? `${interval} + usage` : interval }
}

const perInterval = (dollars: number | null, interval: string | null | undefined): string =>
	dollars === null ? "Custom" : `$${dollars}/${interval ?? "month"}`

/** One line of the plan list: a name and caption on the left, a price and an optional action on the right. */
const planLine = (
	h: H,
	options: Readonly<{
		key: string
		name: Html | string
		caption: string
		price: Html | string
		muted?: boolean
		action?: Html
	}>,
): Html =>
	h.div(
		[
			h.Key(options.key),
			h.Class("flex flex-wrap items-center justify-between gap-x-6 gap-y-1 px-4 py-3"),
		],
		[
			h.div(
				[h.Class("flex min-w-0 flex-col gap-0.5")],
				[
					h.span(
						[
							h.Class(
								cn("text-sm font-medium", options.muted === true && "text-muted-foreground"),
							),
						],
						[options.name],
					),
					h.span([h.Class("text-2xs text-muted-foreground")], [options.caption]),
				],
			),
			h.div(
				[h.Class("flex items-center gap-4")],
				[
					h.span(
						[
							h.Class(
								cn(
									"font-mono text-sm tabular-nums",
									options.muted === true && "text-muted-foreground",
								),
							),
						],
						[options.price],
					),
					...(options.action === undefined ? [] : [options.action]),
				],
			),
		],
	)

/** The plan, then each add-on it carries with its price, then the add-ons it could take. */
const planRow = (h: H, spend: SpendModel, plans: ReadonlyArray<CatalogPlan>, canManage: boolean): Html => {
	if (spend.planName === null)
		return panel(h, { padded: true }, [
			h.p([h.Class("text-sm text-muted-foreground")], ["No active plan. Compare plans to pick one."]),
		])
	const { price, suffix } = priceLabel(spend)
	const activeIds = new Set(spend.addOns.map((addOn) => addOn.id))
	const available = plans.filter((plan) => plan.addOn === true && !activeIds.has(plan.id))
	const activeCharges = spend.charges.filter((charge) => charge.kind === "addOn")
	return panel(h, { className: "divide-y divide-border/60" }, [
		planLine(h, {
			key: "plan",
			name: sentenceCasePlanName(spend.planName),
			caption: "Base plan",
			price: h.span(
				[h.Class("flex items-baseline gap-0.5")],
				[price, h.span([h.Class("font-sans text-2xs text-muted-foreground")], [suffix])],
			),
		}),
		...activeCharges.map((charge) =>
			planLine(h, {
				key: charge.key,
				name: h.span(
					[h.Class("flex items-center gap-2")],
					[sentenceCasePlanName(charge.name), badge(h, { size: "sm", variant: "ok" }, ["Active"])],
				),
				caption: "Add-on, billed with your plan",
				price: perInterval(charge.dollars, charge.interval),
			}),
		),
		...available.map((addOn) =>
			planLine(h, {
				key: addOn.id,
				name: sentenceCasePlanName(addOn.name),
				caption: "Available add-on",
				price: `+${perInterval(addOn.price?.amount ?? null, addOn.price?.interval)}`,
				muted: true,
				...(canManage && {
					action: button(
						h,
						{ variant: "outline", size: "xs", attributes: [h.OnClick(Message.ClickedCompare())] },
						["Add"],
					),
				}),
			}),
		),
	])
}

const includedRun = (plan: CatalogPlan): string =>
	plan.items
		.flatMap((item) => {
			if (
				item.featureId === undefined ||
				item.featureId === null ||
				item.included === undefined ||
				item.included === null
			)
				return []
			if (item.featureId === "ai_credits") return [`$${formatCount(item.included)} AI usage`]
			const amount = formatCount(item.included)
			return [
				featureUnit(item.featureId) === "GB"
					? `${amount} GB ${item.featureId}`
					: `${amount} ${featureUnit(item.featureId)}`,
			]
		})
		.join(" · ")

const currentBadge = (h: H, text: string): Html =>
	badge(
		h,
		{
			variant: "muted",
			pill: true,
			size: "xs",
			mono: true,
			className: "px-2 bg-primary/15 text-primary",
		},
		[text],
	)

/** A custom-priced customer's own plan, never a catalog offer they do not pay. */
const customPlanPlate = (h: H, spend: SpendModel): Html => {
	const price = spend.basePlan?.price?.amount
	const interval = spend.basePlan?.price?.interval ?? "month"
	const hasUsage = billsUsage(spend)
	const included = spend.features
		.filter((feature) => feature.included !== null || feature.unlimited)
		.map((feature) =>
			feature.unlimited
				? `unlimited ${feature.label.toLowerCase()}`
				: `${formatCount(Number(feature.included))} ${featureUnit(feature.featureId) === "GB" ? "GB" : ""} ${feature.label.toLowerCase()}`.replace(
						/\s+/g,
						" ",
					),
		)
		.join(" · ")
	const isPriced = price !== undefined && price !== null
	return panel(
		h,
		{
			padded: true,
			className:
				"gap-6 border-primary/40 bg-primary/[0.03] lg:flex-row lg:items-start lg:justify-between",
		},
		[
			h.div(
				[h.Class("max-w-sm")],
				[
					h.div(
						[h.Class("flex items-center gap-2")],
						[
							h.span([h.Class("text-sm")], [spend.planName ?? "Your plan"]),
							currentBadge(h, "Current plan"),
						],
					),
					h.div(
						[h.Class("mt-3 flex items-baseline gap-2")],
						[
							h.span(
								[h.Class("font-mono text-3xl tabular-nums")],
								[isPriced ? `$${price}` : "Custom"],
							),
							h.span(
								[h.Class("text-2xs text-muted-foreground")],
								[
									!isPriced
										? "negotiated pricing"
										: hasUsage
											? `/${interval} + usage`
											: `/${interval}`,
								],
							),
						],
					),
					h.p(
						[h.Class("mt-3 text-2xs leading-relaxed text-muted-foreground")],
						[
							hasUsage
								? "A custom plan: your allotments and rates are your own, not the published ones."
								: "A custom plan with hard caps: usage past your allotments is rejected, never billed.",
						],
					),
				],
			),
			h.div(
				[h.Class("flex-1 lg:px-6")],
				[
					eyebrow(h, {}, ["Included every cycle"]),
					h.p(
						[h.Class("mt-2 font-mono text-2xs leading-relaxed text-foreground/85")],
						[included.length > 0 ? included : "Allotments are set on your contract."],
					),
				],
			),
			h.p(
				[h.Class("w-full shrink-0 text-2xs text-muted-foreground lg:w-44 lg:text-center")],
				[CURRENT_PLAN_CAPTION],
			),
		],
	)
}

const offerPanel = (
	h: H,
	model: Model,
	plan: CatalogPlan,
	addOns: ReadonlyArray<CatalogPlan>,
	options: Readonly<{ isCustom: boolean; trialText: string | null }>,
): Html => {
	const isActive = !options.isCustom && plan.customerEligibility?.status === "active"
	const isTrialAvailable = plan.customerEligibility?.trialAvailable === true
	const retention = getPlanFeatures(plan.id.toLowerCase()).find(
		(feature) => feature.label === "Data retention",
	)
	return panel(
		h,
		{
			padded: true,
			className: cn(
				"gap-6 lg:flex-row lg:items-start lg:justify-between",
				isActive && "border-primary/40 bg-primary/[0.03]",
			),
		},
		[
			h.div(
				[h.Class("max-w-sm")],
				[
					h.div(
						[h.Class("flex items-center gap-2")],
						[
							h.span([h.Class("text-sm")], [plan.name]),
							...(isActive ? [currentBadge(h, options.trialText ?? "Current plan")] : []),
						],
					),
					h.div(
						[h.Class("mt-3 flex items-baseline gap-2")],
						[
							h.span(
								[h.Class("font-mono text-3xl tabular-nums")],
								["$", String(plan.price?.amount ?? 0)],
							),
							h.span(
								[h.Class("text-2xs text-muted-foreground")],
								["/", plan.price?.interval ?? "month", " + usage"],
							),
						],
					),
					h.p(
						[h.Class("mt-3 text-2xs leading-relaxed text-muted-foreground")],
						["Everything in Maple. Pay per GB past what's included."],
					),
				],
			),
			h.div(
				[h.Class("flex-1 lg:px-6")],
				[
					eyebrow(h, {}, ["Included every cycle"]),
					h.p(
						[h.Class("mt-2 font-mono text-2xs leading-relaxed text-foreground/85")],
						[
							includedRun(plan),
							...(retention === undefined
								? []
								: [` · ${retention.value.toLowerCase()} retention`]),
						],
					),
					...(addOns.length > 0
						? [
								h.div(
									[h.Class("mt-3 space-y-1")],
									addOns.map((addOn) =>
										h.p(
											[h.Key(addOn.id), h.Class("text-2xs text-muted-foreground")],
											[
												addOn.customerEligibility?.status === "active"
													? "Add-on active · "
													: "Add-on available · ",
												addOn.name,
												...(addOn.price?.amount === undefined ||
												addOn.price.amount === null
													? []
													: [
															` +$${addOn.price.amount}/${addOn.price.interval ?? "month"}`,
														]),
											],
										),
									),
								),
							]
						: []),
				],
			),
			h.div(
				[h.Class("flex w-full shrink-0 flex-col gap-2 lg:w-44")],
				isActive
					? [
							h.p(
								[h.Class("text-2xs text-muted-foreground lg:text-center")],
								[CURRENT_PLAN_CAPTION],
							),
						]
					: [
							button(
								h,
								{
									size: "sm",
									isLoading: model.attaching === plan.id,
									attributes: [h.OnClick(Message.ClickedSubscribe({ planId: plan.id }))],
								},
								[
									isTrialAvailable
										? `Start ${plan.freeTrial?.durationLength ?? TRIAL_DURATION_DAYS}-day trial`
										: "Subscribe",
								],
							),
							h.p(
								[h.Class("text-center text-2xs text-muted-foreground")],
								["$0 due today · cancel anytime"],
							),
						],
			),
		],
	)
}

/** The plan picker behind "Compare plans": one offer, not a tier ladder. */
const planOffer = (
	h: H,
	model: Model,
	spend: SpendModel | null,
	customer: BillingCustomer | null,
): ReadonlyArray<Html> => {
	const { isTrialing, daysRemaining } = getTrialStatus(customer ?? undefined)
	const trialText = isTrialing && daysRemaining !== null ? `Trial · ${daysRemaining}d left` : null
	return AsyncData.matchDataSplitEmpty(model.plans, {
		onIdle: () => [
			h.div(
				[h.Class("space-y-3")],
				[skeleton(h, "h-32 w-full rounded-md"), skeleton(h, "h-16 w-full rounded-md")],
			),
		],
		onLoading: () => [
			h.div(
				[h.Class("space-y-3")],
				[skeleton(h, "h-32 w-full rounded-md"), skeleton(h, "h-16 w-full rounded-md")],
			),
		],
		onFailure: (failure) => [
			errorState(h, { failure, title: "Unable to load pricing plans", variant: "row" }),
		],
		onData: (plans) => {
			const offers = plans.filter((plan) => plan.addOn !== true && plan.autoEnable !== true)
			const addOns = plans.filter((plan) => plan.addOn === true)
			const isCustom = spend?.isCustomPlan === true && spend.planName !== null
			return [
				h.div(
					[h.Class("space-y-3")],
					[
						...(isCustom && spend !== null ? [customPlanPlate(h, spend)] : []),
						...offers.map((plan) => offerPanel(h, model, plan, addOns, { isCustom, trialText })),
					],
				),
			]
		},
	})
}

const compareDialog = (
	h: H,
	model: Model,
	spend: SpendModel | null,
	customer: BillingCustomer | null,
): Html =>
	h.submodel({
		slotId: "billing-compare",
		model: model.compareDialog,
		view: DialogView.view,
		toParentMessage: (message) => Message.GotCompareDialogMessage({ message }),
		viewInputs: {
			hasTrigger: false,
			className: "max-w-4xl",
			toView: ({ portal }) => portal ?? h.empty,
			toContent: () => [
				DialogView.dialogHeader(h, "dialog", [
					DialogView.dialogTitle(h, "dialog", model.compareDialog.id, "Compare plans"),
					DialogView.dialogDescription(
						h,
						"dialog",
						model.compareDialog.id,
						"Plans and add-ons you can switch to.",
					),
				]),
				DialogView.dialogPanel(h, "dialog", model.compareDialog.id, [
					...planOffer(h, model, spend, customer),
				]),
			],
		},
	})

/** The current plan as one row, the picker one click away, Enterprise as one muted line. */
export const planSection = (
	h: H,
	model: Model,
	options: Readonly<{
		spend: SpendModel | null
		customer: BillingCustomer | null
		isLegacy: boolean
		canManage: boolean
	}>,
): Html => {
	const plans = AsyncData.getOrElse(model.plans, () => undefined)
	const visiblePlans = AsyncData.isFailure(model.plans) ? [] : plans
	return settingsSection(
		h,
		{
			id: "settings-billing-plan",
			title: "Plan",
			description: ["What you pay for every cycle before usage: your plan and its add-ons."],
			framed: false,
			...(options.canManage && {
				actions: button(
					h,
					{
						variant: "link",
						size: "sm",
						className: "text-primary",
						attributes: [h.OnClick(Message.ClickedCompare())],
					},
					[
						"Compare plans",
						icon(h, "ArrowRightIcon", { className: "size-3", attributes: [h.AriaHidden(true)] }),
					],
				),
			}),
		},
		[
			options.spend === null || visiblePlans === undefined
				? skeleton(h, "h-12 w-full rounded-md")
				: planRow(h, options.spend, visiblePlans, options.canManage),
			...(options.isLegacy
				? [
						h.p(
							[h.Class("px-1 text-xs text-muted-foreground")],
							[
								"You're on a legacy plan that's no longer offered. Compare plans for current pricing and features.",
							],
						),
					]
				: []),
			h.p(
				[h.Class("px-1 text-xs text-muted-foreground")],
				[
					"Enterprise adds higher volume, custom retention and priority support, from $2,000.",
					" ",
					h.a(
						[
							h.Class(
								"font-medium whitespace-nowrap text-foreground underline underline-offset-4",
							),
							h.Href(ENTERPRISE_CALL_URL),
							h.Rel("noopener noreferrer"),
							h.Target("_blank"),
						],
						["Talk to the founder"],
					),
				],
			),
			...(options.canManage ? [compareDialog(h, model, options.spend, options.customer)] : []),
		],
	)
}
