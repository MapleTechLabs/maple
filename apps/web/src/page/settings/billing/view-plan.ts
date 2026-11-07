import { isPricingCardFeature } from "@maple/domain/billing"
import type { CatalogPlan } from "@maple/domain/http"
import { cn } from "@maple/ui/lib/utils"
import { getTrialStatus } from "../../../lib/billing/plan-gating"
import { getPlanFeatures, sentenceCasePlanName, TRIAL_DURATION_DAYS } from "../../../lib/billing/plans"
import { featureUnit, type SpendModel } from "../../../lib/billing/spend"
import { formatCount } from "../../../lib/billing/usage"
import type { BillingCustomer } from "@maple/domain/http"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import * as DialogView from "@maple/views/ui/dialog-view"
import { badge } from "@maple/views/ui/display"
import { errorState } from "@maple/views/ui/error-state"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { icon } from "@maple/views/ui/icon"
import { panel } from "@maple/views/ui/panel"
import { skeleton, skeletonBlock } from "@maple/views/ui/skeleton"
import { settingsSection } from "../kit/section"
import { compliance } from "../../kit/compliance-line"
import { Message, type Model } from "./model"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { hstack, vstack } from "@maple/views/ui/stack"
import { Array as Arr, String as Str, Option } from "effect"
import { textLink } from "@maple/views/ui/text-link"

type H = HtmlBuilder<Message>

// `BillingPlanSection` and `PlanOffer` (apps/web/src/components/settings/).

const ENTERPRISE_CALL_URL = "https://cal.com/david-granzin/30min?overlayCalendar=true"
const CURRENT_PLAN_CAPTION = "Change or cancel it in Manage billing"

/** A hard-capped plan bills nothing past its allotments, so "+ usage" would be untrue. */
const billsUsage = (spend: SpendModel) =>
	Arr.some(spend.features, (feature) => feature.overageAllowed !== false && feature.ratePerUnit !== null)

