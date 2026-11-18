import { badge } from "@maple/views/ui/display"
import { meter } from "@maple/views/ui/meter"
import { hstack, vstack } from "@maple/views/ui/stack"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "@maple/views/ui/table"
import { typography } from "@maple/views/ui/typography"
import { Array as Arr, Schema } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { makeStaticIsland, type StaticMessage } from "../../foldkit-island/island"
import { formatMoney } from "./live-cost-data"

// The Cost page's Budgets list over invented budgets, from the kit's table, meter and badges. The
// amounts agree with LiveCostExplorer's bill, sixteen days into the month.

type Severity = "warning" | "critical"

interface Budget {
	readonly name: string
	/** "Monthly · All spend": the period, then the slice of spend the budget covers. */
	readonly scope: string
	readonly spent: number
	readonly amount: number
	readonly forecast: number
	readonly forecastBy: string
	readonly alerts: ReadonlyArray<string>
	/** The alert the budget stands at now; null while none is reached. */
	readonly reached: Severity | null
}

const BUDGETS: ReadonlyArray<Budget> = [
	{
		name: "All cloud spend",
		scope: "Monthly · All spend",
		spent: 5612.4,
		amount: 10000,
		forecast: 10523.25,
		forecastBy: "Nov 30",
		alerts: ["Warning at 100% forecast", "Critical at 100% spend"],
		reached: "warning",
	},
	{
		name: "AI models",
		scope: "Monthly · Provider: Anthropic, OpenAI",
		spent: 848.12,
		amount: 800,
		forecast: 1590.22,
		forecastBy: "Nov 30",
		alerts: ["Warning at 80% spend", "Critical at 100% spend"],
		reached: "critical",
	},
	{
		name: "Frankfurt region",
		scope: "Quarterly · Provider: AWS · Region: eu-central-1",
		spent: 1948.6,
		amount: 6000,
		forecast: 3814.28,
		forecastBy: "Dec 31",
		alerts: ["Warning at 90% forecast"],
		reached: null,
	},
	{
		name: "CI minutes",
		scope: "Monthly · Service: Actions",
		spent: 148.2,
		amount: 400,
		forecast: 277.88,
		forecastBy: "Nov 30",
		alerts: ["Warning at 100% forecast"],
		reached: null,
	},
]

type H = HtmlBuilder<StaticMessage>

/** A share of a budget, rounded down: 99.6% must not read as reached. */
const percentText = (budget: Budget): string => `${Math.floor((budget.spent / budget.amount) * 100)}%`

/** The fill takes the tone of what is reached, so a bar over budget reads at a glance. */
const spentCell = (h: H, budget: Budget): Html =>
	vstack(h, { gap: "1.5", shrink: true }, [
		typography(h, { size: "sm", numeric: true }, [
			`${formatMoney(budget.spent)} of ${formatMoney(budget.amount)}`,
		]),
		hstack(h, { gap: "2", align: "center" }, [
			meter(h, {
				value: Math.min(budget.spent, budget.amount),
				max: budget.amount,
				label: `${budget.name}: ${percentText(budget)} of the budget spent`,
				...(budget.reached === null
					? undefined
					: { tone: budget.reached === "critical" ? "crit" : "warn" }),
				className: "min-w-0 flex-1",
			}),
			typography(h, { size: "xs", tone: "muted", numeric: true, className: "w-10 text-right" }, [
				percentText(budget),
			]),
		]),
	])

/** The period's projected total; over the amount it reads as a warning. */
const forecast = (h: H, budget: Budget): Html =>
	typography(
		h,
		{ size: "xs", numeric: true, tone: budget.forecast > budget.amount ? "warning" : "muted" },
		[`${formatMoney(budget.forecast)} by ${budget.forecastBy}`],
	)

const alerts = (h: H, budget: Budget): Html =>
	vstack(
		h,
		{ gap: "0.5", shrink: true },
		Arr.map(budget.alerts, (alert) =>
			typography(h, { size: "xs", tone: "muted", attributes: [h.Key(alert)] }, [alert]),
		),
	)

const stateBadge = (h: H, budget: Budget): Html =>
	budget.reached === null
		? badge(h, { variant: "ok" }, ["On track"])
		: badge(h, { variant: budget.reached === "critical" ? "crit" : "warn" }, [
				budget.reached === "critical" ? "Critical" : "Warning",
			])

// The frame is a column of the section, never a laptop wide: the forecast and the alerts ride
// under the name, as they do on the product's page below a laptop's width.
const ROOMY = "hidden sm:table-cell"
const ON_PHONE = "sm:hidden"

const budgetRow = (h: H, budget: Budget): Html =>
	tableRow(
		h,
		[
			tableCell(
				h,
				[
					vstack(h, { gap: "0.5", shrink: true }, [
						typography(h, { size: "sm", weight: "medium", className: "break-words" }, [
							budget.name,
						]),
						typography(h, { size: "xs", tone: "muted", className: "break-words" }, [
							budget.scope,
						]),
						vstack(h, { gap: "1.5", className: `py-1 ${ON_PHONE}` }, [
							spentCell(h, budget),
							hstack(h, {}, [stateBadge(h, budget)]),
						]),
						vstack(h, { gap: "0.5", className: "pt-1" }, [
							forecast(h, budget),
							alerts(h, budget),
						]),
					]),
				],
				"whitespace-normal",
			),
			tableCell(h, [spentCell(h, budget)], `align-top ${ROOMY}`),
			tableCell(h, [stateBadge(h, budget)], `align-top ${ROOMY}`),
		],
		undefined,
		[h.Key(budget.name)],
	)

const view = (_props: Readonly<{}>, h: H): Html =>
	h.div(
		[h.Class("live-frame")],
		[
			h.div(
				[h.Class("live-frame__head")],
				[
					h.span([], [`/cost/budgets · ${BUDGETS.length} budgets · USD`]),
					h.span(
						[h.Class("live-frame__live")],
						[h.span([h.Class("live-frame__live-dot")], []), "DEMO"],
					),
				],
			),
			h.div(
				[h.Class("bg-background font-sans text-foreground")],
				[
					table(h, { ariaLabel: "Budgets" }, [
						tableHeader(h, [
							tableRow(h, [
								tableHead(h, ["Budget"]),
								tableHead(h, ["Spent this period"], `w-56 ${ROOMY}`),
								tableHead(h, ["State"], `w-24 ${ROOMY}`),
							]),
						]),
						tableBody(
							h,
							Arr.map(BUDGETS, (budget) => budgetRow(h, budget)),
						),
					]),
				],
			),
		],
	)

export const LiveCostBudgets = makeStaticIsland({
	name: "live-cost-budgets",
	Props: Schema.Struct({}),
	view,
})
