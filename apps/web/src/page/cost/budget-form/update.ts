import { AlertDestinationId, AlertRuleId, type AlertSeverity } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import * as Keyed from "@maple/views/data/keyed"
import { requestKey } from "@maple/views/data/request-key"
import * as Menu from "@maple/views/ui/menu"
import { Array as Arr, Option, Result, Schema } from "effect"
import { AsyncData, Command as FoldkitCommand } from "foldkit"
import { isClerkAuthEnabled } from "../../../platform/auth-mode"
import type { AppRoute } from "../../../route"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { pickedDestination } from "../../kit/destination-picker"
import { chain, slotStep } from "../../kit/keyed-step"
import { acceptGrants } from "../../kit/session-grants"
import { budgetsHref } from "../kit/budget-format"
import { FetchBudgetFormOptions, FetchExistingBudget, ReadBudgetFormGrants, SaveBudget } from "./command"
import { formFromBudget, formFromSearch, formIssues, scopeItemOf, wirePayload } from "./derive"
import type { AlertForm, Form } from "./form"
import { isAwaitingOptions, Message, type Model } from "./model"

type Return = PageReturn<Model, Message>

type CostBudgetNewRoute = Extract<AppRoute, { readonly _tag: "CostBudgetNew" }>

const SCOPE_MENU_ID = "cost-budget-scope"
const DESTINATION_MENU_IDS = {
	warning: "cost-budget-destinations-warning",
	critical: "cost-budget-destinations-critical",
} as const satisfies Record<AlertSeverity, string>

const decodeRuleId = Schema.decodeUnknownOption(AlertRuleId)
const decodeDestinationId = Schema.decodeUnknownOption(AlertDestinationId)

/** The edited budget's read. Every member may read a budget, so it does not wait on the session. */
const readExisting = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return => {
	const id = model.editingId
	return id === null
		? { model }
		: slotStep(
				model,
				model.existing,
				(existing) => ({ existing }),
				requestKey(context.orgId, "costBudgets.get", { id }),
				mode,
				(key) => FetchExistingBudget({ key, id }),
			)
}

/**
 * Entering the editor. `sessionDecides`: the hosted product, where the session says whether the
 * viewer may write budgets. Self-hosted has one role, which may.
 */
export const enter = (route: CostBudgetNewRoute, context: PageContext, sessionDecides: boolean): Return => {
	const named = route.search.budgetId
	const editingId = named === undefined ? null : Option.getOrNull(decodeRuleId(named))
	const model: Model = {
		search: route.search,
		editingId,
		isMissing: named !== undefined && editingId === null,
		existing: Keyed.idle(),
		options: null,
		optionsFailure: null,
		form: formFromSearch(route.search),
		isSaving: false,
		saveFailure: null,
		destinations: null,
		scopeMenu: Menu.init(SCOPE_MENU_ID),
		destinationMenus: {
			warning: Menu.init(DESTINATION_MENU_IDS.warning),
			critical: Menu.init(DESTINATION_MENU_IDS.critical),
		},
		grants: sessionDecides ? [] : Policy.allPermissions,
		isGrantsRead: !sessionDecides,
	}
	return chain<Model, Message>(
		{
			model,
			commands: [
				...(sessionDecides ? [ReadBudgetFormGrants({ orgId: context.orgId })] : []),
				FetchBudgetFormOptions(),
			],
		},
		(entered) => readExisting(entered, context, "Load"),
	)
}

export const init = (route: CostBudgetNewRoute, context: PageContext): Return =>
	enter(route, context, isClerkAuthEnabled)

// A change answers the server's last refusal: its message is about the form as it was.
const withForm = (model: Model, patch: Partial<Form>): Return => ({
	model: { ...model, form: { ...model.form, ...patch }, saveFailure: null },
})

const withAlert = (model: Model, severity: AlertSeverity, patch: Partial<AlertForm>): Return =>
	withForm(model, {
		alerts: { ...model.form.alerts, [severity]: { ...model.form.alerts[severity], ...patch } },
	})

/** The "Add filter" menu: a pick of a value adds it to its dimension. */
const updateScopeMenu = (model: Model, message: Menu.Message): Return => {
	const result = Menu.update(model.scopeMenu, message)
	const commands = FoldkitCommand.mapMessages(result.commands ?? [], (child) =>
		Message.GotScopeMenuMessage({ message: child }),
	)
	const next: Model = { ...model, scopeMenu: result.model }
	const picked =
		result.outMessage?._tag === "SelectedItem" ? scopeItemOf(result.outMessage.value) : Option.none()
	return Option.match(picked, {
		onNone: () => ({ model: next, commands }),
		onSome: ({ dimension, value }) => {
			const values = next.form.scope[dimension]
			return Arr.contains(values, value)
				? { model: next, commands }
				: {
						...withForm(next, { scope: { ...next.form.scope, [dimension]: [...values, value] } }),
						commands,
					}
		},
	})
}

