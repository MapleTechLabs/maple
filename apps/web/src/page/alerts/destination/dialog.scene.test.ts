import { AlertDestinationId } from "@maple/domain/http"
import {
	encodePublicId,
	PublicIdPrefixes,
	V2ChatConnector,
	type V2ChatDestination,
	type V2TelegramChat,
} from "@maple/domain/http/v2"
import { Result, Schema } from "effect"
import {
	click,
	expect as expectView,
	Command,
	expectOutMessage,
	given,
	Mount,
	role,
	scene,
	text,
	type,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import * as Dialog from "../../../ui/dialog"
import { MountDialog } from "../../../ui/dialog"
import * as Combobox from "../../../ui/combobox"
import * as ChatConnect from "../shared/chat-connect"
import * as ChatFields from "./chat-fields"
import * as LinearFields from "./linear-fields"
import * as Select from "../../../ui/select"
import {
	chatConnectDependencies,
	CreateDestination,
	DetectTelegramChats,
	isFormReady,
	Message,
	OutMessage,
	init,
	openNew,
	update,
} from "./dialog"
import { view as dialogView } from "./view"

const view = withViewInputs(dialogView, { id: "test-destination" })()
const workspaceWire = (n: number, name: string) => ({
	id: encodePublicId(PublicIdPrefixes.chatWorkspace, `0199a0d5-0000-7000-8000-00000000000${n}`),
	object: "chat_workspace",
	connector: "slack",
	external_workspace_id: `T0${n}`,
	name,
	settings: {},
	created_at: "2026-09-01T00:00:00.000Z",
})
const slack = (workspaces: ReadonlyArray<ReturnType<typeof workspaceWire>>) =>
	Schema.decodeUnknownSync(V2ChatConnector)({
		id: "slack",
		object: "chat_connector",
		name: "Slack",
		available: true,
		workspaces,
		supports_identity: true,
	})
const channel = (id: string, name: string, isPrivate = false): V2ChatDestination => ({
	id,
	name,
	private: isPrivate,
})
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)
const opened = () => openNew(init("test-destination")).model
const CREATED = Schema.decodeSync(AlertDestinationId)("0199a001-0000-7000-8000-0000000000ff")

