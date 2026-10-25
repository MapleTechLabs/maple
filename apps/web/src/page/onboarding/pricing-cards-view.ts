import type { CatalogPlan } from "@maple/domain/http"
import { getPlanDescription, getPlanFeatures, TRIAL_DURATION_DAYS } from "../../lib/billing/plans"
import { cn } from "@maple/ui/lib/utils"
import { eyebrowVariants } from "@maple/ui/styles/ui/eyebrow"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../ui/button"
import { card, cardDescription, cardFooter, cardHeader, cardPanel, cardTitle } from "../../ui/card"
import { badge, separator } from "../../ui/display"
import { errorState } from "../../ui/error-state"
import { eyebrow } from "../../ui/eyebrow"
import { icon } from "../../ui/icon"
import { skeleton } from "../../ui/skeleton"
import { panel } from "../../ui/panel"
import { spinner } from "../../ui/spinner"
import { Message, type Model } from "./pricing-cards"
import {
	ENTERPRISE_DATA_FEATURES,
	FEATURE_ICONS,
	type FeatureRow,
	getButtonConfig,
	getFeatureRows,
	getPlanPrice,
	getPlanSlug,
	getScenario,
	PLATFORM_FEATURE_ICONS,
} from "./pricing-plans"

type H = HtmlBuilder<Message>

const loadingCard = (h: H): Html =>
	card(h, [
		cardHeader(h, [skeleton(h, "h-3 w-16"), skeleton(h, "mt-2 h-7 w-24"), skeleton(h, "mt-1 h-3 w-32")]),
		cardPanel(
			h,
			[
				skeleton(h, "h-3 w-20"),
				...Array.from({ length: 3 }, () => skeleton(h, "h-4 w-full")),
				skeleton(h, "mt-2 h-px w-full"),
				skeleton(h, "h-3 w-24"),
				...Array.from({ length: 6 }, () => skeleton(h, "h-3.5 w-full")),
			],
			"space-y-3",
		),
		cardFooter(h, [skeleton(h, "h-8 w-full")]),
	])

const dataRow = (h: H, feature: FeatureRow, isDetailed: boolean): Html => {
	const iconName = FEATURE_ICONS.get(feature.featureId)
	const value = h.span([h.Class("font-semibold tabular-nums text-foreground")], [feature.value])
	return h.div(
		[h.Class("flex items-center justify-between text-sm")],
		[
			h.div(
				[h.Class("text-muted-foreground flex items-center gap-2.5")],
				[
					...(iconName === undefined
						? []
						: [icon(h, iconName, { className: "size-4 opacity-70" })]),
					h.span([h.Class("font-medium")], [feature.label]),
				],
			),
			isDetailed
				? h.div(
						[h.Class("text-right")],
						[
							value,
							...(feature.detail === null
								? []
								: [
										h.p(
											[h.Class("text-muted-foreground/70 text-3xs mt-0.5 font-medium")],
											[feature.detail],
										),
									]),
						],
					)
				: value,
		],
	)
}

const platformFeatures = (h: H, slug: string): Html =>
	h.div(
		[],
		[
			eyebrow(h, { className: "mb-3", as: "div" }, ["Platform features"]),
			h.div(
				[h.Class("space-y-2.5")],
				getPlanFeatures(slug).map((feature) =>
					h.div(
						[h.Class("flex items-start gap-2.5 text-sm")],
						[
							icon(h, PLATFORM_FEATURE_ICONS.get(feature.icon) ?? "CircleCheckIcon", {
								className: "text-muted-foreground opacity-70 size-4 shrink-0 mt-0.5",
							}),
							h.span([h.Class("text-muted-foreground leading-snug")], [feature.label]),
							...(feature.value
								? [
										h.span(
											[h.Class("font-semibold tabular-nums text-xs ml-auto shrink-0")],
											[feature.value],
										),
									]
								: []),
						],
					),
				),
			),
		],
	)

