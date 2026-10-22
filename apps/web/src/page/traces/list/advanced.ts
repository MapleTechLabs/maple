import {
	applyWhereClauseSuggestion,
	getWhereClauseAutocomplete,
	type WhereClauseAutocompleteResult,
} from "../../../lib/query-builder/where-clause-autocomplete"
import { applyWhereClause, type TracesSearchLike } from "../../../lib/traces/advanced-filter-sync"
import { Option, type Result } from "effect"
import { AsyncData, Command, type Update } from "foldkit"
import * as Keyed from "../../../data/keyed"
import type { LoadFailure } from "../../../data/load-failure"
import { requestKey } from "../../../data/request-key"
import type { Resources } from "../../../platform/resources"
import { AppRoute, hrefOf } from "../../../route"
import * as Dialog from "../../../ui/dialog"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { type AutocompleteLookup, lookupField, type LookupNames } from "../../kit/autocomplete-lookups"
import { ADVANCED_LOOKUPS, type AdvancedFilter } from "./advanced-model"
import { FetchAdvancedLookup, PlaceAdvancedCursor } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { clearedWhereClause } from "./search-edits"

// `AdvancedFilterDialog`: open, edit with `useWhereClauseAutocomplete`, apply or clear.

type Return = PageReturn<Model, Message>
type Search = Model["search"]
type Cmd = Command.Command<Message, never, Resources>

const MAX_SUGGESTIONS = 20

const lookupNames = (model: Model, name: AutocompleteLookup): Array<string> => [
	...lookupField(Option.getOrUndefined(AsyncData.getData(model.advanced.lookups[name]?.data ?? AsyncData.Idle())), "keys"),
]

/** The `traces` values the provider hands the editor. */
const valuesOf = (model: Model) => {
	const facets = Option.getOrNull(AsyncData.getData(model.facets.data))
	const names = (rows: ReadonlyArray<{ readonly name: string }> | undefined) =>
		(rows ?? []).map((row) => row.name)
	return {
		services: names(facets?.services),
		spanNames: names(facets?.spanNames),
		environments: names(facets?.deploymentEnvs),
		httpMethods: names(facets?.httpMethods),
		httpStatusCodes: names(facets?.httpStatusCodes),
		attributeKeys: lookupNames(model, "spanAttributeKeys"),
		attributeValues: [],
		resourceAttributeKeys: lookupNames(model, "resourceAttributeKeys"),
		resourceAttributeValues: [],
	}
}

export const autocompleteOf = (model: Model): WhereClauseAutocompleteResult =>
	getWhereClauseAutocomplete({
		expression: model.advanced.draft,
		cursor: model.advanced.cursor,
		dataSource: "traces",
		values: valuesOf(model),
		scope: "trace_search",
		maxSuggestions: MAX_SUGGESTIONS,
	})

export const isSuggesting = (model: Model): boolean =>
	model.advanced.isFocused && !model.advanced.isDismissed && autocompleteOf(model).suggestions.length > 0

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

/** `activate()`: the provider's lookups, once per window. */
const activate = (
	model: Model,
	context: PageContext,
): { readonly model: Model; readonly commands: ReadonlyArray<Cmd> } => {
	const window = model.window
	if (window === null) return { model, commands: [] }
	return ADVANCED_LOOKUPS.reduce<{ model: Model; commands: ReadonlyArray<Cmd> }>(
		(acc, lookup) => {
			const key = requestKey(context.orgId, `autocomplete:${lookup}`, window)
			const slot =
				acc.model.advanced.lookups[lookup] ?? Keyed.idle<LookupNames, LoadFailure>()
			return Option.match(Keyed.request(slot, key, "Load"), {
				onNone: () => acc,
				onSome: (next) => ({
					model: withAdvanced(acc.model, {
						lookups: { ...acc.model.advanced.lookups, [lookup]: next },
					}),
					commands: [...acc.commands, FetchAdvancedLookup({ key, lookup, window })],
				}),
			})
		},
		{ model, commands: [] },
	)
}

/** The button or `F`: the dialog opens on the URL's clause and the lookups start. */
export const openedAdvanced = (model: Model, context: PageContext): Return => {
	if (model.advanced.dialog.isOpen) return { model }
	const draft = model.search.whereClause ?? ""
	const opened = liftDialog(
		withAdvanced(model, { draft, cursor: draft.length, isDismissed: false, activeIndex: 0 }),
		Dialog.open(model.advanced.dialog),
	)
	const activated = activate(opened.model, context)
	return { model: activated.model, commands: [...opened.commands, ...activated.commands] }
}

export const advancedDialogStep = (model: Model, message: Dialog.Message): Return => {
	const step = liftDialog(model, Dialog.update(model.advanced.dialog, message))
	return { model: step.model, commands: step.commands }
}

const navigate = (model: Model, search: Search): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({
		url: hrefOf(AppRoute.Traces({ search })),
		isReplace: false,
	}),
})

const copy = (values: ReadonlyArray<string> | undefined) => (values === undefined ? undefined : [...values])