describe("destination dialog", () => {
	test("opening a new destination fetches the chat connectors once", () => {
		const first = openNew(init("test-destination"))
		expect((first.commands ?? []).map(({ name }) => name)).toContain("FetchChatConnectors")
	})

	test("a webhook destination is created from its URL", () => {
		scene(
			{ update, view },
			given(opened()),
			Mount.resolve(MountDialog, Dialog.Message.CompletedMountDialog()),
			click(role("button", { name: /^Webhook/ })),
			type(role("textbox", { name: "Webhook URL" }), "https://hooks.acme.test/new"),
			click(role("button", { name: "Add Webhook destination" })),
			Command.resolve(
				CreateDestination,
				Message.CompletedSave({
					openCount: 1,
					isCreate: true,
					result: Result.fail({ title: "Bad", message: "nope" }),
				}),
			),
			expectOutMessage(
				OutMessage.RequestedToast({
					type: "error",
					title: "Failed to save destination",
					description: "nope",
				}),
			),
		)
		const saving = update(
			{ ...opened(), form: { ...opened().form, type: "webhook" } },
			Message.ClickedSave(),
		).model
		const created = update(
			saving,
			Message.CompletedSave({ openCount: 1, isCreate: true, result: Result.succeed(CREATED) }),
		)
		expect(created.outMessage).toEqual(OutMessage.CreatedDestination({ id: CREATED }))
		expect(created.model.dialog.isOpen).toBe(false)
	})

	test("Detect chats fills its own token's only chat, never an older token's", () => {
		const token = "123456:abcdefghijklmnopqrstuvwxyz0123456789"
		const chat: V2TelegramChat = { id: "-100777", title: "On-call", type: "group" }
		const detect = (botToken: string) =>
			Command.resolve(
				DetectTelegramChats,
				Message.CompletedDetectChats({ openCount: 1, botToken, result: Result.succeed([chat]) }),
			)
		scene(
			{ update, view },
			given(opened()),
			Mount.resolve(MountDialog, Dialog.Message.CompletedMountDialog()),
			click(role("button", { name: /^Telegram/ })),
			type(role("textbox", { name: "Bot token" }), token),
			click(role("button", { name: "Detect chats" })),
			detect("999999:an-older-token-the-form-no-longer-holds"),
			expectView(role("textbox", { name: "Chat ID" })).toHaveValue(""),
			click(role("button", { name: "Detect chats" })),
			detect(token),
			expectView(role("textbox", { name: "Chat ID" })).toHaveValue("-100777"),
		)
	})

	test("a Detect chats answer from before a reopen never fills the reopened form", () => {
		const token = "123456:abcdefghijklmnopqrstuvwxyz0123456789"
		const chat: V2TelegramChat = { id: "-100777", title: "On-call", type: "group" }
		const telegram = {
			...opened(),
			form: { ...opened().form, type: "telegram" as const, telegramBotToken: token },
		}
		const detecting = update(telegram, Message.ClickedDetectChats()).model
		const reopened = openNew(update(detecting, Message.ClickedCancel()).model).model
		const onB = {
			...reopened,
			form: { ...reopened.form, type: "telegram" as const, telegramBotToken: token },
		}
		expect(onB.isDetectingChats).toBe(false)
		const late = update(
			onB,
			Message.CompletedDetectChats({ openCount: 1, botToken: token, result: Result.succeed([chat]) }),
		)
		expect(late.model.form.telegramChatId).toBe("")
	})

	test("a linked Slack workspace lists its channels; picking one makes the destination savable", () => {
		const withSlack = update(
			opened(),
			Message.CompletedFetchConnectors({ connectors: [slack([workspaceWire(1, "Acme Shop")])] }),
		).model
		const workspaceId = withSlack.connectors?.[0]?.workspaces[0]?.id ?? ""
		const picked = update(withSlack, Message.ClickedChatWorkspace({ connector: "slack", workspaceId }))
		expect(names(picked.commands)).toEqual(["FetchAlertChatChannels"])
		expect(isFormReady(picked.model.form, false)).toBe(false)
		const listed = update(
			picked.model,
			Message.GotChatFieldsMessage({
				message: ChatFields.Message.CompletedFetchChannels({
					key: picked.model.chat.channels.key ?? "",
					result: Result.succeed([channel("C1", "incidents"), channel("C2", "ops", true)]),
				}),
			}),
		).model
		scene(
			{ update, view },
			given(listed),
			Mount.resolve(MountDialog, Dialog.Message.CompletedMountDialog()),
			expectView(role("combobox", { name: "Channel" })).toExist(),
		)
		const chosen = update(
			listed,
			Message.GotChatFieldsMessage({
				message: ChatFields.Message.GotComboboxMessage({
					message: Combobox.Message.ClickedItem({ value: "#ops (private)" }),
				}),
			}),
		).model
		expect([chosen.form.chatChannelId, chosen.form.chatChannelName]).toEqual(["C2", "ops"])
		expect(isFormReady(chosen.form, false)).toBe(true)
		expect(names(update(chosen, Message.ClickedSave()).commands)).toEqual(["CreateAlertDestination"])
	})

	test("Connect on an unlinked Slack links it in a popup, then the new workspace is the form's", () => {
		const unlinked = update(opened(), Message.CompletedFetchConnectors({ connectors: [slack([])] })).model
		scene(
			{ update, view },
			given(unlinked),
			Mount.resolve(MountDialog, Dialog.Message.CompletedMountDialog()),
			expectView(text("Connect a Slack workspace, then pick a channel.")).toExist(),
		)
		const connecting = update(unlinked, Message.ClickedConnectChat({ connector: "slack" })).model
		expect(chatConnectDependencies(connecting).phase).toBe("popup")
		const attempt = connecting.chatConnect.active?.attempt ?? 0
		const polled = update(
			connecting,
			Message.GotChatConnectMessage({ message: ChatConnect.Message.Polled({ attempt }) }),
		)
		expect(names(polled.commands)).toEqual(["FetchChatConnectors"])
		const linked = update(
			polled.model,
			Message.CompletedFetchConnectors({ connectors: [slack([workspaceWire(2, "Acme Ops")])] }),
		)
		expect(linked.model.form.type).toBe("chat")
		expect(linked.model.form.chatWorkspaceId).toBe(linked.model.connectors?.[0]?.workspaces[0]?.id)
		expect(chatConnectDependencies(linked.model).phase).toBe("idle")
		expect(names(linked.commands)).toEqual(["FetchAlertChatChannels"])
	})

	test("the Slack tile says to finish in its window while the popup is out and through the close grace", () => {
		const unlinked = update(opened(), Message.CompletedFetchConnectors({ connectors: [slack([])] })).model
		const connecting = update(unlinked, Message.ClickedConnectChat({ connector: "slack" })).model
		const attempt = connecting.chatConnect.active?.attempt ?? 0
		const chat = (message: ChatConnect.Message) => (model: typeof unlinked) =>
			update(model, Message.GotChatConnectMessage({ message })).model
		const started = chat(ChatConnect.Message.SucceededStart({ attempt }))(connecting)
		// The install's reactivity keys re-read the connectors.
		const startStep = update(
			connecting,
			Message.GotChatConnectMessage({ message: ChatConnect.Message.SucceededStart({ attempt }) }),
		)
		expect(names(startStep.commands)).toEqual(["FetchChatConnectors"])
		// Slack's consent page severs the opener: the popup reads closed while the user still authorizes.
		const severed = chat(ChatConnect.Message.ClosedPopup({ attempt }))(started)
		const waiting = "Finish in the Slack window. This form stays as it is."
		const shows = (model: typeof unlinked, line: string) =>
			scene(
				{ update, view },
				given(model),
				Mount.resolve(MountDialog, Dialog.Message.CompletedMountDialog()),
				expectView(text(line)).toExist(),
			)
		shows(connecting, waiting)
		shows(started, waiting)
		shows(severed, waiting)
		shows(
			chat(ChatConnect.Message.EndedGrace({ attempt }))(severed),
			"Connect a Slack workspace, then pick a channel.",
		)
	})

	test("Linear checks the connection, then a picked team is saved as the destination's", () => {
		const chosen = update(opened(), Message.ClickedProvider({ type: "linear" }))
		expect(names(chosen.commands)).toContain("FetchAlertLinearStatus")
		const linear = (model: typeof chosen.model, message: LinearFields.Message) =>
			update(model, Message.GotLinearFieldsMessage({ message }))
		const connected = linear(
			chosen.model,
			LinearFields.Message.CompletedFetchStatus({
				key: chosen.model.linear.status.key ?? "",
				result: Result.succeed({ connected: true, revoked: false, workspaceName: "Acme" }),
			}),
		)
		expect(names(connected.commands)).toEqual(["FetchAlertLinearTeams"])
		const listed = linear(
			connected.model,
			LinearFields.Message.CompletedFetchTeams({
				key: connected.model.linear.teams.key ?? "",
				result: Result.succeed([{ id: "team_eng", key: "ENG", name: "Engineering" }]),
			}),
		).model
		expect(isFormReady(listed.form, false)).toBe(false)
		const picked = linear(
			listed,
			LinearFields.Message.GotTeamSelectMessage({
				message: Select.Message.SelectedItem({ index: 0, value: "team_eng" }),
			}),
		).model
		const saved = update(picked, Message.ClickedSave())
		expect(names(saved.commands)).toEqual(["CreateAlertDestination"])
		scene(
			{ update, view },
			given(picked),
			Mount.resolve(MountDialog, Dialog.Message.CompletedMountDialog()),
			expectView(role("combobox", { name: "Linear team" })).toExist(),
			click(role("button", { name: "Add Linear destination" })),
			Command.resolve(
				CreateDestination,
				Message.CompletedSave({
					openCount: 1,
					isCreate: true,
					result: Result.fail({ title: "Bad", message: "no team" }),
				}),
			),
			expectOutMessage(
				OutMessage.RequestedToast({
					type: "error",
					title: "Failed to save destination",
					description: "no team",
				}),
			),
		)
	})

	test("Linear not connected offers to connect it and cannot be saved", () => {
		scene(
			{ update, view },
			given(opened()),
			Mount.resolve(MountDialog, Dialog.Message.CompletedMountDialog()),
			click(role("button", { name: /^Linear/ })),
			expectView(text("Checking your Linear connection…")).toExist(),
			Command.resolve(
				LinearFields.FetchIsAdmin,
				LinearFields.Message.CompletedFetchIsAdmin({ isAdmin: true }),
			),
			Command.resolve(
				LinearFields.FetchStatus,
				LinearFields.Message.CompletedFetchStatus({
					key: LinearFields.STATUS_KEY,
					result: Result.succeed({ connected: false, revoked: false, workspaceName: null }),
				}),
			),
			expectView(role("button", { name: "Connect Linear" })).toExist(),
		)
		const chosen = update(opened(), Message.ClickedProvider({ type: "linear" })).model
		const disconnected = update(
			chosen,
			Message.GotLinearFieldsMessage({
				message: LinearFields.Message.CompletedFetchStatus({
					key: chosen.linear.status.key ?? "",
					result: Result.succeed({ connected: false, revoked: false, workspaceName: null }),
				}),
			}),
		)
		expect(names(disconnected.commands)).toEqual([])
		scene(
			{ update, view },
			given(disconnected.model),
			Mount.resolve(MountDialog, Dialog.Message.CompletedMountDialog()),
			expectView(role("button", { name: "Connect Linear" })).toExist(),
			expectView(role("button", { name: "Add Linear destination" })).toBeDisabled(),
		)
	})

	test("a save is in flight once; a failure keeps the dialog open and reports the error", () => {
		const saving = update(
			{ ...opened(), form: { ...opened().form, type: "webhook" } },
			Message.ClickedSave(),
		)
		expect((saving.commands ?? []).map(({ name }) => name)).toEqual(["CreateAlertDestination"])
		expect(update(saving.model, Message.ClickedSave()).commands ?? []).toHaveLength(0)
		const failed = update(
			saving.model,
			Message.CompletedSave({
				openCount: 1,
				isCreate: true,
				result: Result.fail({ title: "Bad", message: "nope" }),
			}),
		)
		expect(failed.model.dialog.isOpen).toBe(true)
		expect(failed.outMessage).toEqual(
			OutMessage.RequestedToast({
				type: "error",
				title: "Failed to save destination",
				description: "nope",
			}),
		)
	})

	test("a reopen mid-save allows no second submit, and the late result leaves the new form open", () => {
		const saving = update(
			{ ...opened(), form: { ...opened().form, type: "webhook" } },
			Message.ClickedSave(),
		).model
		const reopened = openNew(update(saving, Message.ClickedCancel()).model).model
		const onB = { ...reopened, form: { ...reopened.form, type: "webhook" as const } }
		expect(update(onB, Message.ClickedSave()).commands ?? []).toHaveLength(0)
		const late = update(
			onB,
			Message.CompletedSave({ openCount: 1, isCreate: true, result: Result.succeed(CREATED) }),
		)
		expect(late.model.dialog.isOpen).toBe(true)
		expect(late.model.isSaving).toBe(false)
		expect(late.outMessage).toEqual(OutMessage.CreatedDestination({ id: CREATED }))
	})
})

describe("Google Chat destination form", () => {
	const form = (webhookUrl: string) => ({ ...opened().form, type: "google-chat" as const, webhookUrl })

	test("saves only a space's webhook URL with its key and token", () => {
		expect(
			isFormReady(form("https://chat.googleapis.com/v1/spaces/AAAA/messages?key=k&token=t"), false),
		).toBe(true)
		expect(isFormReady(form("https://chat.google.com/room/AAAA"), false)).toBe(false)
		expect(
			isFormReady(form("https://chat.googleapis.com/v1/spaces/AAAA/messages?key=k&token="), false),
		).toBe(false)
	})

	test("keeps the stored webhook when an edit leaves the URL blank", () => {
		expect(isFormReady({ ...form(""), name: "Ops" }, true)).toBe(true)
	})
})
