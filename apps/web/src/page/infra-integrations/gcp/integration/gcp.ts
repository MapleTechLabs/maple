import { readLocalStorage, writeLocalStorage } from "@maple/ui/lib/local-storage"
import { GcpResourcesResponse } from "@maple/domain/http"
import { V2GcpConnector, V2GcpSetupScripts } from "@maple/domain/http/v2"
import { GcpConnectorId, GcpLogRuntime } from "@maple/primitives"
import { gcpLogVolume } from "../usage"
import { parseWarehouseDateTime } from "@maple/query-engine"
import { getCustomChartTimeSeries } from "@maple/web-data/warehouse/custom-charts"
import { Effect, Option, Schema } from "effect"
import { AsyncData, Command } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure, toLoadFailure, settleTo } from "@maple/views/data/load-failure"
import { TimeWindow } from "../../../../data/time-range"
import { MapleApiV2Client } from "../../../../platform/api-clients"
import * as CopyButton from "@maple/views/ui/copy-button"
import * as Dialog from "@maple/views/ui/dialog"
import * as Field from "@maple/views/ui/field"
import * as Menu from "@maple/views/ui/menu"
import * as Select from "@maple/views/ui/select"
import * as ToggleGroup from "@maple/views/ui/toggle-group"
import { IntegrationStatuses } from "../../../../data/integration-statuses"
import { FleetRead, loadFleet, loadResources } from "../data"
import { Capability, ConfigureModel, GcpFlags, SetupMethod } from "./gcp-configure-schema"
import { ConfigureTarget, LogVolume, RemovedConnector } from "./gcp-schema"

export { RemovedConnector } from "./gcp-schema"

const result = <A, AI>(schema: Schema.Codec<A, AI>) => ({
	key: Schema.String,
	result: Schema.Result(schema, LoadFailure),
})

/** The Google Cloud module's messages, the configure wizard's among them, carried in `GotGcpMessage`. */
export const GcpMessage = defineMessageUnion({
	CompletedGcpLogVolume: result(LogVolume),
	CompletedGcpFleet: result(Schema.Array(FleetRead)),
	CompletedGcpInventory: result(GcpResourcesResponse),
	GotWorkloadFilterMessage: { message: ToggleGroup.Message },
	GotGcpMenuMessage: { id: GcpConnectorId, message: Menu.Message },
	GotGcpDisconnectDialogMessage: { message: Dialog.Message },
	ConfirmedGcpDisconnect: {},
	/** A Google Cloud source's Delete: opens the removal dialog for its connector. */
	ClickedGcpDisconnect: { id: Schema.String },
	CompletedGcpDisconnect: {
		id: GcpConnectorId,
		cleanupScript: Schema.NullOr(Schema.String),
		failure: Schema.NullOr(LoadFailure),
	},
	CompletedReadGcpRemoved: { removed: Schema.Array(RemovedConnector) },
	CompletedWriteGcpRemoved: {},
	ClickedDismissCleanup: { id: Schema.String },
	GotGcpDismissDialogMessage: { message: Dialog.Message },
	ConfirmedDismissCleanup: {},
	GotGcpCopyMessage: { id: Schema.String, message: CopyButton.Message },
	CompletedGcpScripts: result(V2GcpSetupScripts),
	ClickedGcpScriptToggle: {},
	ClickedGcpScriptRetry: {},
	ClickedGcpConfigure: { target: ConfigureTarget },
	/** Cancel, Close and Done: the wizard unmounts at once. */
	ClosedGcpConfigure: {},
	GotGcpConfigureDialogMessage: { message: Dialog.Message },
	GotGcpScopeTypeMessage: { message: ToggleGroup.Message },
	GotGcpScopeFieldMessage: { field: Schema.Literals(["scopeId", "hostProjectId"]), message: Field.Message },
	/** The scope step's form submit (Continue or Enter). */
	SubmittedGcpCreate: {},
	ToggledGcpCollect: { capability: Capability },
	/** A connection's feature switch: Edit data opens with that change drafted, to save from there. */
	ToggledGcpFeature: { id: Schema.String, capability: Capability },
	ClickedGcpLogFilter: {},
	GotGcpFilterModeMessage: { message: Select.Message },
	ClickedGcpForwardOutput: {},
	ClickedGcpUseOpenTelemetry: {},
	ToggledGcpRuntime: { runtime: GcpLogRuntime },
	CompletedGcpCreate: {
		opens: Schema.Number,
		connector: Schema.NullOr(V2GcpConnector),
		failure: Schema.NullOr(LoadFailure),
	},
	/** The data step's Continue, Save or "Save and continue". */
	ClickedGcpChooseApply: {},
	GotGcpConfirmDialogMessage: { message: Dialog.Message },
	ConfirmedGcpSave: {},
	CompletedGcpUpdate: {
		opens: Schema.Number,
		id: GcpConnectorId,
		flags: GcpFlags,
		failure: Schema.NullOr(LoadFailure),
	},
	ClickedGcpRunEdit: {},
	CompletedGcpConfigureScripts: result(V2GcpSetupScripts),
	ClickedGcpConfigureScriptRetry: {},
	ClickedGcpScriptExpand: {},
	/** The Method step: a row, or the code flavour under it. */
	ClickedGcpMethod: { method: SetupMethod },
	ClickedGcpMethodContinue: {},
	ClickedGcpManualStep: { title: Schema.String, firstTitle: Schema.NullOr(Schema.String) },
	ClickedGcpCopyPrompt: { prompt: Schema.String },
	CompletedGcpPromptCopy: { isCopied: Schema.Boolean },
	ClickedGcpPromptBack: {},
	ClickedGcpConfirmRemoval: {},
	CompletedGcpConfirmRemoval: { failure: Schema.NullOr(LoadFailure) },
	/** The status poll: 10 s while a connection settles, else every minute. */
	TickedGcpRefresh: {},
})
export type GcpMessage = typeof GcpMessage.Type

