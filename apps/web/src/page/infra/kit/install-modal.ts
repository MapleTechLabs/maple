import { Effect, Schema } from "effect"
import { AsyncData, Command, Mount, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure, toLoadFailure } from "../../../data/load-failure"
import { MapleApiV2Client } from "../../../platform/api-clients"
import type { Resources } from "../../../platform/resources"
import * as CopyButton from "../../../ui/copy-button"
import * as Dialog from "../../../ui/dialog"
import * as Tabs from "../../../ui/tabs"

// `InstallHostModal`: Kubernetes, Docker and Host install snippets carrying the org's private ingest
// key, masked until revealed. Mounted closed on every collector-fed infra page, so the key is fetched
// on entry (`retainedQueryV2("ingestKeys")`).

export const InstallTab = Schema.Literals(["kubernetes", "docker", "hosts"])
export type InstallTab = typeof InstallTab.Type
export const INSTALL_TABS: ReadonlyArray<InstallTab> = ["kubernetes", "docker", "hosts"]

/** Which snippet a copy button copies. */
export const Snippet = Schema.Literals(["helm", "docker", "hostConfig", "host"])
export type Snippet = typeof Snippet.Type

export const IngestKeyData = AsyncData.Schema(Schema.String, LoadFailure)

export const Model = Schema.Struct({
	id: Schema.String,
	defaultTab: InstallTab,
	dialog: Dialog.Model,
	tabs: Tabs.Model,
	isRevealed: Schema.Boolean,
	ingestKey: IngestKeyData.schema,
	copies: Schema.Struct({
		helm: CopyButton.Model,
		docker: CopyButton.Model,
		hostConfig: CopyButton.Model,
		host: CopyButton.Model,
	}),
})
export type Model = typeof Model.Type

/** `id` keys the dialog; the Tabs take a fixed `idBase`. */
export const init = (id: string, defaultTab: InstallTab): Model => ({
	id,
	defaultTab,
	dialog: Dialog.init(id, "dialog"),
	tabs: Tabs.init({ idBase: 0, values: INSTALL_TABS, selected: defaultTab }),
	isRevealed: false,
	ingestKey: IngestKeyData.Idle(),
	copies: {
		helm: CopyButton.init(),
		docker: CopyButton.init(),
		hostConfig: CopyButton.init(),
		host: CopyButton.init(),
	},
})

export const Message = defineMessageUnion({
	CompletedFetchIngestKey: { result: Schema.Result(Schema.String, LoadFailure) },
	ClickedOpen: {},
	ClickedToggleReveal: {},
	MountedInstallModal: {},
	GotDialogMessage: { message: Dialog.Message },
	GotTabsMessage: { message: Tabs.Message },
	GotCopyMessage: { snippet: Snippet, message: CopyButton.Message },
})
export type Message = typeof Message.Type

export const FetchIngestKey = Command.define("FetchInstallIngestKey", {
	messages: [Message.CompletedFetchIngestKey],
	execute: Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		const response = yield* client.ingestKeys.retrieve({})
		return response.private_key
	}).pipe(
		Effect.mapError(toLoadFailure),
		Effect.result,
		Effect.map((result) => Message.CompletedFetchIngestKey({ result })),
	),
})

export type Return = Update.Return<Model, Message, Resources>

/** `retainedQueryV2("ingestKeys", "retrieve")` mounting: fetched once, when the modal first mounts. */
export const load = (model: Model): Return =>
	AsyncData.isIdle(model.ingestKey)
		? { model: { ...model, ingestKey: IngestKeyData.Loading() }, commands: [FetchIngestKey()] }
		: { model }

/** The modal mounted with the element it sits in (`InfraSetupEmpty` mounts its own). */
export const MountInstallModal = Mount.define("MountInstallModal", {
	messages: [Message.MountedInstallModal],
	execute: () => Effect.succeed(Message.MountedInstallModal()),
})

/** Closing re-masks the key and restores the caller's tab, so each open starts the same way. */
const liftDialog = (model: Model, result: ReturnType<typeof Dialog.update>): Return => {
	const isClosed = result.outMessage !== undefined && result.outMessage._tag === "Closed"
	const reset = {
		isRevealed: false,
		tabs: Tabs.init({ idBase: model.tabs.idBase, values: INSTALL_TABS, selected: model.defaultTab }),
	}
	return {
		model: isClosed ? { ...model, ...reset, dialog: result.model } : { ...model, dialog: result.model },
		commands: Command.mapMessages(result.commands ?? [], (message) =>
			Message.GotDialogMessage({ message }),
		),
	}
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		MountedInstallModal: () => load(model),
		CompletedFetchIngestKey: ({ result }) => ({
			model: { ...model, ingestKey: AsyncData.settle(model.ingestKey, result) },
		}),
		ClickedOpen: () => liftDialog(model, Dialog.open(model.dialog)),
		ClickedToggleReveal: () => ({ model: { ...model, isRevealed: !model.isRevealed } }),
		GotDialogMessage: ({ message: inner }) => liftDialog(model, Dialog.update(model.dialog, inner)),
		GotTabsMessage: ({ message: inner }) => {
			const next = Tabs.update(model.tabs, inner)
			return {
				model: { ...model, tabs: next.model },
				commands: Command.mapMessages(next.commands ?? [], (message) =>
					Message.GotTabsMessage({ message }),
				),
			}
		},
		GotCopyMessage: ({ snippet, message: inner }) => {
			const next = CopyButton.update(model.copies[snippet], inner)
			return {
				model: { ...model, copies: { ...model.copies, [snippet]: next.model } },
				commands: Command.mapMessages(next.commands ?? [], (message) =>
					Message.GotCopyMessage({ snippet, message }),
				),
			}
		},
	})
