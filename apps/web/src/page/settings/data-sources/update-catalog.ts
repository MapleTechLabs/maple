import type { V2CatalogEntry, V2DataSourceCatalog } from "@maple/domain/http/v2"
import { Array as Arr, Option, Record as Rec, Result, String as Str } from "effect"
import { AsyncData, Command } from "foldkit"
import * as Dialog from "@maple/views/ui/dialog"
import { DeleteSource, FetchCatalog, FetchSources, RefreshCatalog, UpdateCatalogEntry } from "./command"
import { isSavingEntry, Message, type Model, savingKey } from "./model"
import { type Return, sourceById, toast, withSource } from "./state"

// The source detail: catalog reads, curation, refresh and delete.

const detailSource = (model: Model) =>
	model.screen._tag === "Detail" ? sourceById(model, model.screen.id) : Option.none()

const isOpenDetail = (model: Model, id: string) => model.screen._tag === "Detail" && model.screen.id === id

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
	commands: Command.mapMessages(step.commands ?? [], (message) =>
		Message.GotDeleteDialogMessage({ message }),
	),
})

const curate = (
	model: Model,
	name: string,
	payload: Parameters<typeof UpdateCatalogEntry>[0]["payload"],
	fromEditor = false,
): Return =>
	Option.match(detailSource(model), {
		onNone: () => ({ model }),
		onSome: (source) => ({
			model: { ...model, savingEntries: Arr.append(model.savingEntries, savingKey(source.id, name)) },
			commands: [UpdateCatalogEntry({ id: source.id, entry: name, payload, fromEditor })],
		}),
	})

/** The picker's choice for what the API returned: detected (`null`), none (`""`) or a field. */
const timeFieldChoice = (entry: V2CatalogEntry): string | null => {
	if (entry.time_field === entry.detected_time_field) return null
	return entry.time_field ?? ""
}

/** The note when it changed; an emptied one is `""`, which hides the source's note too. */
const notePatch = (entry: Option.Option<V2CatalogEntry>, draftNote: string) => {
	const note = Str.trim(draftNote)
	const current = Option.match(entry, { onNone: () => null, onSome: (found) => found.note ?? "" })
	return note === current ? {} : { note }
}

const editEntry = (
	model: Model,
	edit: (draft: NonNullable<Model["entryDraft"]>) => Model["entryDraft"],
): Return =>
	model.entryDraft === null ? { model } : { model: { ...model, entryDraft: edit(model.entryDraft) } }

/** After a delete: back to the list only if the deleted source is the one still open. */
const closeDeleted = (model: Model, wasOpen: boolean): Model =>
	wasOpen ? { ...model, screen: { _tag: "List" }, catalog: AsyncData.Idle() } : model