/** The hub's Google Cloud status read, which the sidebar shares (`IntegrationStatuses`). */
export const GCP_STATUS_READ = {
	name: "LoadIntegrationsGcpStatus",
	read: (refresh: boolean) => Effect.flatMap(IntegrationStatuses, (statuses) => statuses.gcp({ refresh })),
}

export const GcpCardModel = Schema.Struct({
	/** The band's 24h window, resolved from the page clock. */
	window: Schema.NullOr(TimeWindow),
	logVolume: KeyedSchema(LogVolume, LoadFailure),
	fleet: KeyedSchema(Schema.Array(FleetRead), LoadFailure),
	inventory: KeyedSchema(GcpResourcesResponse, LoadFailure),
	workloadFilter: ToggleGroup.Model,
	menus: Schema.Record(Schema.String, Menu.Model),
	/** The connection whose disconnect is being confirmed, and the delete in flight. */
	disconnectId: Schema.NullOr(GcpConnectorId),
	disconnectDialog: Dialog.Model,
	isDisconnecting: Schema.Boolean,
	/** The disconnect dialog's scripts, and its "Read the script" toggle. */
	scripts: KeyedSchema(V2GcpSetupScripts, LoadFailure),
	isScriptShown: Schema.Boolean,
	/** Kept in localStorage per org, and the entry being dismissed. */
	removed: Schema.Array(RemovedConnector),
	dismissingId: Schema.NullOr(Schema.String),
	dismissDialog: Dialog.Model,
	/** The cleanup scripts' copy buttons, by removed connection. */
	copies: Schema.Record(Schema.String, CopyButton.Model),
	configure: Schema.NullOr(ConfigureModel),
	/** Bumped on every open: a write's result only drives the wizard it was sent from. */
	configureOpens: Schema.Number,
	/** A create or save in flight outlives a close, so a reopened wizard cannot send a second. */
	pendingWrite: Schema.NullOr(Schema.Literals(["create", "update"])),
})
export type GcpCardModel = typeof GcpCardModel.Type

export const initGcpCard = (): GcpCardModel => ({
	window: null,
	logVolume: { key: null, data: AsyncData.Idle() },
	fleet: { key: null, data: AsyncData.Idle() },
	inventory: { key: null, data: AsyncData.Idle() },
	workloadFilter: ToggleGroup.init({ label: "Filter workloads by Google Cloud service", values: ["all"] }),
	menus: {},
	disconnectId: null,
	disconnectDialog: Dialog.init("gcp-disconnect", "alert-dialog"),
	isDisconnecting: false,
	scripts: { key: null, data: AsyncData.Idle() },
	isScriptShown: false,
	removed: [],
	dismissingId: null,
	dismissDialog: Dialog.init("gcp-dismiss-cleanup", "alert-dialog"),
	copies: {},
	configure: null,
	configureOpens: 0,
	pendingWrite: null,
})