/** The URL's filters as `applyWhereClause` reads them (its arrays are mutable). */
const asSearchLike = (search: Search): TracesSearchLike => ({
	...search,
	services: copy(search.services),
	spanNames: copy(search.spanNames),
	httpMethods: copy(search.httpMethods),
	httpStatusCodes: copy(search.httpStatusCodes),
	deploymentEnvs: copy(search.deploymentEnvs),
	namespaces: copy(search.namespaces),
	excludedServices: copy(search.excludedServices),
	excludedSpanNames: copy(search.excludedSpanNames),
	excludedDeploymentEnvs: copy(search.excludedDeploymentEnvs),
	excludedNamespaces: copy(search.excludedNamespaces),
	excludedHttpMethods: copy(search.excludedHttpMethods),
	excludedHttpStatusCodes: copy(search.excludedHttpStatusCodes),
})

/** `applyWhereClause`: every param a clause can own is replaced by what this clause (and the rest) sets. */
const withClause = (search: Search, clause: string): Search => {
	const next = applyWhereClause(asSearchLike(search), clause)
	return {
		...clearedWhereClause(search),
		whereClause: next.whereClause,
		services: next.services,
		spanNames: next.spanNames,
		hasError: next.hasError,
		minDurationMs: next.minDurationMs,
		maxDurationMs: next.maxDurationMs,
		httpMethods: next.httpMethods,
		httpStatusCodes: next.httpStatusCodes,
		deploymentEnvs: next.deploymentEnvs,
		namespaces: next.namespaces,
		rootOnly: next.rootOnly,
		attributeFilters: next.attributeFilters,
		resourceAttributeFilters: next.resourceAttributeFilters,
		serviceMatchMode: next.serviceMatchMode,
		spanNameMatchMode: next.spanNameMatchMode,
		deploymentEnvMatchMode: next.deploymentEnvMatchMode,
		namespaceMatchMode: next.namespaceMatchMode,
		excludedServices: next.excludedServices,
		excludedSpanNames: next.excludedSpanNames,
		excludedDeploymentEnvs: next.excludedDeploymentEnvs,
		excludedNamespaces: next.excludedNamespaces,
		excludedHttpMethods: next.excludedHttpMethods,
		excludedHttpStatusCodes: next.excludedHttpStatusCodes,
	}
}

/** `onApply`: the clause (and the params it sets) into the URL; the dialog closes. */
const applied = (model: Model, clause: string): Return => {
	const closed = liftDialog(model, Dialog.close(model.advanced.dialog))
	return { ...navigate(closed.model, withClause(model.search, clause)), commands: closed.commands }
}

export const submittedAdvanced = (model: Model): Return => applied(model, model.advanced.draft)

export const clearedAdvanced = (model: Model): Return => applied(withAdvanced(model, { draft: "" }), "")

const applySuggestion = (model: Model, index: number): Return => {
	const autocomplete = autocompleteOf(model)
	const suggestion = autocomplete.suggestions[index]
	if (suggestion === undefined) return { model }
	const result = applyWhereClauseSuggestion({
		expression: model.advanced.draft,
		context: autocomplete.context,
		replaceStart: autocomplete.replaceStart,
		replaceEnd: autocomplete.replaceEnd,
		suggestion,
	})
	return {
		model: withAdvanced(model, { draft: result.expression, cursor: result.cursor, isDismissed: false }),
		commands: [PlaceAdvancedCursor({ cursor: result.cursor })],
	}
}

export const advancedHandlers = (model: Model) => ({
	EditedAdvanced: ({ value, cursor }: { readonly value: string; readonly cursor: number }): Return => ({
		model: withAdvanced(model, { draft: value, cursor, isDismissed: false, activeIndex: 0 }),
	}),
	FocusedAdvanced: ({ cursor }: { readonly cursor: number }): Return => ({
		model: withAdvanced(model, { isFocused: true, isDismissed: false, cursor }),
	}),
	BlurredAdvanced: (): Return => ({ model: withAdvanced(model, { isFocused: false }) }),
	MovedAdvancedCursor: ({ cursor }: { readonly cursor: number }): Return => ({
		model: withAdvanced(model, { cursor, isDismissed: false, activeIndex: 0 }),
	}),
	PressedAdvancedKey: ({ key }: { readonly key: string }): Return => {
		const count = autocompleteOf(model).suggestions.length
		if (count === 0) return { model }
		switch (key) {
			case "ArrowDown":
				return {
					model: withAdvanced(model, { activeIndex: (model.advanced.activeIndex + 1) % count }),
				}
			case "ArrowUp":
				return {
					model: withAdvanced(model, {
						activeIndex: (model.advanced.activeIndex - 1 + count) % count,
					}),
				}
			case "Escape":
				return { model: withAdvanced(model, { isDismissed: true }) }
			case "Enter":
			case "Tab":
				return applySuggestion(model, model.advanced.activeIndex)
			default:
				return { model }
		}
	},
	ClickedAdvancedSuggestion: ({ index }: { readonly index: number }): Return =>
		applySuggestion(model, index),
	SubmittedAdvanced: (): Return => submittedAdvanced(model),
	ClickedClearAdvanced: (): Return => clearedAdvanced(model),
	CompletedAdvancedLookup: ({
		key,
		lookup,
		result,
	}: {
		readonly key: string
		readonly lookup: AutocompleteLookup
		readonly result: Result.Result<LookupNames, LoadFailure>
	}): Return => {
		const slot = model.advanced.lookups[lookup]
		return slot === undefined
			? { model }
			: {
					model: withAdvanced(model, {
						lookups: { ...model.advanced.lookups, [lookup]: Keyed.accept(slot, key, result) },
					}),
				}
	},
	CompletedPlaceAdvancedCursor: (): Return => ({ model }),
})
