import { applyLogsWhereClause } from "../../../lib/logs/advanced-filter-sync"
import { Option, type Result } from "effect"
import { AsyncData, Command, type Update } from "foldkit"
import * as Keyed from "@maple/views/data/keyed"
import type { LoadFailure } from "@maple/views/data/load-failure"
import { requestKey } from "@maple/views/data/request-key"
import * as Dialog from "@maple/views/ui/dialog"
import type { Resources } from "../../../platform/resources"
import type { PageContext, PageReturn } from "../../contract"
import { lookupField, type LookupNames, names } from "../../kit/autocomplete-lookups"
import { initWhereFields, type WhereFieldMessage } from "../../kit/where-field"
import { isFieldOpen, updateWhereFields, type WhereFieldSpec } from "../../kit/where-field-update"
import { ADVANCED_FIELD_ID, ADVANCED_TEXTAREA_ID, type AdvancedFilter } from "./advanced-model"
import { FetchResourceKeys } from "./command"
import { Message } from "./message"
import { navigate } from "./navigation"
import type { Model } from "./model"

// The advanced filter: a where clause edited in a dialog, applied into the URL params it sets.

type Return = PageReturn<Model, Message>
type Cmd = Command.Command<Message, never, Resources>

export const initAdvanced = (): AdvancedFilter => ({
	dialog: Dialog.init("logs-advanced-filter", "dialog"),
	draft: "",
	fields: initWhereFields(),
	resourceKeys: Keyed.idle(),
})

/** The dialog's field: the logs vocabulary, the facets' values and the window's attribute keys. */
export const specOf = (model: Model): WhereFieldSpec => {
	const facets = Option.getOrUndefined(AsyncData.getData(model.facets.data))
	const resourceKeys = Option.getOrUndefined(AsyncData.getData(model.advanced.resourceKeys.data))
	const window = model.window
	return {
		expression: model.advanced.draft,
		textareaId: ADVANCED_TEXTAREA_ID,
		dataSource: "logs",
		scope: "log_search",
		values: {
			services: names(facets?.services),
			severities: names(facets?.severities),
			environments: names(facets?.deploymentEnvs),
			namespaces: names(facets?.namespaces),
			attributeKeys: names(Option.getOrUndefined(AsyncData.getData(model.attributeKeys.data))),
			resourceAttributeKeys: [...lookupField(resourceKeys, "keys")],
		},
		// Resource attributes are shared across signals; log attribute values have no lookup.
		requestOf: (kind, attributeKey) =>
			kind === "resource" && window !== null
				? { _tag: "Resource", startTime: window.startTime, endTime: window.endTime, attributeKey }
				: null,
	}
}

const withAdvanced = (model: Model, patch: Partial<AdvancedFilter>): Model => ({
	...model,
	advanced: { ...model.advanced, ...patch },
})

const liftDialog = (
	model: Model,
	step: Update.ReturnWithOutMessage<Dialog.Model, Dialog.Message, Dialog.OutMessage>,
): { readonly model: Model; readonly commands: ReadonlyArray<Cmd> } => ({
	model: withAdvanced(model, { dialog: step.model }),
	commands: Command.mapMessages(step.commands ?? [], (message) =>
		Message.GotAdvancedDialogMessage({ message }),
	),
})

/** The `resource.*` keys over the list's window, once per window. */
const requestResourceKeys = (model: Model, context: PageContext) => {
	const window = model.window
	if (window === null) return { model, commands: [] }
	const key = requestKey(context.orgId, "autocomplete:resourceAttributeKeys", window)
	return Option.match(Keyed.request(model.advanced.resourceKeys, key, "Load"), {
		onNone: () => ({ model, commands: [] }),
		onSome: (resourceKeys) => ({
			model: withAdvanced(model, { resourceKeys }),
			commands: [FetchResourceKeys({ key, window })],
		}),
	})
}

/** The button or `F`: the dialog opens on the URL's clause. */
export const openedAdvanced = (model: Model, context: PageContext): Return => {
	if (model.advanced.dialog.isOpen) return { model }
	const draft = model.search.whereClause ?? ""
	const opened = liftDialog(
		withAdvanced(model, { draft, fields: initWhereFields() }),
		Dialog.open(model.advanced.dialog),
	)
	const keys = requestResourceKeys(opened.model, context)
	return { model: keys.model, commands: [...opened.commands, ...keys.commands] }
}

/** The clause (and the params it sets) into the URL; the sidebar's search box follows `body`. */
const applied = (model: Model, clause: string): Return => {
	const closed = liftDialog(model, Dialog.close(model.advanced.dialog))
	const search = applyLogsWhereClause(model.search, clause)
	return {
		...navigate({ ...closed.model, searchText: search.search ?? "" }, search),
		commands: closed.commands,
	}
}

const whereFieldStep = (model: Model, message: WhereFieldMessage, context: PageContext): Return => {
	const spec = specOf(model)
	// Enter with no list open applies the filter: the clause is one line.
	if (message._tag === "PressedEnter" && !isFieldOpen(model.advanced.fields, ADVANCED_FIELD_ID, spec))
		return applied(model, model.advanced.draft)
	const step = updateWhereFields(model.advanced.fields, message, {
		specOf: (fieldId) => (fieldId === ADVANCED_FIELD_ID ? spec : undefined),
		orgId: context.orgId,
	})
	// An applied suggestion changes the text as typing would.
	const draft = step.change === undefined ? model.advanced.draft : step.change.expression
	return {
		model: withAdvanced(model, { fields: step.fields, draft }),
		commands: Command.mapMessages(step.commands ?? [], (inner) =>
			Message.GotWhereFieldMessage({ message: inner }),
		),
	}
}

export const advancedHandlers = (model: Model, context: PageContext) => ({
	ClickedAdvancedFilter: (): Return => openedAdvanced(model, context),
	GotAdvancedDialogMessage: ({ message }: { readonly message: Dialog.Message }): Return =>
		liftDialog(model, Dialog.update(model.advanced.dialog, message)),
	ChangedAdvancedDraft: ({ value }: { readonly value: string }): Return => ({
		model: withAdvanced(model, { draft: value }),
	}),
	GotWhereFieldMessage: ({ message }: { readonly message: WhereFieldMessage }): Return =>
		whereFieldStep(model, message, context),
	SubmittedAdvanced: (): Return => applied(model, model.advanced.draft),
	ClickedClearAdvanced: (): Return => applied(withAdvanced(model, { draft: "" }), ""),
	ClickedClearWhereClause: (): Return => applied(model, ""),
	CompletedFetchResourceKeys: ({
		key,
		result,
	}: {
		readonly key: string
		readonly result: Result.Result<LookupNames, LoadFailure>
	}): Return => ({
		model: withAdvanced(model, { resourceKeys: Keyed.accept(model.advanced.resourceKeys, key, result) }),
	}),
})
