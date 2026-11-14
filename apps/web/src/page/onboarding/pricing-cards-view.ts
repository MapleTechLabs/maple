import type { CatalogPlan } from "@maple/domain/http"
import { getPlanDescription, getPlanFeatures, TRIAL_DURATION_DAYS } from "../kit/billing/plans"
import { cn } from "@maple/ui/lib/utils"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button, linkButton } from "@maple/views/ui/button"
import { card, cardDescription, cardFooter, cardHeader, cardPanel, cardTitle } from "@maple/views/ui/card"
import { badge, separator } from "@maple/views/ui/display"
import { errorState } from "@maple/views/ui/error-state"
import { eyebrow, eyebrowVariants } from "@maple/views/ui/eyebrow"
import { icon } from "@maple/views/ui/icon"
import { skeleton } from "@maple/views/ui/skeleton"
import { panel } from "@maple/views/ui/panel"
import { spinner } from "@maple/views/ui/spinner"
import { compliance } from "../kit/compliance-line"
import { ENTERPRISE_CONTACT_URL, Message, type Model } from "./pricing-cards"
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
import { typography, typographyClass } from "@maple/views/ui/typography"
import { hstack } from "@maple/views/ui/stack"
import { Array as Arr } from "effect"

type H = HtmlBuilder<Message>

// Below `sm` the cards stack, so a card's action sits under its price, above the feature lists
// (a phone showed only features before the button), and is 44px tall.
const CARD_PANEL_CLASS = "flex flex-col gap-5 flex-1 max-sm:order-last max-sm:pb-4"
const CARD_FOOTER_CLASS = "mt-auto flex-col gap-2 items-stretch"
const CARD_ACTION_CLASS = "w-full max-sm:h-11"
/** Two lines from `sm` up, so side-by-side cards line up; stacked cards need no filler. */
const CARD_DESCRIPTION_CLASS =
	"mt-2 sm:min-h-[2lh] font-display text-sm leading-relaxed text-muted-foreground"

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
	const value = typography(h, { tone: "foreground", weight: "semibold", numeric: true }, [feature.value])
	return hstack(h, { align: "center", justify: "between", className: "min-h-10 text-sm" }, [
		hstack(h, { gap: "2.5", align: "center", className: "text-muted-foreground" }, [
			...(iconName === undefined ? [] : [icon(h, iconName, { className: "size-4" })]),
			typography(h, { weight: "medium" }, [feature.label]),
		]),
		isDetailed
			? h.div(
					[h.Class("text-right")],
					[
						value,
						...(feature.detail === null
							? []
							: [
									h.p(
										[h.Class("text-foreground-subtle text-3xs mt-0.5 font-medium")],
										[feature.detail],
									),
								]),
					],
				)
			: value,
	])
}

const platformFeatures = (h: H, slug: string): Html =>
	h.div(
		[],
		[
			eyebrow(h, { className: "mb-3", as: "div" }, ["Platform features"]),
			h.div(
				[h.Class("space-y-2.5")],
				Arr.map(getPlanFeatures(slug), (feature) =>
					hstack(h, { gap: "2.5", align: "start", className: "text-sm" }, [
						icon(h, PLATFORM_FEATURE_ICONS.get(feature.icon) ?? "CircleCheckIcon", {
							className: "text-foreground-subtle size-4 shrink-0 mt-0.5",
						}),
						typography(h, { tone: "muted", className: "leading-snug" }, [feature.label]),
						...(feature.value
							? [
									h.span(
										[h.Class("font-semibold tabular-nums text-xs ml-auto shrink-0")],
										[feature.value],
									),
								]
							: []),
					]),
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
				hstack(h, { gap: "2", justify: "between" }, [
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
				]),
				hstack(h, { gap: "1", align: "baseline", className: "mt-3" }, [
					h.span(
						[h.Class("font-mono text-3xl font-semibold tracking-tight tabular-nums")],
						[price],
					),
					...(interval === undefined
						? []
						: [eyebrow(h, { variant: "label", className: "ml-1" }, [interval])]),
				]),
				cardDescription(
					h,
					[plan.description ?? getPlanDescription(getPlanSlug(plan))],
					CARD_DESCRIPTION_CLASS,
				),
			]),
			cardPanel(
				h,
				[
					...(features.length > 0 ? [dataIncluded(h, features, true)] : []),
					separator(h, "horizontal", "bg-border-subtle"),
					platformFeatures(h, getPlanSlug(plan)),
				],
				CARD_PANEL_CLASS,
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
							className: CARD_ACTION_CLASS,
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
				CARD_FOOTER_CLASS,
			),
		],
		cn(
			"flex flex-col",
			isActive && "bg-surface-strong",
			isUpgrade && "bg-surface-sunken ring-1 ring-primary-a3",
		),
	)
}

