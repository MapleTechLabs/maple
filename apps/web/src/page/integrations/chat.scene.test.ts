import { OrgId } from "@maple/domain"
import { V2ChatConnectorList } from "@maple/domain/http/v2"
import { Result, Schema, Array as Arr } from "effect"
import { click, Command, expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { PageOutMessage, type PageContext } from "../contract"
import { STATUS_READS } from "./command"
import { ChatMessage, SaveChatFeatures } from "./chat"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)

const chat = (message: ChatMessage) => Message.GotChatMessage({ message })

const WORKSPACE = "chatw_YoxMqYdzUJ1tH4BqCWxPH3"

const list = (withWorkspace: boolean) =>
	Schema.decodeSync(V2ChatConnectorList)({
		object: "chat_connector_list",
		data: [
			{
				id: "slack",
				object: "chat_connector",
				name: "Slack",
				available: true,
				supports_identity: true,
				workspaces: withWorkspace
					? [
							{
								id: WORKSPACE,
								object: "chat_workspace",
								connector: "slack",
								external_workspace_id: "T1",
								name: "Acme Shop",
								settings: {},
								alerts_enabled: true,
								direct_messages_enabled: true,
								assistant_enabled: true,
								created_at: "2026-09-10T12:00:00.000Z",
							},
						]
					: [],
			},
		],
	})

const loaded = (withWorkspace: boolean): Model => {
	const model = init({ search: { integration: "chat-slack" } }, context).model
	return pageUpdate(
		model,
		Message.CompletedLoadChat({
			key: model.statuses.chat.key ?? "",
			result: Result.succeed(list(withWorkspace)),
		}),
	).model
}

describe("chat card", () => {
	test("no workspace offers the install, which runs once and stays busy on success", () => {
		const model = loaded(false)
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(role("button", { name: "Add to Slack" })).toExist(),
		)
		const started = pageUpdate(model, chat(ChatMessage.ClickedInstall()))
		expect(names(started.commands)).toEqual(["InstallChatConnector"])
		expect(names(pageUpdate(started.model, chat(ChatMessage.ClickedInstall())).commands)).toEqual([])
		const done = pageUpdate(started.model, chat(ChatMessage.CompletedInstall({ failure: null })))
		expect(done.model.chatCard.busy).toBe("install")
		const failed = pageUpdate(
			started.model,
			chat(ChatMessage.CompletedInstall({ failure: toLoadFailure("x") })),
		)
		expect(failed.model.chatCard.busy).toBeNull()
	})

	test("disconnect keeps the dialog pending until the workspace is gone", () => {
		const model = loaded(true)
		scene({ update: pageUpdate, view }, given(model), expectView(text("Acme Shop")).toExist())
		const workspace = list(true).data[0]?.workspaces[0]
		if (workspace === undefined) throw new Error("fixture")
		const opened = pageUpdate(
			model,
			chat(ChatMessage.ClickedDisconnect({ workspaceId: workspace.id })),
		).model
		const confirmed = pageUpdate(opened, Message.ConfirmedDisconnect())
		expect(names(confirmed.commands)).toEqual(["DisconnectChatWorkspace"])
		expect(confirmed.model.disconnect.dialog.isOpen).toBe(true)
		const done = pageUpdate(confirmed.model, chat(ChatMessage.CompletedDisconnect({ failure: null })))
		expect(done.model.disconnect.dialog.isOpen).toBe(false)
		expect(done.outMessage).toEqual(
			PageOutMessage.RequestedToast({
				type: "success",
				title: "Workspace disconnected",
				description: "",
			}),
		)
		expect(names(done.commands)).toContain("LoadIntegrationsChatConnectors")
	})
})

describe("chat feature switches", () => {
	test("turning answers off saves the workspace's switches; a failed save puts it back", () => {
		const model = loaded(true)
		const workspace = list(true).data[0]?.workspaces[0]
		if (workspace === undefined) throw new Error("fixture")
		const save = SaveChatFeatures({ id: workspace.id, flag: "assistantEnabled", enabled: false })
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(role("switch", { name: "Answer questions" })).toBeChecked(),
			click(role("switch", { name: "Answer questions" })),
			Command.expectHas(save),
			expectView(role("switch", { name: "Answer questions" })).not.toBeChecked(),
			expectView(role("switch", { name: "Alert notifications" })).toBeDisabled(),
			Command.resolve(
				SaveChatFeatures,
				ChatMessage.CompletedFeatures({ failure: toLoadFailure("Workspace not found") }),
			),
			expectView(role("switch", { name: "Answer questions" })).toBeChecked(),
			expectView(text("Couldn't save that change")).toExist(),
			Command.resolve(
				STATUS_READS.chat,
				Message.CompletedLoadChat({ key: "", result: Result.succeed(list(true)) }),
			),
		)
	})
})
