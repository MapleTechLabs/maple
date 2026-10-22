import type { CatalogPlan, CatalogPlanItem } from "@maple/domain/http"
import { formatCurrency } from "@maple/domain/format"
import { formatCount, formatQuoteUnits, quoteUnits } from "../../lib/billing/usage"
import type { IconName } from "../../ui/icon"

// The data side of `PricingCards`: which plans show, their prices, metered rows and buttons.

export const FEATURE_ICONS = new Map<string, IconName>([
	["logs", "FileIcon"],
	["traces", "PulseIcon"],
	["metrics", "ChartLineIcon"],
	["browser_sessions", "PlayRotateClockwiseIcon"],
	["product_events", "GlobePointerIcon"],
	["ai_credits", "SquareSparkleIcon"],
])

const DATA_FEATURE_LABELS = new Map<string, string>([
	["logs", "Logs"],
	["traces", "Traces"],
	["metrics", "Metrics"],
	["browser_sessions", "Browser Sessions"],
	["product_events", "Product Events"],
	["ai_credits", "AI usage"],
])

const COUNT_UNITS = new Map<string, string>([
	["browser_sessions", "sessions"],
	["product_events", "events"],
])

export const PLATFORM_FEATURE_ICONS = new Map<string, IconName>([
	["clock", "ClockIcon"],
	["grid", "GridIcon"],
	["bell", "BellIcon"],
	["code", "CodeIcon"],
	["shield", "ShieldIcon"],
])

const HIDDEN_FEATURE_IDS = new Set<string>(["ai_input_tokens", "ai_output_tokens"])

export const getPlanSlug = (plan: CatalogPlan): string => {
	if (plan.autoEnable) return "starter"
	const id = plan.id.toLowerCase()
	if (id === "starter" || id === "startup") return id
	const name = plan.name.toLowerCase()
	if (name === "starter" || name === "startup") return name
	return "startup"
}

export const getPlanPrice = (plan: CatalogPlan): { readonly price: string; readonly interval?: string } => {
	if (plan.autoEnable) return { price: "$0" }
	if (plan.price) {
		return plan.price.interval
			? { price: `$${plan.price.amount}`, interval: `/${plan.price.interval}` }
			: { price: `$${plan.price.amount}` }
	}
	return { price: plan.name }
}

const formatIncludedUsage = (item: CatalogPlanItem): string => {
	if (item.unlimited) return "Unlimited"
	if (item.featureId === "ai_credits" && item.included != null)
		return `${formatCurrency(item.included, "usd")} included`
	if (item.included != null)
		return `${formatCount(item.included)} ${COUNT_UNITS.get(item.featureId) ?? "GB"}`
	return ""
}

const normalizeDetailText = (text: string): string =>
	text.replace(/\bper\s+(?:[\d,]+\s+)?(?:logs?|traces?|metrics?)\b/i, "per GB")

/** Autumn words the rate per billing block; events are quoted per million, in its style. */
const formatDetail = (item: CatalogPlanItem): string | undefined => {
	const amount = item.price?.amount
	const billingUnits = item.price?.billingUnits ?? 1
	const unit = COUNT_UNITS.get(item.featureId)
	const quote = quoteUnits(item.featureId, billingUnits)
	if (amount != null && unit !== undefined && quote !== billingUnits && billingUnits > 0) {
		const perQuote = (amount / billingUnits) * quote
		return `then $${Number(perQuote.toPrecision(6))} per ${formatQuoteUnits(quote)} ${unit}`
	}
	return item.display?.secondaryText ? normalizeDetailText(item.display.secondaryText) : undefined
}

export const ENTERPRISE_DATA_FEATURES: ReadonlyArray<FeatureRow> = [
	{ featureId: "logs", label: "Logs", value: "Custom", detail: null },
	{ featureId: "traces", label: "Traces", value: "Custom", detail: null },
	{ featureId: "metrics", label: "Metrics", value: "Custom", detail: null },
	{ featureId: "browser_sessions", label: "Browser Sessions", value: "Custom", detail: null },
	{ featureId: "product_events", label: "Product Events", value: "Custom", detail: null },
]

export type Scenario = "new" | "active" | "scheduled" | "upgrade" | "downgrade"

export const getScenario = (plan: CatalogPlan): Scenario => {
	const eligibility = plan.customerEligibility
	if (!eligibility) return "new"
	if (eligibility.status === "active") return "active"
	if (eligibility.status === "scheduled") return "scheduled"
	return eligibility.attachAction === "upgrade"
		? "upgrade"
		: eligibility.attachAction === "downgrade"
			? "downgrade"
			: "new"
}

export type ButtonConfig = Readonly<{
	label: string
	variant: "secondary" | "default" | "outline"
	isDisabled: boolean
}>

export const getButtonConfig = (plan: CatalogPlan): ButtonConfig => {
	switch (getScenario(plan)) {
		case "active":
			return { label: "Current plan", variant: "secondary", isDisabled: true }
		case "scheduled":
			return { label: "Scheduled", variant: "secondary", isDisabled: true }
		case "upgrade":
			return { label: "Upgrade", variant: "default", isDisabled: false }
		case "downgrade":
			return { label: "Downgrade", variant: "outline", isDisabled: false }
		case "new":
			return { label: "Subscribe", variant: "outline", isDisabled: false }
	}
}

export type FeatureRow = Readonly<{ featureId: string; label: string; value: string; detail: string | null }>

export const getFeatureRows = (plan: CatalogPlan): ReadonlyArray<FeatureRow> =>
	plan.items
		.filter((item) => item.featureId !== "" && !HIDDEN_FEATURE_IDS.has(item.featureId))
		.map((item) => {
			const detail = formatDetail(item)
			return {
				featureId: item.featureId,
				label: DATA_FEATURE_LABELS.get(item.featureId) ?? item.feature?.name ?? item.featureId,
				value: formatIncludedUsage(item),
				detail: detail ?? null,
			}
		})
