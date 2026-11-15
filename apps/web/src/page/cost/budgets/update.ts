import type { AlertRuleId, CostBudgetStatus } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import * as Keyed from "@maple/views/data/keyed"
import type { LoadFailure } from "@maple/views/data/load-failure"
import { requestKey } from "@maple/views/data/request-key"
import * as Dialog from "@maple/views/ui/dialog"
import { Array as Arr, Option, Result } from "effect"
import { Command as FoldkitCommand } from "foldkit"
import { isClerkAuthEnabled } from "../../../platform/auth-mode"
import type { AppRoute } from "../../../route"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { chain, slotStep } from "../../kit/keyed-step"
import { acceptGrants } from "../../kit/session-grants"
import { budgetFormHref } from "../kit/budget-format"
import {
	DeleteBudget,
	FetchBudgetSources,
	FetchBudgets,
	ReadBudgetsGrants,
	SaveBudgetEnabled,
} from "./command"
import { budgetById, budgetsOf } from "./derive"
import { Message, type Model } from "./model"

type Return = PageReturn<Model, Message>

type CostBudgetsRoute = Extract<AppRoute, { readonly _tag: "CostBudgets" }>

export const DELETE_DIALOG_ID = "cost-budget-delete"

const keyOf = (context: PageContext) => requestKey(context.orgId, "costBudgets.list", {})

/** The list: every member may read it, so it is asked for whatever the session says. */
const readList = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return =>
	slotStep(
		model,
		model.list,
		(list) => ({ list }),
		keyOf(context),
		mode,
		(key) => FetchBudgets({ key }),
	)

/**
 * Entering the page. `sessionDecides`: the hosted product, where the session says whether the
 * viewer may change budgets. Self-hosted has one role, which may.
 */
export const enter = (context: PageContext, sessionDecides: boolean): Return => {
	const model: Model = {
		grants: sessionDecides ? [] : Policy.allPermissions,
		isGrantsRead: !sessionDecides,
		list: Keyed.idle(),
		sources: [],
		togglingIds: [],
		confirmDeleteId: null,
		deletingId: null,
		deleteDialog: Dialog.init(DELETE_DIALOG_ID, "alert-dialog"),
	}
	return chain<Model, Message>(
		{
			model,
			commands: [
				...(sessionDecides ? [ReadBudgetsGrants({ orgId: context.orgId })] : []),
				FetchBudgetSources({ orgId: context.orgId }),
			],
		},
		(entered) => readList(entered, context, "Load"),
	)
}

export const init = (_route: CostBudgetsRoute, context: PageContext): Return =>
	enter(context, isClerkAuthEnabled)

const errorToast = (title: string, failure: LoadFailure): PageOutMessage =>
	PageOutMessage.RequestedToast({ type: "error", title, description: failure.message })

/** The list with `change` applied to the rows on screen: what the API answered, never a guess. */
const withRows = (
	model: Model,
	change: (rows: ReadonlyArray<CostBudgetStatus>) => ReadonlyArray<CostBudgetStatus>,
): Model => {
	const rows = budgetsOf(model)
	return rows === null || model.list.key === null
		? model
		: {
				...model,
				list: Keyed.accept(model.list, model.list.key, Result.succeed({ budgets: change(rows) })),
			}
}

const withoutId = (ids: ReadonlyArray<AlertRuleId>, id: AlertRuleId): ReadonlyArray<AlertRuleId> =>
	Arr.filter(ids, (existing) => existing !== id)

/** The switch saves at once; it stays where it was until the API says what is stored. */
const toggle = (model: Model, id: AlertRuleId): Return =>
	Option.match(budgetById(model, id), {
		onNone: (): Return => ({ model }),
		onSome: (budget): Return =>
			Arr.contains(model.togglingIds, id)
				? { model }
				: {
						model: { ...model, togglingIds: [...model.togglingIds, id] },
						commands: [SaveBudgetEnabled({ id, enabled: !budget.enabled })],
					},
	})

const stepDeleteDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: {
		...model,
		deleteDialog: step.model,
		confirmDeleteId: step.outMessage?._tag === "Closed" ? null : model.confirmDeleteId,
	},
	commands: FoldkitCommand.mapMessages(step.commands ?? [], (message) =>
		Message.GotDeleteDialogMessage({ message }),
	),
})

const confirmDelete = (model: Model): Return =>
	model.confirmDeleteId === null || model.deletingId !== null
		? { model }
		: {
				model: { ...model, deletingId: model.confirmDeleteId },
				commands: [DeleteBudget({ id: model.confirmDeleteId })],
			}

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedReadGrants: (answer) => ({
			model: acceptGrants(model, context.orgId, answer, { isGrantsRead: true }),
		}),
		CompletedFetchBudgets: ({ key, result }) => ({
			model: { ...model, list: Keyed.accept(model.list, key, result) },
		}),
		CompletedFetchSources: ({ orgId, sources }) =>
			orgId === context.orgId ? { model: { ...model, sources } } : { model },
		ClickedRetry: () => readList(model, context, "Refresh"),
		ClickedEdit: ({ id }) => ({
			model,
			outMessage: PageOutMessage.RequestedNavigation({
				url: budgetFormHref({ budgetId: id }),
				isReplace: false,
			}),
		}),
		ToggledBudget: ({ id }) => toggle(model, id),
		CompletedToggle: ({ id, result }) => {
			const settled = { ...model, togglingIds: withoutId(model.togglingIds, id) }
			return Result.match(result, {
				// The switch shows what was stored at once. The answer carries no standing, and may
				// carry what another manager changed since the list was read, so the list is read
				// again, past any read sent before this write.
				onSuccess: (saved): Return =>
					readList(
						withRows(settled, (rows) =>
							Arr.map(rows, (row) =>
								row.id === saved.id ? { ...saved, progress: row.progress } : row,
							),
						),
						context,
						"Supersede",
					),
				onFailure: (failure): Return => ({
					model: settled,
					outMessage: errorToast("Couldn't update the budget", failure),
				}),
			})
		},
		ClickedDelete: ({ id }) =>
			Option.match(budgetById(model, id), {
				onNone: (): Return => ({ model }),
				onSome: (): Return =>
					stepDeleteDialog({ ...model, confirmDeleteId: id }, Dialog.open(model.deleteDialog)),
			}),
		GotDeleteDialogMessage: ({ message: child }) =>
			// A delete in flight keeps its dialog: closing it would hide whether it went through.
			model.deletingId !== null
				? { model }
				: stepDeleteDialog(model, Dialog.update(model.deleteDialog, child)),
		ClickedConfirmDelete: () => confirmDelete(model),
		CompletedDelete: ({ result }) => {
			const settled = { ...model, deletingId: null }
			return Result.match(result, {
				onSuccess: (deleted): Return => {
					const closed = stepDeleteDialog(settled, Dialog.close(settled.deleteDialog))
					return {
						...closed,
						model: withRows(closed.model, (rows) =>
							Arr.filter(rows, (row) => row.id !== deleted.id),
						),
						outMessage: PageOutMessage.RequestedToast({
							type: "success",
							title: "Budget deleted",
							description: "",
						}),
					}
				},
				onFailure: (failure): Return => ({
					model: settled,
					outMessage: errorToast("Couldn't delete the budget", failure),
				}),
			})
		},
	})
