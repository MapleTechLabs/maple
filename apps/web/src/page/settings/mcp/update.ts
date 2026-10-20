import { Array, Option, Result } from "effect"
import { AsyncData, Command } from "foldkit"
import { PageOutMessage, type PageReturn } from "../../contract"
import { revisitData } from "../kit/revisit"
import * as CopyButton from "../../../ui/copy-button"
import * as Dialog from "../../../ui/dialog"
import * as Tabs from "../../../ui/tabs"
import * as CreateKey from "../keys/create-dialog"
import { FetchConnections, FetchTools, RevokeConnection } from "./command"
import { Message } from "./message"
import { CLIENT_VALUES, type Model } from "./model"

type Return = PageReturn<Model, Message>

/** The client Tabs' id base. */
const TABS_ID_BASE = 12

export const init = (): Return => ({
	model: {
		client: Tabs.init({ idBase: TABS_ID_BASE, values: CLIENT_VALUES, selected: "claude-code" }),
		serverUrlCopy: CopyButton.init(),
		snippetCopies: {},
		createdSecret: null,
		createKey: CreateKey.init("mcp-create-key"),
		connections: AsyncData.Loading(),
		revoking: null,
		revokeDialog: Dialog.init("mcp-revoke", "alert-dialog"),
		isRevoking: false,
		tools: AsyncData.Loading(),
		toolSearch: "",
		flippedGroups: [],
		expandedGroups: [],
	},
	commands: [FetchConnections(), FetchTools()],
})

const toggled = (values: ReadonlyArray<string>, value: string): ReadonlyArray<string> =>
	values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value]

const liftRevokeDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, revokeDialog: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotRevokeDialogMessage({ message })),
})

/** `onCreated`: the new secret goes into every snippet. */
const liftCreateKey = (model: Model, step: ReturnType<typeof CreateKey.update>): Return => {
	const out = step.outMessage
	return {
		model: {
			...model,
			createKey: step.model,
			createdSecret: out?._tag === "CreatedKey" ? out.secret : model.createdSecret,
		},
		commands: Command.mapMessages(step.commands ?? [], (inner) => Message.GotCreateKeyMessage({ message: inner })),
		outMessage:
			out?._tag === "RequestedToast"
				? PageOutMessage.RequestedToast({ type: out.type, title: out.title, description: out.description })
				: undefined,
	}
}

/** Back on the tab: connections and tools stay up while they load again. */
export const revisit = (model: Model): Return => {
	const connections = revisitData(model.connections, FetchConnections)
	const tools = revisitData(model.tools, FetchTools)
	return {
		model: { ...model, connections: connections.data, tools: tools.data },
		commands: [...connections.commands, ...tools.commands],
	}
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		CompletedFetchConnections: ({ result }) => ({
			model: { ...model, connections: AsyncData.settle(model.connections, result) },
		}),
		CompletedFetchTools: ({ result }) => ({ model: { ...model, tools: AsyncData.settle(model.tools, result) } }),
		GotClientTabsMessage: ({ message: child }) => {
			const step = Tabs.update(model.client, child)
			// Base UI unmounts the inactive panels, so their copy states start over.
			const isSwitch = step.model.selected !== model.client.selected
			return {
				model: { ...model, client: step.model, snippetCopies: isSwitch ? {} : model.snippetCopies },
				commands: Command.mapMessages(step.commands, (inner) => Message.GotClientTabsMessage({ message: inner })),
			}
		},
		GotServerUrlCopyMessage: ({ message: child }) => {
			const step = CopyButton.update(model.serverUrlCopy, child)
			return {
				model: { ...model, serverUrlCopy: step.model },
				commands: Command.mapMessages(step.commands, (inner) => Message.GotServerUrlCopyMessage({ message: inner })),
			}
		},
		GotSnippetCopyMessage: ({ snippet, message: child }) => {
			const step = CopyButton.update(model.snippetCopies[snippet] ?? CopyButton.init(), child)
			return {
				model: { ...model, snippetCopies: { ...model.snippetCopies, [snippet]: step.model } },
				commands: Command.mapMessages(step.commands, (inner) =>
					Message.GotSnippetCopyMessage({ snippet, message: inner }),
				),
			}
		},
		ClickedCreateMcpKey: () => liftCreateKey(model, CreateKey.open(model.createKey, "mcp")),
		GotCreateKeyMessage: ({ message: child }) => liftCreateKey(model, CreateKey.update(model.createKey, child)),
		ClickedRevoke: ({ connectionId }) =>
			Option.match(
				Option.flatMap(AsyncData.getData(model.connections), (rows) =>
					Array.findFirst(rows, (row) => row.id === connectionId),
				),
				{
					onNone: () => ({ model }),
					onSome: (connection) =>
						liftRevokeDialog({ ...model, revoking: connection }, Dialog.open(model.revokeDialog)),
				},
			),
		GotRevokeDialogMessage: ({ message: child }) =>
			model.isRevoking ? { model } : liftRevokeDialog(model, Dialog.update(model.revokeDialog, child)),
		ClickedConfirmRevoke: () =>
			model.isRevoking || model.revoking === null
				? { model }
				: {
						model: { ...model, isRevoking: true },
						commands: [RevokeConnection({ connectionId: model.revoking.id })],
					},
		CompletedRevoke: ({ result }) =>
			Result.match(result, {
				onSuccess: () => {
					const closed = liftRevokeDialog({ ...model, isRevoking: false }, Dialog.close(model.revokeDialog))
					return {
						...closed,
						commands: [...(closed.commands ?? []), FetchConnections()],
						outMessage: PageOutMessage.RequestedToast({
							type: "success",
							title: "Client signed out",
							description: "",
						}),
					}
				},
				onFailure: (error) => ({
					model: { ...model, isRevoking: false },
					outMessage: PageOutMessage.RequestedToast({
						type: "error",
						title: "Failed to revoke the client",
						description: error.message,
					}),
				}),
			}),
		ChangedToolSearch: ({ value }) => ({ model: { ...model, toolSearch: value } }),
		ClickedClearToolSearch: () => ({ model: { ...model, toolSearch: "" } }),
		ToggledToolGroup: ({ groupId }) =>
			model.toolSearch.trim() !== ""
				? { model }
				: { model: { ...model, flippedGroups: toggled(model.flippedGroups, groupId) } },
		ClickedShowAllTools: ({ groupId }) => ({
			model: { ...model, expandedGroups: toggled(model.expandedGroups, groupId) },
		}),
	})
