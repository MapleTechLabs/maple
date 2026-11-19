import { OrgId } from "@maple/domain"
import { CloudCostPersistenceError } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { Array as Arr, Effect, Option, Result, Schema, String as Str } from "effect"
import { Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import * as FormPage from "../page/cost/budget-form/model"
import * as FormUpdate from "../page/cost/budget-form/update"
import { view as formView } from "../page/cost/budget-form/view"
import * as ListPage from "../page/cost/budgets/model"
import * as ListUpdate from "../page/cost/budgets/update"
import { view as listView } from "../page/cost/budgets/view"
import type { PageContext } from "../page/contract"
import type { Resources } from "../platform/resources"
import { AppRoute } from "../route"
import type { CostBudgetNewSearch } from "../route/search"
import { budgetDestinationsOf, budgetFormOptions, budgetsOf, noBudgets } from "./cost-budgets-fixture"
import { keepLocal } from "./local-commands"

// `/lab/cost-budgets`: the Budgets list and the budget editor over fixtures. `?state=` picks one.

export const LabState = Schema.Literals([
	"list",
	"empty",
	"loading",
	"error",
	"viewer",
	"delete",
	"form-new",
	"form-prefilled",
	"form-edit",
	"form-invalid",
	"form-options-failed",
	"form-denied",
])
export type LabState = typeof LabState.Type

export const Flags = Schema.Struct({ state: LabState })
export type Flags = typeof Flags.Type

export const flags: Effect.Effect<Flags> = Effect.sync(() => ({
	state: Option.getOrElse(
		Schema.decodeUnknownOption(LabState)(new URLSearchParams(window.location.search).get("state")),
		(): LabState => "list",
	),
}))

export const Model = Schema.Struct({
	state: LabState,
	list: Schema.NullOr(ListPage.Model),
	form: Schema.NullOr(FormPage.Model),
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	GotListMessage: { message: ListPage.Message },
	GotFormMessage: { message: FormPage.Message },
})
export type Message = typeof Message.Type

type Return = Update.Return<Model, Message, Resources>

const ORG = "org_acme"
const CONTEXT: PageContext = {
	orgId: Schema.decodeSync(OrgId)(ORG),
	pinnedNamespace: null,
	timeZone: "Europe/Berlin",
}
/** Mid November: fifteen complete days of the month have passed. */
const NOW = Date.UTC(2026, 10, 16, 10, 0)
const ENGINEER = Policy.grantsOf(["org:engineer"])
const MEMBER = Policy.grantsOf(["org:member"])

const BUDGETS = budgetsOf(NOW)

type Step<PageModel, PageMessage> = Readonly<{
	model: PageModel
	commands: ReadonlyArray<Command.Command<PageMessage, never, Resources>>
}>

/** Runs messages through a page, keeping only its local commands (a dialog's open animation). */
const fold = <PageModel, PageMessage>(
	start: PageModel,
	step: (
		model: PageModel,
		message: PageMessage,
	) => Readonly<{
		model: PageModel
		commands?: ReadonlyArray<Command.Command<PageMessage, never, Resources>>
	}>,
	messages: ReadonlyArray<(model: PageModel) => PageMessage>,
): Step<PageModel, PageMessage> =>
	Arr.reduce<(model: PageModel) => PageMessage, Step<PageModel, PageMessage>>(
		messages,
		{ model: start, commands: [] },
		(current, toMessage) => {
			const next = step(current.model, toMessage(current.model))
			return { model: next.model, commands: [...current.commands, ...keepLocal(next.commands)] }
		},
	)

const listStep = (model: ListPage.Model, message: ListPage.Message) =>
	ListUpdate.update(model, message, CONTEXT)
const formStep = (model: FormPage.Model, message: FormPage.Message) =>
	FormUpdate.update(model, message, CONTEXT)

const listFor = (state: LabState): Step<ListPage.Model, ListPage.Message> => {
	const entered = ListUpdate.enter(CONTEXT, true).model
	const grants = () =>
		ListPage.Message.CompletedReadGrants({ orgId: ORG, grants: state === "viewer" ? MEMBER : ENGINEER })
	const answered = (model: ListPage.Model) =>
		ListPage.Message.CompletedFetchBudgets({
			key: model.list.key ?? "",
			result:
				state === "error"
					? Result.fail(
							toLoadFailure(
								new CloudCostPersistenceError({ message: "Cost could not be read" }),
							),
						)
					: Result.succeed(state === "empty" ? noBudgets : BUDGETS),
		})
	return fold(entered, listStep, [
		grants,
		...(state === "loading" ? [] : [answered]),
		...Arr.map(
			state === "delete" ? Arr.take(BUDGETS.budgets, 1) : [],
			(budget) => () => ListPage.Message.ClickedDelete({ id: budget.id }),
		),
	])
}

const searchFor = (state: LabState): CostBudgetNewSearch =>
	state === "form-edit"
		? { budgetId: BUDGETS.budgets[1]?.id }
		: state === "form-prefilled"
			? { provider: ["aws"], region: ["us-east-1"] }
			: {}

const formFor = (state: LabState): Step<FormPage.Model, FormPage.Message> => {
	const entered = FormUpdate.enter(
		AppRoute.CostBudgetNew({ search: searchFor(state) }),
		CONTEXT,
		true,
	).model
	const edited = BUDGETS.budgets[1]
	return fold(entered, formStep, [
		() =>
			FormPage.Message.CompletedReadGrants({
				orgId: ORG,
				grants: state === "form-denied" ? MEMBER : ENGINEER,
			}),
		() => FormPage.Message.UpdatedDestinations({ orgId: ORG, rows: [...budgetDestinationsOf(ORG, NOW)] }),
		() =>
			FormPage.Message.CompletedFetchOptions({
				result:
					state === "form-options-failed"
						? Result.fail(
								toLoadFailure(
									new CloudCostPersistenceError({ message: "Cost could not be read" }),
								),
							)
						: Result.succeed(budgetFormOptions),
			}),
		...(state === "form-edit" && edited !== undefined
			? [
					(model: FormPage.Model) =>
						FormPage.Message.CompletedFetchExisting({
							key: model.existing.key ?? "",
							result: Result.succeed(edited),
						}),
				]
			: []),
		...(state === "form-prefilled"
			? [
					() => FormPage.Message.ChangedText({ field: "name", value: "AWS us-east-1" }),
					() => FormPage.Message.ChangedText({ field: "amount", value: "4000" }),
				]
			: []),
		...(state === "form-invalid"
			? [
					() => FormPage.Message.ChangedText({ field: "amount", value: "-20" }),
					() => FormPage.Message.ChangedPercent({ severity: "warning", value: "0" }),
					() => FormPage.Message.ToggledAlert({ severity: "critical" }),
				]
			: []),
	])
}

const isFormState = (state: LabState): boolean => Str.startsWith("form-")(state)

export const init = (flags: Flags): Return => {
	if (isFormState(flags.state)) {
		const form = formFor(flags.state)
		return {
			model: { state: flags.state, list: null, form: form.model },
			commands: Command.mapMessages(form.commands, (message) => Message.GotFormMessage({ message })),
		}
	}
	const list = listFor(flags.state)
	return {
		model: { state: flags.state, list: list.model, form: null },
		commands: Command.mapMessages(list.commands, (message) => Message.GotListMessage({ message })),
	}
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotListMessage: ({ message: child }) => {
			if (model.list === null) return { model }
			const next = listStep(model.list, child)
			return {
				model: { ...model, list: next.model },
				commands: Command.mapMessages(keepLocal(next.commands), (inner) =>
					Message.GotListMessage({ message: inner }),
				),
			}
		},
		GotFormMessage: ({ message: child }) => {
			if (model.form === null) return { model }
			const next = formStep(model.form, child)
			return {
				model: { ...model, form: next.model },
				commands: Command.mapMessages(keepLocal(next.commands), (inner) =>
					Message.GotFormMessage({ message: inner }),
				),
			}
		},
	})

export const breadcrumbs = (model: Model) => [
	{ label: "Cloud cost", href: "/cost" },
	...(model.form === null
		? [{ label: "Budgets", isPageHeading: true }]
		: [
				{ label: "Budgets", href: "/cost/budgets" },
				{ label: model.form.editingId === null ? "New budget" : "Edit budget", isPageHeading: true },
			]),
]

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	model.form !== null
		? h.submodel({
				slotId: "lab-cost-budget-form",
				model: model.form,
				view: formView,
				viewInputs: { context: CONTEXT },
				toParentMessage: (message: FormPage.Message) => Message.GotFormMessage({ message }),
			})
		: model.list !== null
			? h.submodel({
					slotId: "lab-cost-budgets",
					model: model.list,
					view: listView,
					viewInputs: { context: CONTEXT },
					toParentMessage: (message: ListPage.Message) => Message.GotListMessage({ message }),
				})
			: h.empty
