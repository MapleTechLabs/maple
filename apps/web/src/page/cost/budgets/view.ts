import { COST_BUDGET_FORECAST_MIN_DAYS } from "@maple/domain/cost-budget"
import type { CostBudgetStatus } from "@maple/domain/http"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import * as Keyed from "@maple/views/data/keyed"
import { Array as Arr, Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { confirmDialog } from "@maple/views/ui/confirm-dialog"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "@maple/views/ui/empty"
import { errorState } from "@maple/views/ui/error-state"
import { icon } from "@maple/views/ui/icon"
import { iconButton } from "@maple/views/ui/icon-button"
import { meter } from "@maple/views/ui/meter"
import { panel } from "@maple/views/ui/panel"
import { emptyActions } from "@maple/views/ui/signal-empty-state"
import { skeletonList } from "@maple/views/ui/skeleton"
import { hstack, vstack } from "@maple/views/ui/stack"
import { switchControl } from "@maple/views/ui/switch"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "@maple/views/ui/table"
import { textLink } from "@maple/views/ui/text-link"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { ALERT_SEVERITY_LABEL, alertStatusBadge, severityBadge } from "../../alerts/shared/badges"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { BELOW_LAPTOP, LAPTOP_COLUMN } from "../../kit/laptop-column"
import { notifiesNoOne } from "../../kit/notifies-no-one"
import { canManageSlos, gatedControl } from "../../kit/session-grants"
import { gatedLinkButton, gatedSwitch } from "../../kit/gated-controls"
import {
	alertText,
	budgetFormHref,
	forecastText,
	PERIODS,
	percentText,
	reachedSeverity,
	scopeText,
	spentText,
} from "../kit/budget-format"
import { budgetById, budgetsOf, notifiesSomeone } from "./derive"
import { Message, type Model } from "./model"
import { DELETE_DIALOG_ID } from "./update"
import { betaNotice } from "../kit/beta-notice"

type H = HtmlBuilder<Message>

// Below a laptop's width the Forecast and Alerts columns ride under the name; on a phone the spend
// and the state do too, so nothing sits past the panel's edge.
const WIDE_COLUMN = LAPTOP_COLUMN
const BELOW_WIDE = BELOW_LAPTOP
const ROOMY_COLUMN = "hidden sm:table-cell"
const ON_PHONE = "sm:hidden"

const DESCRIPTION =
	"An amount per month, quarter or year over a slice of spend. A budget opens an alert incident when the spend, or its forecast, reaches a percent of it."

/** Where the budget stands: an alert's severity once one is reached, else on track; off when disabled. */
const stateBadge = (h: H, budget: CostBudgetStatus): Html => {
	if (!budget.enabled) return alertStatusBadge(h, "disabled", { label: "Off" })
	const severity = reachedSeverity(budget, budget.progress)
	return severity === null ? alertStatusBadge(h, "ok", { label: "On track" }) : severityBadge(h, severity)
}

/** The fill takes the tone of what is reached, so a bar over budget reads at a glance. */
const spendMeter = (h: H, budget: CostBudgetStatus): Html => {
	const severity = budget.enabled ? reachedSeverity(budget, budget.progress) : null
	return meter(h, {
		// Capped at the amount: a meter's value never passes its max, and the label says the percent.
		value: Math.min(Math.max(0, budget.progress.spent), budget.amount),
		max: budget.amount,
		label: `${budget.name}: ${percentText(budget.progress.percent)} of the budget spent`,
		...(severity === null ? undefined : { tone: severity === "critical" ? "crit" : "warn" }),
		className: "min-w-0 flex-1",
	})
}

const spentCell = (h: H, budget: CostBudgetStatus): Html =>
	vstack(h, { gap: "1.5", shrink: true }, [
		typography(h, { size: "sm", numeric: true }, [spentText(budget, budget.progress.spent)]),
		hstack(h, { gap: "2", align: "center" }, [
			spendMeter(h, budget),
			typography(h, { size: "xs", tone: "muted", numeric: true, className: "w-10 text-right" }, [
				percentText(budget.progress.percent),
			]),
		]),
	])

/** The period's projected total; over the amount it reads as a warning. */
const forecast = (h: H, budget: CostBudgetStatus): Html => {
	const text = forecastText(budget, budget.progress)
	if (text === null) {
		return typography(h, { size: "xs", tone: "muted" }, [
			`After ${COST_BUDGET_FORECAST_MIN_DAYS} days of the period`,
		])
	}
	const isOver = budget.progress.forecast !== null && budget.progress.forecast > budget.amount
	return typography(h, { size: "xs", numeric: true, tone: isOver ? "warning" : "muted" }, [text])
}

/** Each alert as "Warning at 100% forecast"; a budget that tells no one says so. */
const alerts = (h: H, budget: CostBudgetStatus): Html =>
	vstack(h, { gap: "0.5", shrink: true }, [
		...Arr.map(budget.alerts, (alert) =>
			typography(h, { size: "xs", tone: "muted", attributes: [h.Key(alert.severity)] }, [
				`${ALERT_SEVERITY_LABEL[alert.severity]} at ${alertText(alert)}`,
			]),
		),
		...(notifiesSomeone(budget) ? [] : [notifiesNoOne(h)]),
	])

/** Budget actions show once the grants are read: enabled for who manages budgets, else locked. */
const showsActions = (model: Model): boolean => model.isGrantsRead || canManageSlos(model)

const rowActions = (h: H, model: Model, budget: CostBudgetStatus): Html => {
	const isBusy = Arr.contains(model.togglingIds, budget.id) || model.deletingId === budget.id
	const isLocked = !canManageSlos(model)
	return hstack(h, { gap: "1", align: "center", justify: "end" }, [
		...gatedSwitch(
			h,
			model,
			"slos:manage",
			switchControl(h, {
				id: `budget-switch-${budget.id}`,
				inputId: `budget-switch-input-${budget.id}`,
				isChecked: budget.enabled,
				isDisabled: isLocked || isBusy,
				ariaLabel: `${budget.enabled ? "Turn off" : "Turn on"} ${budget.name}`,
				className: "mr-2",
				onToggle: Message.ToggledBudget({ id: budget.id }),
			}),
		),
		gatedControl(h, model, "slos:manage", (isDisabled) =>
			iconButton(
				h,
				{
					label: `Edit ${budget.name}`,
					// Leaving the page would drop the answer of a write still out.
					isDisabled: isDisabled || isBusy,
					attributes: [h.OnClick(Message.ClickedEdit({ id: budget.id }))],
				},
				[icon(h, "PencilIcon")],
			),
		),
		gatedControl(h, model, "slos:manage", (isDisabled) =>
			iconButton(
				h,
				{
					label: `Delete ${budget.name}`,
					isDisabled: isDisabled || isBusy,
					attributes: [h.OnClick(Message.ClickedDelete({ id: budget.id }))],
				},
				[icon(h, "TrashIcon")],
			),
		),
	])
}

const budgetRow = (h: H, model: Model, budget: CostBudgetStatus): Html =>
	tableRow(
		h,
		[
			tableCell(
				h,
				[
					vstack(h, { gap: "0.5", shrink: true }, [
						// The editor is the manager's; anyone else reads the name.
						canManageSlos(model)
							? textLink(
									h,
									{
										tone: "inherit",
										href: budgetFormHref({ budgetId: budget.id }),
										className: typographyClass({
											size: "sm",
											weight: "medium",
											className: "block break-words",
										}),
									},
									[budget.name],
								)
							: typography(h, { size: "sm", weight: "medium", className: "break-words" }, [
									budget.name,
								]),
						typography(h, { size: "xs", tone: "muted", className: "break-words" }, [
							`${PERIODS[budget.period].label} · ${scopeText(budget.filters, model.sources)}`,
						]),
						vstack(h, { gap: "1.5", className: `py-1 ${ON_PHONE}` }, [
							spentCell(h, budget),
							// Its own row, so the badge keeps its width and does not stretch to the column's.
							hstack(h, {}, [stateBadge(h, budget)]),
						]),
						vstack(h, { gap: "0.5", className: BELOW_WIDE }, [
							forecast(h, budget),
							alerts(h, budget),
						]),
					]),
				],
				"whitespace-normal",
			),
			tableCell(h, [spentCell(h, budget)], ROOMY_COLUMN),
			tableCell(h, [forecast(h, budget)], WIDE_COLUMN),
			tableCell(h, [alerts(h, budget)], WIDE_COLUMN),
			tableCell(h, [stateBadge(h, budget)], ROOMY_COLUMN),
			...(showsActions(model) ? [tableCell(h, [rowActions(h, model, budget)])] : []),
		],
		undefined,
		[h.Key(budget.id)],
	)

const budgetsTable = (h: H, model: Model, budgets: ReadonlyArray<CostBudgetStatus>): Html =>
	table(h, { ariaLabel: "Budgets" }, [
		tableHeader(h, [
			tableRow(h, [
				tableHead(h, ["Budget"]),
				tableHead(h, ["Spent this period"], `w-64 ${ROOMY_COLUMN}`),
				tableHead(h, ["Forecast"], `w-44 ${WIDE_COLUMN}`),
				tableHead(h, ["Alerts"], `w-52 ${WIDE_COLUMN}`),
				tableHead(h, ["State"], `w-28 ${ROOMY_COLUMN}`),
				...(showsActions(model)
					? [
							tableHead(
								h,
								[typography(h, { className: "sr-only" }, ["Enabled and actions"])],
								"w-36",
							),
						]
					: []),
			]),
		]),
		tableBody(
			h,
			Arr.map(budgets, (budget) => budgetRow(h, model, budget)),
		),
	])

/** Nothing set up yet: what a budget is, and the way to the first one for who may make it. */
const onRamp = (h: H, model: Model): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "GaugeIcon")]),
				emptyTitle(h, ["No budgets yet"]),
				emptyDescription(h, [
					"Set an amount for all spend or for one provider, service or account. Maple tells you when the spend, or its forecast for the period, gets there.",
				]),
			]),
			...(showsActions(model) ? [emptyActions(h, [newBudgetButton(h, model)])] : []),
		],
		"py-12",
	)

