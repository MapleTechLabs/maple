import { OrgId } from "@maple/domain"
import { V2ChatConnectorList } from "@maple/domain/http/v2"
import { Result, Schema } from "effect"
import { expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../data/load-failure"
import { PageOutMessage, type PageContext } from "../contract"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const WORKSPACE = "chatw_YoxMqYdzUJ1tH4BqCWxPH3"

const list = (withWorkspace: boolean) =>
	Schema.decodeUnknownSync(V2ChatConnectorList)({
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
		const started = pageUpdate(model, Message.ClickedChatInstall())
		expect(names(started.commands)).toEqual(["InstallChatConnector"])
		expect(names(pageUpdate(started.model, Message.ClickedChatInstall()).commands)).toEqual([])
		const done = pageUpdate(started.model, Message.CompletedChatInstall({ failure: null }))
		expect(done.model.chatCard.busy).toBe("install")
		const failed = pageUpdate(
			started.model,
			Message.CompletedChatInstall({ failure: toLoadFailure("x") }),
		)
		expect(failed.model.chatCard.busy).toBeNull()
	})

	test("disconnect keeps the dialog pending until the workspace is gone", () => {
		const model = loaded(true)
		scene({ update: pageUpdate, view }, given(model), expectView(text("Acme Shop")).toExist())
		const workspace = list(true).data[0]?.workspaces[0]
		if (workspace === undefined) throw new Error("fixture")
		const opened = pageUpdate(model, Message.ClickedChatDisconnect({ workspaceId: workspace.id })).model
		const confirmed = pageUpdate(opened, Message.ConfirmedDisconnect())
		expect(names(confirmed.commands)).toEqual(["DisconnectChatWorkspace"])
		expect(confirmed.model.disconnect.dialog.isOpen).toBe(true)
		const done = pageUpdate(confirmed.model, Message.CompletedChatDisconnect({ failure: null }))
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