const priceLabel = (spend: SpendModel): { price: string; suffix: string } => {
	const found = Arr.findFirst(spend.charges, (charge) => charge.kind === "plan")
	if (Option.isNone(found) || found.value.dollars === null)
		return { price: "Custom", suffix: "negotiated pricing" }
	const plan = found.value
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
	hstack(
		h,
		{
			align: "center",
			justify: "between",
			wrap: true,
			className: "gap-x-6 gap-y-1 px-4 py-3",
			attributes: [h.Key(options.key)],
		},
		[
			vstack(h, { gap: "0.5", shrink: true }, [
				h.span(
					[
						h.Class(
							cn(
								typographyClass({ size: "sm", weight: "medium" }),
								options.muted === true && "text-muted-foreground",
							),
						),
					],
					[options.name],
				),
				typography(h, { size: "2xs", tone: "muted" }, [options.caption]),
			]),
			hstack(h, { gap: "4" }, [
				h.span(
					[
						h.Class(
							cn(
								typographyClass({ size: "sm", mono: true, numeric: true }),
								options.muted === true && "text-muted-foreground",
							),
						),
					],
					[options.price],
				),
				...(options.action === undefined ? [] : [options.action]),
			]),
		],
	)

/** The plan, then each add-on it carries with its price, then the add-ons it could take. */
const planRow = (h: H, spend: SpendModel, plans: ReadonlyArray<CatalogPlan>, canManage: boolean): Html => {
	if (spend.planName === null)
		return panel(h, { padded: true }, [
			typography(h, { size: "sm", tone: "muted", as: "p" }, [
				"No active plan. Compare plans to pick one.",
			]),
		])
	const { price, suffix } = priceLabel(spend)
	const activeIds = new Set(Arr.map(spend.addOns, (addOn) => addOn.id))
	const available = Arr.filter(plans, (plan) => plan.addOn === true && !activeIds.has(plan.id))
	const activeCharges = Arr.filter(spend.charges, (charge) => charge.kind === "addOn")
	return panel(h, { className: "divide-y divide-border-subtle" }, [
		planLine(h, {
			key: "plan",
			name: sentenceCasePlanName(spend.planName),
			caption: "Base plan",
			price: hstack(h, { gap: "0.5", align: "baseline", as: "span" }, [
				price,
				h.span([h.Class("font-sans text-2xs text-muted-foreground")], [suffix]),
			]),
		}),
		...Arr.map(activeCharges, (charge) =>
			planLine(h, {
				key: charge.key,
				name: hstack(h, { gap: "2", as: "span" }, [
					sentenceCasePlanName(charge.name),
					badge(h, { size: "sm", variant: "ok" }, ["Active"]),
				]),
				caption: "Add-on, billed with your plan",
				price: perInterval(charge.dollars, charge.interval),
			}),
		),
		...Arr.map(available, (addOn) =>
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
	Arr.join(
		Arr.flatMap(plan.items, (item) => {
			if (
				!isPricingCardFeature(item.featureId) ||
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
		}),
		" · ",
	)

const currentBadge = (h: H, text: string): Html =>
	badge(
		h,
		{
			variant: "muted",
			pill: true,
			size: "xs",
			mono: true,
			className: "px-2 bg-primary-a2 text-primary",
		},
		[text],
	)

/** A custom-priced customer's own plan, never a catalog offer they do not pay. */
const customPlanPlate = (h: H, spend: SpendModel): Html => {
	const price = spend.basePlan?.price?.amount
	const interval = spend.basePlan?.price?.interval ?? "month"
	const hasUsage = billsUsage(spend)
	const included = Arr.join(
		Arr.map(
			Arr.filter(spend.features, (feature) => feature.included !== null || feature.unlimited === true),
			(feature) =>
				feature.unlimited
					? `unlimited ${Str.toLowerCase(feature.label)}`
					: Str.replace(
							/\s+/g,
							" ",
						)(
							`${formatCount(Number(feature.included))} ${featureUnit(feature.featureId) === "GB" ? "GB" : ""} ${Str.toLowerCase(feature.label)}`,
						),
		),
		" · ",
	)
	const isPriced = price !== undefined && price !== null
	return panel(
		h,
		{
			padded: true,
			className:
				"gap-6 border-primary-a4 bg-primary/[0.03] lg:flex-row lg:items-start lg:justify-between",
		},
		[
			h.div(
				[h.Class("max-w-sm")],
				[
					hstack(h, { gap: "2" }, [
						typography(h, { size: "sm" }, [spend.planName ?? "Your plan"]),
						currentBadge(h, "Current plan"),
					]),
					hstack(h, { gap: "2", align: "baseline", className: "mt-3" }, [
						h.span(
							[h.Class("font-mono text-3xl font-semibold tabular-nums")],
							[isPriced ? `$${price}` : "Custom"],
						),
						typography(h, { size: "2xs", tone: "muted" }, [
							!isPriced
								? "negotiated pricing"
								: hasUsage
									? `/${interval} + usage`
									: `/${interval}`,
						]),
					]),
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
						[h.Class("mt-2 font-mono text-2xs leading-relaxed text-foreground-soft")],
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
	const retention = Option.getOrUndefined(
		Arr.findFirst(
			getPlanFeatures(Str.toLowerCase(plan.id)),
			(feature) => feature.label === "Data retention",
		),
	)
	return panel(
		h,
		{
			padded: true,
			className: cn(
				"gap-6 lg:flex-row lg:items-start lg:justify-between",
				isActive && "border-primary-a4 bg-primary/[0.03]",
			),
		},
		[
			h.div(
				[h.Class("max-w-sm")],
				[
					hstack(h, { gap: "2" }, [
						typography(h, { size: "sm" }, [plan.name]),
						...(isActive ? [currentBadge(h, options.trialText ?? "Current plan")] : []),
					]),
					hstack(h, { gap: "2", align: "baseline", className: "mt-3" }, [
						h.span(
							[h.Class("font-mono text-3xl font-semibold tabular-nums")],
							["$", String(plan.price?.amount ?? 0)],
						),
						typography(h, { size: "2xs", tone: "muted" }, [
							"/",
							plan.price?.interval ?? "month",
							" + usage",
						]),
					]),
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
						[h.Class("mt-2 font-mono text-2xs leading-relaxed text-foreground-soft")],
						[
							includedRun(plan),
							...(retention === undefined
								? []
								: [` · ${Str.toLowerCase(retention.value)} retention`]),
						],
					),
					...(addOns.length > 0
						? [
								h.div(
									[h.Class("mt-3 space-y-1")],
									Arr.map(addOns, (addOn) =>
										typography(
											h,
											{
												size: "2xs",
												tone: "muted",
												as: "p",
												attributes: [h.Key(addOn.id)],
											},
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
			vstack(
				h,
				{ gap: "2", className: "w-full shrink-0 lg:w-44" },
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
				[skeletonBlock(h, { height: "32" }), skeletonBlock(h, { height: "16" })],
			),
		],
		onLoading: () => [
			h.div(
				[h.Class("space-y-3")],
				[skeletonBlock(h, { height: "32" }), skeletonBlock(h, { height: "16" })],
			),
		],
		onFailure: (failure) => [
			errorState(h, { failure, title: "Unable to load pricing plans", variant: "row" }),
		],
		onData: (plans) => {
			const offers = Arr.filter(plans, (plan) => plan.addOn !== true && plan.autoEnable !== true)
			const addOns = Arr.filter(plans, (plan) => plan.addOn === true)
			const isCustom = spend?.isCustomPlan === true && spend.planName !== null
			return [
				h.div(
					[h.Class("space-y-3")],
					[
						...(isCustom && spend !== null ? [customPlanPlate(h, spend)] : []),
						...Arr.map(offers, (plan) =>
							offerPanel(h, model, plan, addOns, { isCustom, trialText }),
						),
						compliance(h),
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
						icon(h, "ArrowRightIcon", {
							className: "size-3.5",
							attributes: [h.AriaHidden(true)],
						}),
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
							[h.Class(typographyClass({ size: "xs", tone: "muted", className: "px-1" }))],
							[
								"You're on a legacy plan that's no longer offered. Compare plans for current pricing and features.",
							],
						),
					]
				: []),
			h.p(
				[h.Class(typographyClass({ size: "xs", tone: "muted", className: "px-1" }))],
				[
					"Enterprise adds higher volume, custom retention and priority support, from $2,000.",
					" ",
					textLink(
						h,
						{
							href: ENTERPRISE_CALL_URL,
							tone: "inherit",
							className:
								"inline font-medium whitespace-nowrap text-foreground underline underline-offset-4",
							attributes: [h.Rel("noopener noreferrer"), h.Target("_blank")],
						},
						["Talk to the founder"],
					),
				],
			),
			...(options.canManage ? [compareDialog(h, model, options.spend, options.customer)] : []),
		],
	)
}