const listBody = (h: H, model: Model): ReadonlyArray<Html> =>
	AsyncData.matchData(model.list.data, {
		onEmpty: () => [skeletonList(h, { rows: 4, label: "Loading budgets" })],
		onFailure: (failure) => [
			errorState(h, { failure, title: "Couldn't load budgets", onRetry: Message.ClickedRetry() }),
		],
		onData: () => {
			const budgets = budgetsOf(model) ?? []
			if (budgets.length === 0) return [onRamp(h, model)]
			const isRefetching = Keyed.isInFlight(model.list)
			return [
				panel(
					h,
					{
						className: `overflow-hidden ${refreshingClass(isRefetching)}`,
						attributes: [h.AriaBusy(isRefetching)],
					},
					[budgetsTable(h, model, budgets)],
				),
				typography(h, { size: "xs", tone: "muted", as: "p" }, [
					"Spend follows the cost sync, about once a day, and periods are calendar periods in UTC. A budget's incidents are in Alerts.",
				]),
			]
		},
	})

const deleteDialog = (h: H, model: Model): Html => {
	const name = Option.match(budgetById(model, model.confirmDeleteId), {
		onNone: () => "this budget",
		onSome: (budget) => budget.name,
	})
	return confirmDialog(h, {
		slotId: DELETE_DIALOG_ID,
		model: model.deleteDialog,
		toParentMessage: (message) => Message.GotDeleteDialogMessage({ message }),
		title: `Delete ${name}?`,
		description:
			"It stops measuring this spend, and the incidents it opened are deleted with it. This cannot be undone.",
		confirmLabel: "Delete budget",
		isPending: model.deletingId !== null,
		onConfirm: Message.ClickedConfirmDelete(),
	})
}

const newBudgetButton = (h: H, model: Model): Html =>
	gatedLinkButton(h, model, "slos:manage", { size: "sm", href: budgetFormHref() }, [
		icon(h, "PlusIcon"),
		"New budget",
	])

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, _inputs, h) =>
	dashboardPage(
		h,
		{
			title: "Budgets",
			description: DESCRIPTION,
			// With none yet, the on-ramp in the body offers the first one.
			actions:
				showsActions(model) && (budgetsOf(model) ?? []).length > 0
					? newBudgetButton(h, model)
					: undefined,
		},
		[
			vstack(h, { gap: "6", className: "shrink-0" }, [
				betaNotice(h),
				vstack(h, { gap: "3" }, listBody(h, model)),
			]),
			deleteDialog(h, model),
		],
	),
)