/** An alert's "Add destination" menu: a pick of a synced destination adds it. */
const updateDestinationMenu = (model: Model, severity: AlertSeverity, message: Menu.Message): Return => {
	const result = Menu.update(model.destinationMenus[severity], message)
	const commands = FoldkitCommand.mapMessages(result.commands ?? [], (child) =>
		Message.GotDestinationMenuMessage({ severity, message: child }),
	)
	const next: Model = {
		...model,
		destinationMenus: { ...model.destinationMenus, [severity]: result.model },
	}
	const ids = model.form.alerts[severity].destinationIds
	return Option.match(
		Option.flatMap(pickedDestination(result.outMessage, model.destinations, ids), decodeDestinationId),
		{
			onNone: () => ({ model: next, commands }),
			onSome: (id) => ({ ...withAlert(next, severity, { destinationIds: [...ids, id] }), commands }),
		},
	)
}

const save = (model: Model): Return =>
	model.isSaving || model.isMissing || isAwaitingOptions(model) || formIssues(model.form).length > 0
		? { model }
		: Option.match(wirePayload(model.form), {
				onNone: (): Return => ({ model }),
				onSome: (payload): Return => ({
					model: { ...model, isSaving: true, saveFailure: null },
					commands: [SaveBudget({ editingId: model.editingId, payload })],
				}),
			})

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedReadGrants: (answer) => ({
			model: acceptGrants(model, context.orgId, answer, { isGrantsRead: true }),
		}),
		CompletedFetchExisting: ({ key, result }) => {
			const existing = Keyed.accept(model.existing, key, result)
			if (existing === model.existing) return { model }
			return AsyncData.matchData(existing.data, {
				onEmpty: (): Return => ({ model: { ...model, existing } }),
				// An id the org has no budget for reads as missing, not as an error to retry.
				onFailure: (failure): Return => ({
					model: { ...model, existing, isMissing: failure.code === "cost_budget_not_found" },
				}),
				onData: (budget): Return => ({ model: { ...model, existing, form: formFromBudget(budget) } }),
			})
		},
		CompletedFetchOptions: ({ result }) =>
			Result.match(result, {
				// A new budget starts in the currency most of the org's cost is in.
				onSuccess: (options): Return => ({
					model: {
						...model,
						options,
						optionsFailure: null,
						form:
							model.editingId === null && options.currency !== ""
								? { ...model.form, currency: options.currency }
								: model.form,
					},
				}),
				// The form still works on what it holds, and says the currency is not the org's.
				onFailure: (optionsFailure): Return => ({ model: { ...model, optionsFailure } }),
			}),
		ClickedRetry: () => readExisting(model, context, "Refresh"),
		ClickedRetryOptions: () => ({
			model: { ...model, optionsFailure: null },
			commands: [FetchBudgetFormOptions()],
		}),
		UpdatedDestinations: ({ orgId, rows }) =>
			orgId === context.orgId ? { model: { ...model, destinations: rows } } : { model },
		ChangedText: ({ field, value }) => withForm(model, { [field]: value }),
		PickedCurrency: ({ currency }) => withForm(model, { currency }),
		PickedPeriod: ({ period }) => withForm(model, { period }),
		RemovedScope: ({ dimension, value }) =>
			withForm(model, {
				scope: {
					...model.form.scope,
					[dimension]: Arr.filter(model.form.scope[dimension], (existing) => existing !== value),
				},
			}),
		GotScopeMenuMessage: ({ message: child }) => updateScopeMenu(model, child),
		ToggledAlert: ({ severity }) =>
			withAlert(model, severity, { isOn: !model.form.alerts[severity].isOn }),
		ChangedPercent: ({ severity, value }) => withAlert(model, severity, { percent: value }),
		PickedBasis: ({ severity, basis }) => withAlert(model, severity, { basis }),
		RemovedDestination: ({ severity, id }) =>
			withAlert(model, severity, {
				destinationIds: Arr.filter(
					model.form.alerts[severity].destinationIds,
					(existing) => existing !== id,
				),
			}),
		GotDestinationMenuMessage: ({ severity, message: child }) =>
			updateDestinationMenu(model, severity, child),
		ToggledEnabled: () => withForm(model, { enabled: !model.form.enabled }),
		ClickedSave: () => save(model),
		CompletedSave: ({ result }) =>
			Result.match(result, {
				// The form takes the API's answer, and the list is read again on arrival.
				onSuccess: (saved): Return => ({
					model: { ...model, isSaving: false, form: formFromBudget(saved) },
					outMessage: PageOutMessage.RequestedNavigation({
						url: budgetsHref(),
						isReplace: true,
						toast: {
							type: "success",
							title: model.editingId === null ? "Budget created" : "Changes saved",
							description: "",
						},
					}),
				}),
				// Inline above the action bar, in the server's words: a taken name, the cap.
				onFailure: (saveFailure): Return => ({ model: { ...model, isSaving: false, saveFailure } }),
			}),
	})
