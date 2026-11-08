import type { V2CatalogEntry, V2DataSourceCatalog } from "@maple/domain/http/v2"
import { Array as Arr, Option, Record as Rec, Result, String as Str } from "effect"
import { AsyncData, Command } from "foldkit"
import * as Dialog from "@maple/views/ui/dialog"
import { DeleteSource, FetchCatalog, FetchSources, RefreshCatalog, UpdateCatalogEntry } from "./command"
import { Message, type Model } from "./model"
import { type Return, sourceById, toast, withSource } from "./state"

// The source detail: catalog reads, curation, refresh and delete.

const detailSource = (model: Model) =>
	model.screen._tag === "Detail" ? sourceById(model, model.screen.id) : Option.none()

const entryNamed = (model: Model, name: string): Option.Option<V2CatalogEntry> =>
	Option.flatMap(AsyncData.getData(model.catalog), (catalog) =>
		Arr.findFirst(catalog.entries, (entry) => entry.name === name),
	)

const putEntry = (catalog: V2DataSourceCatalog, entry: V2CatalogEntry): V2DataSourceCatalog => ({
	...catalog,
	entries: Arr.map(catalog.entries, (current) => (current.name === entry.name ? entry : current)),
})

const liftDelete = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, deleteDialog: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotDeleteDialogMessage({ message })),
})

const curate = (model: Model, name: string, payload: Parameters<typeof UpdateCatalogEntry>[0]["payload"]): Return =>
	Option.match(detailSource(model), {
		onNone: () => ({ model }),
		onSome: (source) => ({
			model: { ...model, savingEntries: Arr.append(model.savingEntries, name) },
			commands: [UpdateCatalogEntry({ id: source.id, entry: name, payload })],
		}),
	})

const editEntry = (model: Model, edit: (draft: NonNullable<Model["entryDraft"]>) => Model["entryDraft"]): Return =>
	model.entryDraft === null ? { model } : { model: { ...model, entryDraft: edit(model.entryDraft) } }

export const updateCatalog = (model: Model, message: Message): Return => {
	switch (message._tag) {
		case "CompletedFetchCatalog":
			return { model: { ...model, catalog: AsyncData.settle(model.catalog, message.result) } }
		case "ClickedRefreshCatalog":
			return model.isRefreshing
				? { model }
				: Option.match(detailSource(model), {
						onNone: () => ({ model }),
						onSome: (source) => ({ model: { ...model, isRefreshing: true }, commands: [RefreshCatalog({ id: source.id })] }),
					})
		case "CompletedRefreshCatalog":
			return Result.match(message.result, {
				onSuccess: (source) => ({
					model: { ...withSource(model, source), isRefreshing: false, catalog: Option.getOrElse(AsyncData.revalidate(model.catalog), () => model.catalog) },
					commands: [FetchCatalog({ id: source.id })],
					outMessage: toast("success", "Catalog refreshed"),
				}),
				onFailure: (error) => ({
					model: { ...model, isRefreshing: false },
					// The source keeps the refresh's error; the list shows it from the next read.
					commands: [FetchSources()],
					outMessage: toast("error", "Could not refresh the catalog", error.message),
				}),
			})
		case "ToggledEntryExposed":
			return Option.match(entryNamed(model, message.name), {
				onNone: () => ({ model }),
				onSome: (entry) => curate(model, entry.name, { exposed: !entry.exposed }),
			})
		case "ClickedEditEntry":
			return Option.match(entryNamed(model, message.name), {
				onNone: () => ({ model }),
				onSome: (entry) => ({
					model: {
						...model,
						entryDraft: {
							name: entry.name,
							note: entry.note ?? "",
							timeField: entry.time_field ?? "",
							fieldNotes: Rec.fromEntries(
								Arr.flatMap(entry.fields, (field): ReadonlyArray<readonly [string, string]> =>
									field.note === null ? [] : [[field.name, field.note]],
								),
							),
						},
					},
				}),
			})
		case "ChangedEntryNote":
			return editEntry(model, (draft) => ({ ...draft, note: message.value }))
		case "ChangedEntryTimeField":
			return editEntry(model, (draft) => ({ ...draft, timeField: message.value }))
		case "ChangedFieldNote":
			return editEntry(model, (draft) => ({ ...draft, fieldNotes: { ...draft.fieldNotes, [message.field]: message.value } }))
		case "ClickedCancelEntry":
			return { model: { ...model, entryDraft: null } }
		case "ClickedSaveEntry": {
			const draft = model.entryDraft
			if (draft === null) return { model }
			const fieldNotes = Rec.filter(draft.fieldNotes, (note) => Str.trim(note) !== "")
			return curate({ ...model, entryDraft: null }, draft.name, {
				note: Str.trim(draft.note) === "" ? null : Str.trim(draft.note),
				time_field: draft.timeField === "" ? null : draft.timeField,
				field_notes: fieldNotes,
			})
		}
		case "CompletedUpdateEntry": {
			const savingEntries = Arr.filter(model.savingEntries, (name) => name !== message.name)
			return Result.match(message.result, {
				onSuccess: (entry) => ({
					model: { ...model, savingEntries, catalog: AsyncData.map(model.catalog, (catalog) => putEntry(catalog, entry)) },
				}),
				onFailure: (error) => ({
					model: { ...model, savingEntries },
					outMessage: toast("error", `Could not update ${message.name}`, error.message),
				}),
			})
		}
		case "ClickedDelete":
			return liftDelete(model, Dialog.open(model.deleteDialog))
		case "GotDeleteDialogMessage":
			return model.isDeleting ? { model } : liftDelete(model, Dialog.update(model.deleteDialog, message.message))
		case "ClickedConfirmDelete":
			return model.isDeleting
				? { model }
				: Option.match(detailSource(model), {
						onNone: () => ({ model }),
						onSome: (source) => ({ model: { ...model, isDeleting: true }, commands: [DeleteSource({ id: source.id })] }),
					})
		case "CompletedDelete": {
			const closed = liftDelete({ ...model, isDeleting: false }, Dialog.close(model.deleteDialog))
			const deletedId = model.screen._tag === "Detail" ? model.screen.id : null
			return Result.match(message.result, {
				onSuccess: () => ({
					model: {
						...closed.model,
						screen: { _tag: "List" },
						sources: AsyncData.map(closed.model.sources, (sources) =>
							Arr.filter(sources, (source) => source.id !== deletedId),
						),
						catalog: AsyncData.Idle(),
					},
					commands: [...(closed.commands ?? []), FetchSources()],
					outMessage: toast("success", "Data source deleted"),
				}),
				onFailure: (error) => ({ ...closed, outMessage: toast("error", "Could not delete the data source", error.message) }),
			})
		}
		default:
			return { model }
	}
}