/** One plan's card; trial and status badges for an active plan are the settings page's concern. */
const planCard = (h: H, plan: CatalogPlan, loadingPlanId: string | null): Html => {
	const scenario = getScenario(plan)
	const isActive = scenario === "active"
	const isUpgrade = !isActive && scenario === "upgrade"
	const { price, interval } = getPlanPrice(plan)
	const features = getFeatureRows(plan)
	const config = getButtonConfig(plan)
	const isTrial = plan.customerEligibility?.trialAvailable === true && !config.isDisabled
	return card(
		h,
		[
			cardHeader(h, [
				h.div(
					[h.Class("flex items-center justify-between gap-2")],
					[
						cardTitle(h, [plan.name], cn(eyebrowVariants(), isUpgrade && "text-primary")),
						...(isActive
							? [badge(h, { variant: "secondary", size: "xs" }, ["Current"])]
							: isUpgrade
								? [
										badge(
											h,
											{ variant: "secondary", size: "xs", className: "text-primary" },
											["Recommended"],
										),
									]
								: []),
					],
				),
				h.div(
					[h.Class("mt-3 flex items-baseline gap-1")],
					[
						h.span([h.Class("text-3xl font-semibold tracking-tight tabular-nums")], [price]),
						...(interval === undefined
							? []
							: [eyebrow(h, { variant: "label", className: "ml-1" }, [interval])]),
					],
				),
				cardDescription(
					h,
					[plan.description ?? getPlanDescription(getPlanSlug(plan))],
					"mt-2 font-display text-sm leading-relaxed text-muted-foreground",
				),
			]),
			cardPanel(
				h,
				[
					...(features.length > 0 ? [dataIncluded(h, features, true)] : []),
					separator(h, "horizontal", "bg-border/60"),
					platformFeatures(h, getPlanSlug(plan)),
				],
				"flex flex-col gap-5 flex-1",
			),
			cardFooter(
				h,
				[
					button(
						h,
						{
							variant: isTrial ? "default" : config.variant,
							isLoading: loadingPlanId === plan.id,
							isDisabled: config.isDisabled,
							className: "w-full font-medium",
							attributes: [h.OnClick(Message.ClickedPlan({ planId: plan.id }))],
						},
						[
							isTrial
								? `Start ${plan.freeTrial?.durationLength ?? TRIAL_DURATION_DAYS}-day trial`
								: config.label,
						],
					),
					...(isTrial
						? [
								h.p(
									[h.Class("text-2xs text-muted-foreground text-center tabular-nums")],
									["$0 due today · Card required · Cancel anytime"],
								),
							]
						: []),
				],
				"mt-auto flex-col gap-2 items-stretch",
			),
		],
		cn(
			"flex flex-col transition-colors",
			isActive && "bg-muted/40",
			isUpgrade && "bg-muted/30 ring-1 ring-primary/30",
		),
	)
}

/** Enterprise as a peer card, so the grid stays balanced. */
const enterpriseCard = (h: H): Html =>
	card(
		h,
		[
			cardHeader(h, [
				h.div(
					[h.Class("flex items-center justify-between gap-2")],
					[cardTitle(h, ["Enterprise"], eyebrowVariants({ className: "text-primary" }))],
				),
				h.div(
					[h.Class("mt-3 flex items-baseline gap-1")],
					[h.span([h.Class("text-3xl font-semibold tracking-tight tabular-nums")], ["Custom"])],
				),
				cardDescription(
					h,
					["For high-volume teams with custom retention, compliance, and dedicated support."],
					"mt-2 font-display text-sm leading-relaxed text-muted-foreground",
				),
			]),
			cardPanel(
				h,
				[
					dataIncluded(h, ENTERPRISE_DATA_FEATURES, false),
					separator(h, "horizontal", "bg-border/60"),
					platformFeatures(h, "enterprise"),
				],
				"flex flex-col gap-5 flex-1",
			),
			cardFooter(
				h,
				[
					button(
						h,
						{
							variant: "outline",
							className: "w-full font-medium",
							attributes: [h.OnClick(Message.ClickedEnterpriseContact())],
						},
						["Talk to founder"],
					),
				],
				"mt-auto flex-col gap-2 items-stretch",
			),
		],
		"flex flex-col border-primary/20 bg-primary/[0.02]",
	)