/** What marks a log entry as forwarded by this integration (`GCP_LOG_SOURCE`). */
const GCP_LOG_SOURCE = { key: "maple_ingest_source", value: "gcp-logpush" } as const

export const LoadLogVolume = Command.define("LoadGcpIntegrationLogVolume", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [GcpMessage.CompletedGcpLogVolume],
	execute: ({ key, window }) =>
		getCustomChartTimeSeries({
			data: {
				source: "logs",
				metric: "count",
				groupBy: "severity",
				startTime: window.startTime,
				endTime: window.endTime,
				bucketSeconds: 3600,
				filters: { resourceAttributeFilters: [{ ...GCP_LOG_SOURCE, mode: "equals" }] },
			},
		}).pipe(
			Effect.map((response) =>
				gcpLogVolume(
					response.data,
					parseWarehouseDateTime(window.startTime),
					parseWarehouseDateTime(window.endTime),
				),
			),
			settleTo((result) => GcpMessage.CompletedGcpLogVolume({ key, result })),
		),
})

export const LoadFleet = Command.define("LoadGcpIntegrationFleet", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [GcpMessage.CompletedGcpFleet],
	execute: ({ key, window }) =>
		Effect.map(loadFleet(window), (result) => GcpMessage.CompletedGcpFleet({ key, result })),
})

export const LoadInventory = Command.define("LoadGcpIntegrationInventory", {
	args: { key: Schema.String },
	messages: [GcpMessage.CompletedGcpInventory],
	execute: ({ key }) =>
		Effect.map(loadResources({}), (result) => GcpMessage.CompletedGcpInventory({ key, result })),
})

export const DeleteConnector = Command.define("DeleteGcpConnector", {
	args: { id: GcpConnectorId },
	messages: [GcpMessage.CompletedGcpDisconnect],
	execute: ({ id }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const response = yield* client.gcpIntegration.deleteConnector({ params: { id } })
			return response.cleanup_script
		}).pipe(
			Effect.match({
				onFailure: (error) =>
					GcpMessage.CompletedGcpDisconnect({
						id,
						cleanupScript: null,
						failure: toLoadFailure(error),
					}),
				onSuccess: (cleanupScript) =>
					GcpMessage.CompletedGcpDisconnect({ id, cleanupScript, failure: null }),
			}),
		),
})

/** `gcpIntegration.setupScripts` with an empty payload: the sink keeps its filter. */
export const LoadScripts = Command.define("LoadGcpSetupScripts", {
	args: { key: Schema.String, id: GcpConnectorId },
	messages: [GcpMessage.CompletedGcpScripts],
	execute: ({ key, id }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			return yield* client.gcpIntegration.setupScripts({ params: { id }, payload: {} })
		}).pipe(settleTo((result) => GcpMessage.CompletedGcpScripts({ key, result }))),
})

const storageKey = (orgId: string) => `maple.gcp.removed-connectors.${orgId}`
const decodeRemoved = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(RemovedConnector)))
const encodeRemoved = Schema.encodeSync(Schema.fromJsonString(Schema.Array(RemovedConnector)))

export const ReadRemoved = Command.define("ReadGcpRemovedConnectors", {
	args: { orgId: Schema.String },
	messages: [GcpMessage.CompletedReadGcpRemoved],
	execute: ({ orgId }) =>
		Effect.sync(() =>
			GcpMessage.CompletedReadGcpRemoved({
				removed: Option.getOrElse(
					Option.flatMap(readLocalStorage(storageKey(orgId)), decodeRemoved),
					() => [],
				),
			}),
		),
})

export const WriteRemoved = Command.define("WriteGcpRemovedConnectors", {
	args: { orgId: Schema.String, removed: Schema.Array(RemovedConnector) },
	messages: [GcpMessage.CompletedWriteGcpRemoved],
	execute: ({ orgId, removed }) =>
		Effect.sync(() => {
			// Best effort: private mode and blocked site data throw here.
			writeLocalStorage(storageKey(orgId), encodeRemoved(removed))
			return GcpMessage.CompletedWriteGcpRemoved()
		}),
})