export const updateCatalog = (model: Model, message: Message): Return => {
	switch (message._tag) {
		case "CompletedFetchCatalog": {
			// An answer for a source the admin already left must not land on the one now open.
			if (!isOpenDetail(model, message.id)) return { model }
			const settled = { ...model, catalog: AsyncData.settle(model.catalog, message.result) }
			// A refresh can drop the entry being edited; its draft would lock every other row.
			const draftName = model.entryDraft?.name
			return draftName !== undefined && Option.isNone(entryNamed(settled, draftName))
				? { model: { ...settled, entryDraft: null, entryError: null } }
				: { model: settled }
		}
		case "ClickedRefreshCatalog":
			return model.refreshingId !== null
				? { model }
				: Option.match(detailSource(model), {
						onNone: () => ({ model }),
						onSome: (source) => ({
							model: { ...model, refreshingId: source.id },
							commands: [RefreshCatalog({ id: source.id })],
						}),
					})
		case "CompletedRefreshCatalog": {
			const pending = model.refreshingId === message.id ? null : model.refreshingId
			// A refresh for a source the admin left only clears its pending state.
			if (!isOpenDetail(model, message.id)) return { model: { ...model, refreshingId: pending } }
			return Result.match(message.result, {
				onSuccess: (source) => ({
					model: {
						...withSource(model, source),
						refreshingId: pending,
						catalog: Option.getOrElse(AsyncData.revalidate(model.catalog), () => model.catalog),
					},
					commands: [FetchCatalog({ id: source.id })],
					outMessage: toast("success", "Catalog refreshed"),
				}),
				onFailure: (error) => ({
					model: { ...model, refreshingId: pending },
					// The source keeps the refresh's error; the list shows it from the next read.
					commands: [FetchSources()],
					outMessage: toast("error", "Could not refresh the catalog", error.message),
				}),
			})
		}
		case "ToggledEntryExposed":
			return Option.match(entryNamed(model, message.name), {
				onNone: () => ({ model }),
				onSome: (entry) => curate(model, entry.name, { exposed: !entry.exposed }),
			})
		case "ClickedEditEntry":
			// Another entry's open draft keeps its unsaved notes until it is saved or closed.
			if (model.entryDraft !== null && model.entryDraft.name !== message.name) return { model }
			return Option.match(entryNamed(model, message.name), {
				onNone: () => ({ model }),
				onSome: (entry) => ({
					model: {
						...model,
						entryError: null,
						entryDraft: {
							name: entry.name,
							note: entry.note ?? "",
							timeField: timeFieldChoice(entry),
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
			return editEntry(model, (draft) => ({
				...draft,
				fieldNotes: { ...draft.fieldNotes, [message.field]: message.value },
			}))
		case "ClickedCancelEntry":
			return { model: { ...model, entryDraft: null, entryError: null } }
		case "ClickedSaveEntry": {
			const draft = model.entryDraft
			if (draft === null || isSavingEntry(model, draft.name)) return { model }
			const fieldNotes = Rec.filter(draft.fieldNotes, (note) => Str.trim(note) !== "")
			// The draft stays until the write lands, so a failure keeps the edits.
			return curate(
				{ ...model, entryError: null },
				draft.name,
				{
					...notePatch(entryNamed(model, draft.name), draft.note),
					time_field: draft.timeField,
					field_notes: fieldNotes,
				},
				true,
			)
		}
		case "CompletedUpdateEntry": {
			const key = savingKey(message.id, message.name)
			const savingEntries = Arr.filter(model.savingEntries, (saving) => saving !== key)
			// The write landed on the source it was made for; only the open one shows it.
			const isOpen = isOpenDetail(model, message.id)
			const isEditorSave = isOpen && message.fromEditor && model.entryDraft?.name === message.name
			return Result.match(message.result, {
				onSuccess: (entry) => {
					if (!isOpen) return { model: { ...model, savingEntries } }
					const saved: Model = {
						...model,
						savingEntries,
						catalog: AsyncData.map(model.catalog, (catalog) => putEntry(catalog, entry)),
					}
					return { model: isEditorSave ? { ...saved, entryDraft: null, entryError: null } : saved }
				},
				onFailure: (error) =>
					isEditorSave
						? { model: { ...model, savingEntries, entryError: error } }
						: {
								model: { ...model, savingEntries },
								outMessage: toast("error", `Could not update ${message.name}`, error.message),
							},
			})
		}
		case "ClickedDelete":
			return liftDelete(model, Dialog.open(model.deleteDialog))
		case "GotDeleteDialogMessage":
			return model.isDeleting
				? { model }
				: liftDelete(model, Dialog.update(model.deleteDialog, message.message))
		case "ClickedConfirmDelete":
			return model.isDeleting
				? { model }
				: Option.match(detailSource(model), {
						onNone: () => ({ model }),
						onSome: (source) => ({
							model: { ...model, isDeleting: true },
							commands: [DeleteSource({ id: source.id })],
						}),
					})
		case "CompletedDelete": {
			const closed = liftDelete({ ...model, isDeleting: false }, Dialog.close(model.deleteDialog))
			// The deleted source, by the answer's id: the admin may have opened another meanwhile.
			const wasOpen = isOpenDetail(model, message.id)
			return Result.match(message.result, {
				onSuccess: () => ({
					model: closeDeleted(
						{
							...closed.model,
							sources: AsyncData.map(closed.model.sources, (sources) =>
								Arr.filter(sources, (source) => source.id !== message.id),
							),
						},
						wasOpen,
					),
					commands: [...(closed.commands ?? []), FetchSources()],
					outMessage: toast("success", "Data source deleted"),
				}),
				onFailure: (error) => ({
					...closed,
					outMessage: toast("error", "Could not delete the data source", error.message),
				}),
			})
		}
		default:
			return { model }
	}
}
