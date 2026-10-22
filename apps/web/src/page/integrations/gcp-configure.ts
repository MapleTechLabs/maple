import {
	V2GcpCreateConnectorRequest,
	V2GcpUpdateConnectorRequest,
	type V2GcpConnector,
} from "@maple/domain/http/v2"
import { GcpConnectorId, GcpLogRuntime } from "@maple/domain/primitives"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import * as Keyed from "../../data/keyed"
import { toLoadFailure } from "../../data/load-failure"
import { MapleApiV2Client } from "../../platform/api-clients"
import * as CopyButton from "../../ui/copy-button"
import * as Dialog from "../../ui/dialog"
import * as Field from "../../ui/field"
import * as Select from "../../ui/select"
import * as ToggleGroup from "../../ui/toggle-group"
import { type ConfigureModel, GcpFlags } from "./gcp-configure-schema"
import type { ConfigureTarget } from "./gcp-schema"
import { Message } from "./message"

// `GcpConfigure`'s writes and reads: the create, the update and the run step's scripts.

export const CONFIGURE_DIALOG_ID = "gcp-configure"

export const initConfirm = (): Dialog.Model => Dialog.init("gcp-configure-confirm", "alert-dialog")

export const flagsOf = (connector: V2GcpConnector): GcpFlags => ({
	logs_enabled: connector.logs_enabled,
	metrics_enabled: connector.metrics_enabled,
})

/** The wizard as `GcpConfigure` mounts it; `ConnectionStages` fills `opened` once it has a connector. */
export const initConfigure = (
	target: ConfigureTarget,
	connectors: ReadonlyArray<V2GcpConnector>,
	metricsAvailable: boolean,
): ConfigureModel => {
	const connector =
		target._tag === "Connection" ? connectors.find((entry) => entry.id === target.id) : undefined
	return {
		target,
		dialog: Dialog.init(CONFIGURE_DIALOG_ID, "dialog"),
		newTitle: connectors.length === 0 ? "Connect Google Cloud" : "Add connection",
		filter: { keep: null, runtimes: null },
		isFilterOpen: false,
		filterMode: Select.init("gcp-filter-mode", { value: "keep", selectedIndex: 0 }),
		created: null,
		step: "scope",
		scopeType: "project",
		scopeGroup: ToggleGroup.init({ label: "What should Maple watch?", values: ["project"] }),
		scopeId: Field.init(),
		hostProjectId: Field.init(),
		newFlags: { logs_enabled: true, metrics_enabled: metricsAvailable },
		createError: null,
		isCreating: false,
		chooseFlags:
			connector === undefined ? { logs_enabled: true, metrics_enabled: false } : flagsOf(connector),
		asked: null,
		opened: null,
		confirm: initConfirm(),
		isSaving: false,
		scripts: Keyed.idle(),
		isScriptExpanded: false,
		connectionStage: "choose",
		method: "script",
		rerun: null,
		flavourGroup: ToggleGroup.init({ label: "", values: ["terraform"] }),
		sinkExisted: false,
		manualOpen: null,
		isManualTouched: false,
		isPromptShown: false,
		promptCopied: null,
		isConfirmingRemoval: false,
	}
}

export const CreateConnector = Command.define("CreateGcpConnector", {
	args: { opens: Schema.Number, request: V2GcpCreateConnectorRequest },
	messages: [Message.CompletedGcpCreate],
	execute: ({ opens, request }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			// The client takes one object per payload variant: both branches make the same call.
			return yield* request.scope_type === "project"
				? client.gcpIntegration.createConnector({ payload: request })
				: client.gcpIntegration.createConnector({ payload: request })
		}).pipe(
			Effect.match({
				onFailure: (error) =>
					Message.CompletedGcpCreate({ opens, connector: null, failure: toLoadFailure(error) }),
				onSuccess: (connector) => Message.CompletedGcpCreate({ opens, connector, failure: null }),
			}),
		),
})

/** Only what changed is sent: an omitted capability stays as it is. */
export const UpdateConnector = Command.define("UpdateGcpConnector", {
	args: { opens: Schema.Number, id: GcpConnectorId, payload: V2GcpUpdateConnectorRequest, flags: GcpFlags },
	messages: [Message.CompletedGcpUpdate],
	execute: ({ opens, id, payload, flags }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			return yield* client.gcpIntegration.updateConnector({ params: { id }, payload })
		}).pipe(
			Effect.match({
				onFailure: (error) =>
					Message.CompletedGcpUpdate({ opens, id, flags, failure: toLoadFailure(error) }),
				onSuccess: () => Message.CompletedGcpUpdate({ opens, id, flags, failure: null }),
			}),
		),
})

/** `useGcpScripts(connector, applicationLogs)`: null keeps the sink's filter (an empty payload). */
export const LoadConfigureScripts = Command.define("LoadGcpConfigureScripts", {
	args: {
		key: Schema.String,
		id: GcpConnectorId,
		applicationLogs: Schema.NullOr(Schema.Array(GcpLogRuntime)),
	},
	messages: [Message.CompletedGcpConfigureScripts],
	execute: ({ key, id, applicationLogs }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			return yield* client.gcpIntegration.setupScripts({
				params: { id },
				payload: applicationLogs === null ? {} : { application_logs: applicationLogs },
			})
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedGcpConfigureScripts({ key, result })),
		),
})

/** `confirmRemoval`: records, on the admin's word, that what was switched off is gone. */
export const ConfirmRemoval = Command.define("ConfirmGcpRemoval", {
	args: { id: GcpConnectorId },
	messages: [Message.CompletedGcpConfirmRemoval],
	execute: ({ id }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			return yield* client.gcpIntegration.confirmRemoval({ params: { id } })
		}).pipe(
			Effect.match({
				onFailure: (error) => Message.CompletedGcpConfirmRemoval({ failure: toLoadFailure(error) }),
				onSuccess: () => Message.CompletedGcpConfirmRemoval({ failure: null }),
			}),
		),
})

/** `FileCard`'s `useCopy({ label: "prompt" })`: whether the prompt reached the clipboard. */
export const CopyPrompt = Command.define("CopyGcpPrompt", {
	args: { text: Schema.String },
	messages: [Message.CompletedGcpPromptCopy],
	execute: ({ text }) =>
		Effect.map(CopyButton.writeClipboard(text), (isCopied) =>
			Message.CompletedGcpPromptCopy({ isCopied }),
		),
})