/** Enterprise as a peer card, so the grid stays balanced. */
const enterpriseCard = (h: H): Html =>
	card(
		h,
		[
			cardHeader(h, [
				hstack(h, { gap: "2", justify: "between" }, [
					cardTitle(h, ["Enterprise"], eyebrowVariants()),
				]),
				hstack(h, { gap: "1", align: "baseline", className: "mt-3" }, [
					h.span(
						[h.Class("font-mono text-3xl font-semibold tracking-tight tabular-nums")],
						["Custom"],
					),
				]),
				cardDescription(
					h,
					["For high-volume teams with custom retention, compliance, and dedicated support."],
					CARD_DESCRIPTION_CLASS,
				),
			]),
			cardPanel(
				h,
				[
					dataIncluded(h, ENTERPRISE_DATA_FEATURES, false),
					separator(h, "horizontal", "bg-border-subtle"),
					platformFeatures(h, "enterprise"),
				],
				CARD_PANEL_CLASS,
			),
			cardFooter(
				h,
				[
					// A real link: a tab opened from a Command can be blocked, and the page cannot tell.
					linkButton(
						h,
						{
							href: ENTERPRISE_CONTACT_URL,
							variant: "outline",
							className: CARD_ACTION_CLASS,
							attributes: [
								h.Target("_blank"),
								h.Rel("noopener noreferrer"),
								h.AriaLabel("Talk to founder (opens a new tab)"),
							],
						},
						["Talk to founder", icon(h, "ExternalLinkIcon", { size: 12 })],
					),
				],
				CARD_FOOTER_CLASS,
			),
		],
		"flex flex-col",
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

/** Back from Stripe, before Autumn has the plan; the offer is withheld. */
const checkoutConfirming = (h: H): Html =>
	panel(
		h,
		{
			className: "mx-auto max-w-md items-center gap-3 px-6 py-10 text-center",
			attributes: [h.Role("status"), h.AriaLive("polite")],
		},
		[
			spinner(h, "size-5"),
			typography(h, { size: "sm", weight: "medium", as: "p" }, ["Confirming your subscription…"]),
			typography(h, { size: "sm", tone: "muted", as: "p" }, [
				"Stripe is letting us know your checkout finished. This usually takes a few seconds; there's nothing else to click.",
			]),
		],
	)

/** The wait gave up, so a slow sync does not read as a failure. */
const checkoutTimedOut = (h: H): Html =>
	panel(
		h,
		{
			tone: "muted",
			className: typographyClass({ size: "sm", tone: "muted", className: "px-4 py-3" }),
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

/** The plans offered, then Enterprise as a peer card. */
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
		[...Arr.map(plans, (plan) => planCard(h, plan, loadingPlanId)), enterpriseCard(h)],
	)
}

const plansGrid = (h: H, plans: ReadonlyArray<CatalogPlan>, model: Model): Html =>
	h.div(
		[h.Class("space-y-6")],
		[
			...(model.checkoutReturn === "TimedOut" ? [checkoutTimedOut(h)] : []),
			planCards(
				h,
				Arr.filter(plans, (plan) => !plan.addOn && !plan.autoEnable),
				model.loadingPlanId,
			),
			compliance(h),
		],
	)

const dataIncluded = (h: H, rows: ReadonlyArray<FeatureRow>, isDetailed: boolean): Html =>
	h.div(
		[],
		[
			eyebrow(h, { className: "mb-3", as: "div" }, ["Data included"]),
			h.div(
				[h.Class("space-y-2.5")],
				Arr.map(rows, (row) => dataRow(h, row, isDetailed)),
			),
		],
	)
