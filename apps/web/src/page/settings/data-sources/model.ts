import { DataSourceEnvironment, DataSourceKind } from "@maple/domain/data-sources"
import {
	V2CatalogEntry,
	V2DataSource,
	V2DataSourceCatalog,
	V2DataSourceTestResult,
	V2SavedDataSource,
} from "@maple/domain/http/v2"
import { Array as Arr, Schema } from "effect"
import { AsyncData } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as Dialog from "@maple/views/ui/dialog"

// Settings -> Data sources: databases and APIs Maple queries in place.

/** Which view the tab shows: the list, the kind picker, the connect or edit form, or one source. */
export const Screen = Schema.Union([
	Schema.TaggedStruct("List", {}),
	Schema.TaggedStruct("PickKind", {}),
	/** `editing` is the source's public id; `null` connects a new one. */
	Schema.TaggedStruct("Form", { kind: DataSourceKind, editing: Schema.NullOr(Schema.String) }),
	Schema.TaggedStruct("Detail", { id: Schema.String }),
])
export type Screen = typeof Screen.Type

/** The connect form as typed; tags stay one comma-separated string until submit. */
export const Draft = Schema.Struct({
	name: Schema.String,
	description: Schema.String,
	environment: DataSourceEnvironment,
	tags: Schema.String,
	agentAccess: Schema.Boolean,
	agentPii: Schema.Boolean,
	url: Schema.String,
	user: Schema.String,
	database: Schema.String,
	/** Blank on edit keeps the stored password. */
	password: Schema.String,
	/** Blank on edit keeps the stored key. */
	secretKey: Schema.String,
})
export type Draft = typeof Draft.Type

export const DraftField = Schema.Literals([
	"name",
	"description",
	"tags",
	"url",
	"user",
	"database",
	"password",
	"secretKey",
])
export type DraftField = typeof DraftField.Type

/** A catalog entry's curation while it is edited. */
export const EntryDraft = Schema.Struct({
	name: Schema.String,
	note: Schema.String,
	/** `null` uses the field the source reported, `""` none at all, else the chosen field. */
	timeField: Schema.NullOr(Schema.String),
	fieldNotes: Schema.Record(Schema.String, Schema.String),
})
export type EntryDraft = typeof EntryDraft.Type

export const TestOutcome = Schema.Struct({ id: Schema.String, result: V2DataSourceTestResult })
export type TestOutcome = typeof TestOutcome.Type

export const Model = Schema.Struct({
	sources: AsyncData.Schema(Schema.Array(V2DataSource), LoadFailure).schema,
	screen: Screen,
	draft: Draft,
	/** Field errors show once the form was submitted. */
	isSubmitted: Schema.Boolean,
	isSaving: Schema.Boolean,
	/** What the API said about the last save; a `param` places it under its field. */
	saveError: Schema.NullOr(LoadFailure),
	/** The last test result per source this visit. */
	tests: Schema.Array(TestOutcome),
	/** Sources with a connection test in flight; each source tests on its own. */
	testingIds: Schema.Array(Schema.String),
	/** What the connect or reconnect test warned about, shown on that source until a new test. */
	saveWarnings: Schema.NullOr(Schema.Struct({ id: Schema.String, warnings: Schema.Array(Schema.String) })),
	catalog: AsyncData.Schema(V2DataSourceCatalog, LoadFailure).schema,
	/** The source whose catalog refresh is in flight; cleared on leaving it. */
	refreshingId: Schema.NullOr(Schema.String),
	entryDraft: Schema.NullOr(EntryDraft),
	/** Why the editor's last save failed; the draft stays open to retry. */
	entryError: Schema.NullOr(LoadFailure),
	/** Curation writes in flight, keyed by source and entry (`savingKey`): two sources can share an entry name. */
	savingEntries: Schema.Array(Schema.String),
	deleteDialog: Dialog.Model,
	isDeleting: Schema.Boolean,
})
export type Model = typeof Model.Type

const done = <A extends Schema.Top>(schema: A) => ({ result: Schema.Result(schema, LoadFailure) })

export const Message = defineMessageUnion({
	CompletedFetchSources: done(Schema.Array(V2DataSource)),
	ClickedConnect: {},
	ClickedKind: { kind: DataSourceKind },
	ClickedBack: {},
	ChangedField: { field: DraftField, value: Schema.String },
	ChangedEnvironment: { value: Schema.String },
	ToggledAgentAccess: {},
	ToggledAgentPii: {},
	ClickedSubmit: {},
	CompletedSave: done(V2SavedDataSource),
	ClickedOpen: { id: Schema.String },
	ClickedEdit: { id: Schema.String },
	ClickedTest: { id: Schema.String },
	CompletedTest: { id: Schema.String, ...done(V2DataSourceTestResult) },
	CompletedFetchCatalog: { id: Schema.String, ...done(V2DataSourceCatalog) },
	ClickedRefreshCatalog: {},
	CompletedRefreshCatalog: { id: Schema.String, ...done(V2DataSource) },
	ToggledEntryExposed: { name: Schema.String },
	ClickedEditEntry: { name: Schema.String },
	ChangedEntryNote: { value: Schema.String },
	ChangedEntryTimeField: { value: Schema.NullOr(Schema.String) },
	ChangedFieldNote: { field: Schema.String, value: Schema.String },
	ClickedSaveEntry: {},
	ClickedCancelEntry: {},
	CompletedUpdateEntry: {
		id: Schema.String,
		name: Schema.String,
		fromEditor: Schema.Boolean,
		...done(V2CatalogEntry),
	},
	ClickedDelete: {},
	GotDeleteDialogMessage: { message: Dialog.Message },
	ClickedConfirmDelete: {},
	CompletedDelete: { id: Schema.String, ...done(Schema.Void) },
})
export type Message = typeof Message.Type

/** A curation write in flight, per source: `shop.payments` on prod and on staging are different entries. */
export const savingKey = (sourceId: string, entry: string): string => `${sourceId}\u0000${entry}`

/** Whether the open source has a write in flight for `entry`. */
export const isSavingEntry = (model: Model, entry: string): boolean =>
	model.screen._tag === "Detail" && Arr.contains(model.savingEntries, savingKey(model.screen.id, entry))
