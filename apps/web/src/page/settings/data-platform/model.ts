import {
	OrgClickHouseApplySchemaStarted,
	OrgClickHouseApplySchemaStatus,
	OrgClickHouseSchemaDiffResponse,
	OrgClickHouseSettingsResponse,
} from "@maple/domain/http"
import { Schema } from "effect"
import { AsyncData } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../../data/load-failure"
import * as Dialog from "../../../ui/dialog"

// `OrgClickHouseSettingsSection` and `DataPlatformUsageSection` (apps/web/src/components/settings/).

export const Totals = Schema.Struct({
	logs: Schema.Number,
	traces: Schema.Number,
	metrics: Schema.Number,
	dataSize: Schema.Number,
})
export type Totals = typeof Totals.Type

export const ConnectionDraft = Schema.Struct({
	url: Schema.String,
	user: Schema.String,
	database: Schema.String,
})
export type ConnectionDraft = typeof ConnectionDraft.Type

export const ConnectionField = Schema.Literals(["url", "user", "database"])
export type ConnectionField = typeof ConnectionField.Type

export const Model = Schema.Struct({
	settings: AsyncData.Schema(OrgClickHouseSettingsResponse, LoadFailure).schema,
	diff: AsyncData.Schema(OrgClickHouseSchemaDiffResponse, LoadFailure).schema,
	/** Read once the cluster is configured (`SchemaSection` mounts then). */
	applyStatus: AsyncData.Schema(OrgClickHouseApplySchemaStatus, LoadFailure).schema,
	/** Status reads sent and the newest one answered: an older answer arriving late is dropped. */
	applyStatusSent: Schema.Number,
	applyStatusAnswered: Schema.Number,
	usage: AsyncData.Schema(Totals, LoadFailure).schema,
	/** The connection edits, `null` while the form shows the saved values. */
	draft: Schema.NullOr(ConnectionDraft),
	/** After a save, the saved values it started from: the edits stay until the refetch moves. */
	committedOver: Schema.NullOr(ConnectionDraft),
	password: Schema.String,
	isSaving: Schema.Boolean,
	isDisconnecting: Schema.Boolean,
	disconnectDialog: Dialog.Model,
	applyDialog: Dialog.Model,
	isStarting: Schema.Boolean,
	showUpToDate: Schema.Boolean,
	/** Drifted rows the user folded (they start open). */
	collapsedDrift: Schema.Array(Schema.String),
})
export type Model = typeof Model.Type

const done = <A extends Schema.Top>(schema: A) => ({ result: Schema.Result(schema, LoadFailure) })

export const Message = defineMessageUnion({
	CompletedFetchSettings: done(OrgClickHouseSettingsResponse),
	CompletedFetchDiff: done(OrgClickHouseSchemaDiffResponse),
	CompletedFetchApplyStatus: { sequence: Schema.Number, ...done(OrgClickHouseApplySchemaStatus) },
	CompletedFetchUsage: done(Totals),
	ChangedConnection: { field: ConnectionField, value: Schema.String },
	ChangedPassword: { value: Schema.String },
	ClickedSave: {},
	CompletedSave: done(OrgClickHouseSettingsResponse),
	ClickedDisconnect: {},
	GotDisconnectDialogMessage: { message: Dialog.Message },
	ClickedConfirmDisconnect: {},
	CompletedDisconnect: { result: Schema.Result(Schema.Void, LoadFailure) },
	ClickedRefreshDiff: {},
	ToggledUpToDate: {},
	ToggledDrift: { name: Schema.String },
	ClickedReviewApply: {},
	GotApplyDialogMessage: { message: Dialog.Message },
	ClickedConfirmApply: {},
	CompletedApply: done(OrgClickHouseApplySchemaStarted),
	ElapsedStartingHandoff: {},
	TickedApplyPoll: {},
})
export type Message = typeof Message.Type
