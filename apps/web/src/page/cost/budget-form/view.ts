import { COST_BUDGET_FORECAST_MIN_DAYS, CostBudgetPeriod } from "@maple/domain/cost-budget"
import type { AlertSeverity } from "@maple/domain/http"
import { Array as Arr, Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { failureMessage } from "@maple/views/data/load-failure"
import { alert, alertAction, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { button, linkButton } from "@maple/views/ui/button"
import { errorState } from "@maple/views/ui/error-state"
import { icon } from "@maple/views/ui/icon"
import { input } from "@maple/views/ui/input"
import { inputGroup, inputGroupAddon, inputGroupInput, inputGroupText } from "@maple/views/ui/input-group"
import { label } from "@maple/views/ui/label"
import type * as MenuView from "@maple/views/ui/menu-view"
import { nativeOption, nativeSelect } from "@maple/views/ui/native-select"
import { segmentedSelect } from "@maple/views/ui/segmented-select"
import { skeleton } from "@maple/views/ui/skeleton"
import { hstack, vstack } from "@maple/views/ui/stack"
import { switchControl } from "@maple/views/ui/switch"
import { typography } from "@maple/views/ui/typography"
import { ALERT_SEVERITY_LABEL } from "../../alerts/shared/badges"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { destinationPicker } from "../../kit/destination-picker"
import {
	formActionBar,
	formCard,
	formScrollArea,
	formSection,
	managersOnlyPage,
} from "../../kit/form-section"
import { pickList } from "../../kit/pick-list"
import { resourceNotFound } from "../../kit/resource-not-found"
import { DIMENSIONS, formatMoney, keyLabel } from "../derive"
import { ALL_SPEND, budgetsHref, isForbidden, PERIODS, scopeEntries } from "../kit/budget-format"
import { amountOf, currencyChoices, filtersOf, formIssues, percentOf, scopeItemValue } from "./derive"
import { type AlertForm, type Form, SCOPE_DIMENSIONS, SEVERITIES } from "./form"
import { accessOf, isAwaitingOptions, Message, type Model } from "./model"

type H = HtmlBuilder<Message>

const FORM_WIDTH = "max-w-3xl"

const hiddenLabel = (h: H, id: string, text: string): Html =>
	label(h, { className: "sr-only", attributes: [h.For(id)] }, [text])

// Every control waits for a save that is out: its answer replaces the form, so an edit made
// meanwhile would be dropped without a word.
const nameSection = (h: H, model: Model): Html =>
	formSection(h, { title: "Name", hint: "Its incidents carry it" }, [
		hiddenLabel(h, "budget-name", "Name"),
		input(h, {
			id: "budget-name",
			isDisabled: model.isSaving,
			attributes: [
				h.Value(model.form.name),
				h.Placeholder("AWS production"),
				h.OnInput((value) => Message.ChangedText({ field: "name", value })),
			],
		}),
	])

/** The values the form can still add: each dimension's largest by cost, minus the ones picked. */
const scopeMenuEntries = (model: Model): ReadonlyArray<MenuView.MenuEntry> =>
	model.options === null
		? []
		: Arr.flatMap(SCOPE_DIMENSIONS, (dimension): ReadonlyArray<MenuView.MenuEntry> => {
				const picked = model.form.scope[dimension]
				const rows = Arr.filter(
					model.options?.facets[dimension] ?? [],
					(row) => row.key !== "" && !Arr.contains(picked, row.key),
				)
				return rows.length === 0
					? []
					: [
							{
								_tag: "Group",
								label: DIMENSIONS[dimension].label,
								entries: Arr.map(rows, (row) => ({
									_tag: "Item" as const,
									value: scopeItemValue(dimension, row.key),
									label: keyLabel(dimension, row.key, model.options?.sources),
								})),
							},
						]
			})

const scopeSection = (h: H, model: Model): Html =>
	formSection(h, { title: "Covers", hint: "The spend it measures" }, [
		pickList(h, {
			entries: Arr.map(scopeEntries(filtersOf(model.form), model.options?.sources), (entry) => ({
				key: `${entry.dimension}:${entry.value}`,
				label: entry.label,
				media: icon(h, "FilterIcon", { className: "text-muted-foreground" }),
				removeLabel: `Remove ${entry.label}`,
				onRemove: Message.RemovedScope({ dimension: entry.dimension, value: entry.value }),
			})),
			emptyText: `${ALL_SPEND} in the budget's currency`,
			menu: model.scopeMenu,
			toMenuMessage: (message) => Message.GotScopeMenuMessage({ message }),
			addEntries: scopeMenuEntries(model),
			addLabel: "Add filter",
			isDisabled: model.isSaving,
		}),
		typography(h, { size: "xs", tone: "muted", as: "p" }, [
			"Values of one kind add up (two providers cover both). Different kinds narrow each other (a provider and a region cover that provider in that region). The menu lists the largest of the last 30 days.",
		]),
	])

/** The options read failed: what the form could not fill from the org's spend, and a way to ask again. */
const optionsNotice = (h: H, model: Model): Html =>
	alert(h, { variant: "warn", size: "sm", className: `mb-3 ${FORM_WIDTH}` }, [
		icon(h, "CircleWarningIcon"),
		alertTitle(h, ["Couldn't read the org's spend"]),
		alertDescription(h, [
			model.editingId === null
				? `The currency is a guess (${model.form.currency}), and the filter menu is empty. A budget in a currency the org is not billed in measures nothing.`
				: "The filter menu is empty. The budget itself is as stored.",
		]),
		alertAction(h, [
			button(
				h,
				{ size: "sm", variant: "outline", attributes: [h.OnClick(Message.ClickedRetryOptions())] },
				["Try again"],
			),
		]),
	])

const amountHint = (form: Form): string =>
	Option.match(amountOf(form), {
		onNone: () => "An amount above zero.",
		onSome: (amount) =>
			`${formatMoney(amount, form.currency)} per calendar ${PERIODS[form.period].noun}, in UTC. Each ${PERIODS[form.period].noun} starts at zero.`,
	})

const amountSection = (h: H, model: Model): Html => {
	const form = model.form
	const hasCurrencyChoice = currencyChoices(form, model.options).length > 1
	return formSection(h, { title: "Amount", hint: "Per period" }, [
		hstack(h, { gap: "2", align: "center", wrap: true }, [
			vstack(h, { gap: "1.5", className: "w-48" }, [
				hiddenLabel(h, "budget-amount", "Amount"),
				inputGroup(h, {}, [
					inputGroupInput(h, {
						id: "budget-amount",
						isDisabled: model.isSaving,
						attributes: [
							h.Value(form.amount),
							h.Placeholder("1000"),
							h.Attribute("inputmode", "decimal"),
							h.OnInput((value) => Message.ChangedText({ field: "amount", value })),
						],
					}),
					// With one currency the amount's own unit says it; with more, the select beside it does.
					...(hasCurrencyChoice
						? []
						: [
								inputGroupAddon(h, { align: "inline-end" }, [
									inputGroupText(h, {}, [form.currency]),
								]),
							]),
				]),
			]),
			...(hasCurrencyChoice
				? [
						hiddenLabel(h, "budget-currency", "Currency"),
						nativeSelect(
							h,
							{
								value: form.currency,
								className: "w-24",
								isDisabled: model.isSaving,
								attributes: [
									h.Id("budget-currency"),
									h.OnChange((currency) => Message.PickedCurrency({ currency })),
								],
							},
							Arr.map(currencyChoices(form, model.options), (currency) =>
								nativeOption(currency, currency),
							),
						),
					]
				: []),
			segmentedSelect(h, {
				ariaLabel: "Period",
				size: "sm",
				className: "w-fit",
				isDisabled: model.isSaving,
				value: form.period,
				onChange: (period) => Message.PickedPeriod({ period }),
				options: Arr.map(CostBudgetPeriod.literals, (period) => ({
					value: period,
					label: PERIODS[period].label,
				})),
			}),
		]),
		typography(h, { size: "xs", tone: "muted", as: "p" }, [amountHint(form)]),
	])
}

const ALERT_HINT = {
	warning: "An early heads-up",
	critical: "When it needs action",
} as const satisfies Record<AlertSeverity, string>

/** When the alert opens, in money once the amount is known, else in percent. */
const alertSentence = (form: Form, alert: AlertForm): string =>
	Option.match(percentOf(alert), {
		onNone: () => "A percent of the amount, from 1 to 1,000.",
		onSome: (percent) => {
			const at = Option.match(amountOf(form), {
				onNone: () => `${percent}% of the amount`,
				onSome: (amount) => formatMoney((amount * percent) / 100, form.currency),
			})
			return alert.basis === "forecast"
				? `Opens when the ${PERIODS[form.period].noun}'s forecast reaches ${at}. The forecast is the spend so far at its daily rate, after ${COST_BUDGET_FORECAST_MIN_DAYS} days of the period.`
				: `Opens when the spend reaches ${at}.`
		},
	})

const alertSection = (h: H, model: Model, severity: AlertSeverity): Html => {
	const alert = model.form.alerts[severity]
	const name = ALERT_SEVERITY_LABEL[severity]
	const percentId = `budget-${severity}-percent`
	return formSection(h, { title: `${name} alert`, hint: ALERT_HINT[severity] }, [
		hstack(h, { gap: "2" }, [
			...switchControl(h, {
				id: `budget-${severity}-on`,
				inputId: `budget-${severity}-on-input`,
				isChecked: alert.isOn,
				isDisabled: model.isSaving,
				labelledBy: `budget-${severity}-on-label`,
				onToggle: Message.ToggledAlert({ severity }),
			}),
			typography(h, { size: "sm", attributes: [h.Id(`budget-${severity}-on-label`)] }, [
				`Open a ${severity} incident`,
			]),
		]),
		...(alert.isOn
			? [
					hstack(h, { gap: "2", align: "center", wrap: true }, [
						typography(h, { size: "sm", tone: "muted" }, ["at"]),
						vstack(h, { gap: "1.5", className: "w-28" }, [
							hiddenLabel(h, percentId, `${name} alert percent`),
							inputGroup(h, {}, [
								inputGroupInput(h, {
									id: percentId,
									isDisabled: model.isSaving,
									attributes: [
										h.Value(alert.percent),
										h.Attribute("inputmode", "decimal"),
										h.OnInput((value) => Message.ChangedPercent({ severity, value })),
									],
								}),
								inputGroupAddon(h, { align: "inline-end" }, [inputGroupText(h, {}, ["%"])]),
							]),
						]),
						typography(h, { size: "sm", tone: "muted" }, ["of the amount, on the"]),
						segmentedSelect(h, {
							ariaLabel: `${name} alert watches`,
							size: "sm",
							className: "w-fit",
							isDisabled: model.isSaving,
							value: alert.basis,
							onChange: (basis) => Message.PickedBasis({ severity, basis }),
							options: [
								{ value: "actual", label: "Spend so far" },
								{ value: "forecast", label: "Forecast" },
							],
						}),
					]),
					typography(h, { size: "xs", tone: "muted", as: "p" }, [alertSentence(model.form, alert)]),
					destinationPicker(h, {
						rows: model.destinations,
						selectedIds: alert.destinationIds,
						menu: model.destinationMenus[severity],
						toMenuMessage: (message) => Message.GotDestinationMenuMessage({ severity, message }),
						onRemove: (id) => Message.RemovedDestination({ severity, id }),
						emptyText: "Nobody yet. The incident still opens, and no one is told.",
						isDisabled: model.isSaving,
						context: `the ${severity} alert`,
					}),
				]
			: []),
	])
}

const enabledSection = (h: H, model: Model): Html =>
	formSection(h, { title: "Enabled", isCompact: true }, [
		hstack(h, { gap: "2" }, [
			...switchControl(h, {
				id: "budget-enabled",
				inputId: "budget-enabled-input",
				isChecked: model.form.enabled,
				isDisabled: model.isSaving,
				labelledBy: "budget-enabled-label",
				onToggle: Message.ToggledEnabled(),
			}),
			typography(h, { size: "sm", attributes: [h.Id("budget-enabled-label")] }, [
				"Check the spend every hour and open incidents",
			]),
		]),
	])

const actionBar = (h: H, model: Model): Html => {
	const issues = [
		...formIssues(model.form),
		// A new budget's currency comes from the org's spend: until that answers it is a guess.
		...(isAwaitingOptions(model) ? ["Wait for the org's currencies to load."] : []),
	]
	return formActionBar(h, {
		issues,
		widthClass: FORM_WIDTH,
		notice:
			model.saveFailure === null
				? null
				: alert(h, { variant: "crit", size: "sm", className: `mb-3 ${FORM_WIDTH}` }, [
						icon(h, "CircleXmarkIcon"),
						alertTitle(h, ["Couldn't save the budget"]),
						alertDescription(h, [failureMessage(model.saveFailure)]),
					]),
		actions: [
			linkButton(h, { variant: "outline", href: budgetsHref() }, ["Cancel"]),
			button(
				h,
				{
					isDisabled: issues.length > 0,
					isLoading: model.isSaving,
					attributes: [h.OnClick(Message.ClickedSave())],
				},
				[model.editingId === null ? "Create budget" : "Save changes"],
			),
		],
	})
}

const BACK = { href: budgetsHref(), label: "Back to budgets" }

/** The session, or the API when the session could not say, refused the viewer. */
const isRefused = (model: Model): boolean =>
	accessOf(model) === "denied" || (model.saveFailure !== null && isForbidden(model.saveFailure))

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, _inputs, h) => {
	const isEdit = model.editingId !== null
	const header = {
		// An id that is not one is still a link to a budget, not the start of a new one.
		title: isEdit || model.isMissing ? "Edit budget" : "New budget",
		description:
			"Opens an alert incident when a slice of spend, or its forecast, reaches a percent of an amount.",
	}
	const loading = dashboardPage(h, header, [skeleton(h, "h-24 w-full"), skeleton(h, "h-80 w-full")])
	if (accessOf(model) === "unknown") return loading
	if (isRefused(model))
		return managersOnlyPage(h, {
			header,
			title: "Only org admins and engineers can create or change budgets",
			back: BACK,
		})
	if (model.isMissing)
		return dashboardPage(h, header, [
			resourceNotFound(h, {
				title: "Budget not found",
				description: "It may have been deleted. The list shows the ones the org has now.",
				back: BACK,
			}),
		])
	if (isEdit && AsyncData.isFailure(model.existing.data))
		return dashboardPage(h, header, [
			errorState(h, {
				failure: model.existing.data.error,
				title: "Couldn't load the budget",
				onRetry: Message.ClickedRetry(),
			}),
		])
	if (isEdit && Option.isNone(AsyncData.getData(model.existing.data))) return loading
	return dashboardPage(h, { ...header, fill: true }, [
		formScrollArea(h, [
			...(model.optionsFailure === null ? [] : [optionsNotice(h, model)]),
			formCard(
				h,
				[
					nameSection(h, model),
					scopeSection(h, model),
					amountSection(h, model),
					...Arr.map(SEVERITIES, (severity) => alertSection(h, model, severity)),
					enabledSection(h, model),
				],
				FORM_WIDTH,
			),
		]),
		actionBar(h, model),
	])
})