/** `PricingCards`: skeletons while the catalog loads, its error row, or the plan grid. */
export const view = Submodel.defineView<Model, Message>((model, h) =>
	model.checkoutReturn === "Confirming"
		? checkoutConfirming(h)
		: AsyncData.match(model.plans, {
				onIdle: () => loadingGrid(h),
				onLoading: () => loadingGrid(h),
				onRefreshing: (response) => plansGrid(h, response.plans, model),
				onStale: ({ data }) => plansGrid(h, data.plans, model),
				onSuccess: (response) => plansGrid(h, response.plans, model),
				onFailure: (message) =>
					errorState(h, {
						title: "Unable to load pricing plans",
						failure: message,
						variant: "row",
					}),
			}),
)

/** `CheckoutConfirmingPanel`: back from Stripe, before Autumn has the plan; the offer is withheld. */
const checkoutConfirming = (h: H): Html =>
	panel(
		h,
		{
			className: "mx-auto max-w-md items-center gap-3 px-6 py-10 text-center",
			attributes: [h.Role("status"), h.AriaLive("polite")],
		},
		[
			spinner(h, "size-5"),
			h.p([h.Class("text-sm font-medium")], ["Confirming your subscription…"]),
			h.p(
				[h.Class("text-sm text-muted-foreground")],
				[
					"Stripe is letting us know your checkout finished. This usually takes a few seconds; there's nothing else to click.",
				],
			),
		],
	)

/** `CheckoutTimedOutNotice`: the wait gave up, so a slow sync does not read as a failure. */
const checkoutTimedOut = (h: H): Html =>
	panel(
		h,
		{
			tone: "muted",
			className: "px-4 py-3 text-sm text-muted-foreground",
			attributes: [h.Role("status")],
		},
		[
			"We haven't heard back from Stripe yet. If you completed checkout, your plan will appear here shortly; there's no need to subscribe again. If you left checkout, ",
			"pick a plan below",
			".",
		],
	)

const loadingGrid = (h: H): Html =>
	h.div([h.Class("grid grid-cols-1 gap-4 sm:grid-cols-2")], [loadingCard(h), loadingCard(h)])

/** `PlanCards`: the plans offered, then Enterprise as a peer card. */
export const planCards = (h: H, plans: ReadonlyArray<CatalogPlan>, loadingPlanId: string | null): Html => {
	const totalCards = plans.length + 1
	return h.div(
		[
			h.Class(
				cn(
					"grid grid-cols-1 gap-4",
					totalCards === 2 && "sm:grid-cols-2",
					totalCards >= 3 && "sm:grid-cols-2 lg:grid-cols-3",
				),
			),
		],
		[...plans.map((plan) => planCard(h, plan, loadingPlanId)), enterpriseCard(h)],
	)
}

const plansGrid = (h: H, plans: ReadonlyArray<CatalogPlan>, model: Model): Html =>
	h.div(
		[h.Class("space-y-6")],
		[
			...(model.checkoutReturn === "TimedOut" ? [checkoutTimedOut(h)] : []),
			planCards(
				h,
				plans.filter((plan) => !plan.addOn && !plan.autoEnable),
				model.loadingPlanId,
			),
		],
	)

const dataIncluded = (h: H, rows: ReadonlyArray<FeatureRow>, isDetailed: boolean): Html =>
	h.div(
		[],
		[
			eyebrow(h, { className: "mb-3", as: "div" }, ["Data included"]),
			h.div(
				[h.Class("space-y-2.5")],
				rows.map((row) => dataRow(h, row, isDetailed)),
			),
		],
	)
