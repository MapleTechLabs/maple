import { readLocalStorage, writeLocalStorage } from "@maple/ui/lib/local-storage"
import { GcpResourcesResponse } from "@maple/domain/http"
import { V2GcpSetupScripts } from "@maple/domain/http/v2"
import { GcpConnectorId } from "@maple/domain/primitives"
import { gcpLogVolume } from "../../components/integrations/gcp-usage"
import { parseWarehouseDateTime } from "@maple/query-engine"
import { getCustomChartTimeSeries } from "@maple/web-data/warehouse/custom-charts"
import { Effect, Option, Schema } from "effect"
import { AsyncData, Command } from "foldkit"
import { KeyedSchema } from "../../data/keyed"
import { LoadFailure, toLoadFailure } from "../../data/load-failure"
import { TimeWindow } from "../../data/time-range"
import { MapleApiV2Client } from "../../platform/api-clients"
import * as CopyButton from "../../ui/copy-button"
import * as Dialog from "../../ui/dialog"
import * as Menu from "../../ui/menu"
import * as ToggleGroup from "../../ui/toggle-group"
import { FleetRead, loadFleet, loadResources } from "../infra-integrations/gcp/data"
import { Message } from "./message"
import { ConfigureModel } from "./gcp-configure-schema"
import { LogVolume, RemovedConnector } from "./gcp-schema"

// `GcpIntegrationCard` and `GcpUsageBand`: state and reads.

export { RemovedConnector } from "./gcp-schema"

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
	/** `useGcpScripts` for the disconnect dialog, and its "Read the script" toggle. */
	scripts: KeyedSchema(V2GcpSetupScripts, LoadFailure),
	isScriptShown: Schema.Boolean,
	/** `removedGcpConnectorsAtomFamily(org)` (localStorage), and the entry being dismissed. */
	removed: Schema.Array(RemovedConnector),
	dismissingId: Schema.NullOr(Schema.String),
	dismissDialog: Dialog.Model,
	/** The cleanup scripts' copy buttons, by removed connection. */
	copies: Schema.Record(Schema.String, CopyButton.Model),
	/** `GcpConfigure`, null while closed. */
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
	messages: [Message.CompletedGcpLogVolume],
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
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedGcpLogVolume({ key, result })),
		),
})

export const LoadFleet = Command.define("LoadGcpIntegrationFleet", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [Message.CompletedGcpFleet],
	execute: ({ key, window }) =>
		Effect.map(loadFleet(window), (result) => Message.CompletedGcpFleet({ key, result })),
})

export const LoadInventory = Command.define("LoadGcpIntegrationInventory", {
	args: { key: Schema.String },
	messages: [Message.CompletedGcpInventory],
	execute: ({ key }) =>
		Effect.map(loadResources({}), (result) => Message.CompletedGcpInventory({ key, result })),
})

export const DeleteConnector = Command.define("DeleteGcpConnector", {
	args: { id: GcpConnectorId },
	messages: [Message.CompletedGcpDisconnect],
	execute: ({ id }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const response = yield* client.gcpIntegration.deleteConnector({ params: { id } })
			return response.cleanup_script
		}).pipe(
			Effect.match({
				onFailure: (error) =>
					Message.CompletedGcpDisconnect({
						id,
						cleanupScript: null,
						failure: toLoadFailure(error),
					}),
				onSuccess: (cleanupScript) =>
					Message.CompletedGcpDisconnect({ id, cleanupScript, failure: null }),
			}),
		),
})

/** `gcpIntegration.setupScripts` with an empty payload: the sink keeps its filter. */
export const LoadScripts = Command.define("LoadGcpSetupScripts", {
	args: { key: Schema.String, id: GcpConnectorId },
	messages: [Message.CompletedGcpScripts],
	execute: ({ key, id }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			return yield* client.gcpIntegration.setupScripts({ params: { id }, payload: {} })
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedGcpScripts({ key, result })),
		),
})

const storageKey = (orgId: string) => `maple.gcp.removed-connectors.${orgId}`
const decodeRemoved = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(RemovedConnector)))
const encodeRemoved = Schema.encodeSync(Schema.fromJsonString(Schema.Array(RemovedConnector)))

export const ReadRemoved = Command.define("ReadGcpRemovedConnectors", {
	args: { orgId: Schema.String },
	messages: [Message.CompletedReadGcpRemoved],
	execute: ({ orgId }) =>
		Effect.sync(() =>
			Message.CompletedReadGcpRemoved({
				removed: Option.getOrElse(
					Option.flatMap(readLocalStorage(storageKey(orgId)), decodeRemoved),
					() => [],
				),
			}),
		),
})

export const WriteRemoved = Command.define("WriteGcpRemovedConnectors", {
	args: { orgId: Schema.String, removed: Schema.Array(RemovedConnector) },
	messages: [Message.CompletedWriteGcpRemoved],
	execute: ({ orgId, removed }) =>
		Effect.sync(() => {
			// Best effort: private mode and blocked site data throw here.
			writeLocalStorage(storageKey(orgId), encodeRemoved(removed))
			return Message.CompletedWriteGcpRemoved()
		}),
})
