import type { V2DataSource } from "@maple/domain/http/v2"
import { Array as Arr, Option, Result } from "effect"
import { AsyncData } from "foldkit"
import * as Dialog from "@maple/views/ui/dialog"
import { revisitData } from "../kit/revisit"
import { CreateSource, FetchCatalog, FetchSources, TestSource, UpdateSource } from "./command"
import { createParamsOf, draftOf, emptyDraft, isDraftValid, updateParamsOf } from "./draft"
import { Message, type Model } from "./model"
import { type Return, sourceById, toast, withSource } from "./state"
import { updateCatalog } from "./update-catalog"

export const init = (): Return => ({
	model: {
		sources: AsyncData.Loading(),
		screen: { _tag: "List" },
		draft: emptyDraft,
		isSubmitted: false,
		isSaving: false,
		saveError: null,
		tests: [],
		testingId: null,
		saveWarnings: null,
		catalog: AsyncData.Idle(),
		isRefreshing: false,
		entryDraft: null,
		entryError: null,
		savingEntries: [],
		deleteDialog: Dialog.init("data-source-delete", "alert-dialog"),
		isDeleting: false,
	},
	commands: [FetchSources()],
})

/** Back on the tab: the list stays up while it reads again. */
export const revisit = (model: Model): Return => {
	const sources = revisitData(model.sources, FetchSources)
	return { model: { ...model, sources: sources.data }, commands: sources.commands }
}

/** The open form's source, when it edits one. */
const editedSource = (model: Model): Option.Option<V2DataSource> =>
	model.screen._tag === "Form" && model.screen.editing !== null
		? sourceById(model, model.screen.editing)
		: Option.none()

const resetForm = { isSubmitted: false, isSaving: false, saveError: null } as const

const submit = (model: Model): Return => {
	if (model.screen._tag !== "Form" || model.isSaving) return { model }
	const { kind, editing } = model.screen
	const submitted = { ...model, isSubmitted: true, saveError: null }
	if (!isDraftValid(model.draft, kind, editing !== null)) return { model: submitted }
	const saving = { ...submitted, isSaving: true }
	return Option.match(editedSource(model), {
		onNone: () => ({
			model: saving,
			commands: [CreateSource({ payload: createParamsOf(model.draft, kind) })],
		}),
		onSome: (source) => ({
			model: saving,
			commands: [UpdateSource({ id: source.id, payload: updateParamsOf(model.draft, kind, source) })],
		}),
	})
}

const openDetail = (model: Model, source: V2DataSource): Return => ({
	model: {
		...model,
		screen: { _tag: "Detail", id: source.id },
		catalog: AsyncData.Loading(),
		entryDraft: null,
		entryError: null,
	},
	commands: [FetchCatalog({ id: source.id })],
})

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		CompletedFetchSources: ({ result }) => ({
			model: { ...model, sources: AsyncData.settle(model.sources, result) },
		}),
		ClickedConnect: () => ({ model: { ...model, screen: { _tag: "PickKind" } } }),
		ClickedKind: ({ kind }) => ({
			model: {
				...model,
				...resetForm,
				screen: { _tag: "Form", kind, editing: null },
				draft: emptyDraft,
			},
		}),
		ClickedBack: () => ({
			model: { ...model, ...resetForm, screen: { _tag: "List" }, entryDraft: null, entryError: null },
		}),
		ChangedField: ({ field, value }) => ({
			model: { ...model, draft: { ...model.draft, [field]: value } },
		}),
		ChangedEnvironment: ({ value }) =>
			value === "production" || value === "staging" || value === "development" || value === "other"
				? { model: { ...model, draft: { ...model.draft, environment: value } } }
				: { model },
		ToggledAgentAccess: () => ({
			model: { ...model, draft: { ...model.draft, agentAccess: !model.draft.agentAccess } },
		}),
		ToggledAgentPii: () => ({
			model: { ...model, draft: { ...model.draft, agentPii: !model.draft.agentPii } },
		}),
		ClickedSubmit: () => submit(model),
		CompletedSave: ({ result }) =>
			Result.match(result, {
				onSuccess: ({ warnings, ...saved }) => {
					const isCreate = model.screen._tag === "Form" && model.screen.editing === null
					const saveWarnings = warnings.length === 0 ? null : { id: saved.id, warnings }
					return {
						...openDetail(
							{
								...withSource(model, saved),
								...resetForm,
								saveWarnings,
								// The connection just passed a fresh test; an older result would hide its warnings.
								tests: Arr.filter(model.tests, (test) => test.id !== saved.id),
							},
							saved,
						),
						outMessage: toast(
							"success",
							isCreate ? `Connected ${saved.name}` : `Saved ${saved.name}`,
						),
					}
				},
				onFailure: (error) => ({ model: { ...model, isSaving: false, saveError: error } }),
			}),
		ClickedOpen: ({ id }) =>
			Option.match(sourceById(model, id), {
				onNone: () => ({ model }),
				onSome: (source) => openDetail(model, source),
			}),
		ClickedEdit: ({ id }) =>
			Option.match(sourceById(model, id), {
				onNone: () => ({ model }),
				onSome: (source) => ({
					model: {
						...model,
						...resetForm,
						screen: { _tag: "Form", kind: source.kind, editing: source.id },
						draft: draftOf(source),
					},
				}),
			}),
		ClickedTest: ({ id }) =>
			model.testingId !== null
				? { model }
				: Option.match(sourceById(model, id), {
						onNone: () => ({ model }),
						onSome: (source) => ({
							model: { ...model, testingId: id },
							commands: [TestSource({ id: source.id, key: id })],
						}),
					}),
		CompletedTest: ({ id, result }) =>
			Result.match(result, {
				onSuccess: (outcome) => ({
					model: {
						...model,
						testingId: null,
						saveWarnings: model.saveWarnings?.id === id ? null : model.saveWarnings,
						tests: [
							...Arr.filter(model.tests, (test) => test.id !== id),
							{ id, result: outcome },
						],
					},
					// The test recorded its outcome on the source; the list reads the new status.
					commands: [FetchSources()],
				}),
				onFailure: (error) => ({
					model: { ...model, testingId: null },
					outMessage: toast("error", "Could not run the test", error.message),
				}),
			}),
		CompletedFetchCatalog: (message) => updateCatalog(model, message),
		ClickedRefreshCatalog: (message) => updateCatalog(model, message),
		CompletedRefreshCatalog: (message) => updateCatalog(model, message),
		ToggledEntryExposed: (message) => updateCatalog(model, message),
		ClickedEditEntry: (message) => updateCatalog(model, message),
		ChangedEntryNote: (message) => updateCatalog(model, message),
		ChangedEntryTimeField: (message) => updateCatalog(model, message),
		ChangedFieldNote: (message) => updateCatalog(model, message),
		ClickedSaveEntry: (message) => updateCatalog(model, message),
		ClickedCancelEntry: (message) => updateCatalog(model, message),
		CompletedUpdateEntry: (message) => updateCatalog(model, message),
		ClickedDelete: (message) => updateCatalog(model, message),
		GotDeleteDialogMessage: (message) => updateCatalog(model, message),
		ClickedConfirmDelete: (message) => updateCatalog(model, message),
		CompletedDelete: (message) => updateCatalog(model, message),
	})
