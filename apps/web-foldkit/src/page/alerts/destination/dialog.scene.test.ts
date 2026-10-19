import { AlertDestinationId } from "@maple/domain/http"
import type { V2TelegramChat } from "@maple/domain/http/v2"
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
	type,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import * as Dialog from "../../../ui/dialog"
import { MountDialog } from "../../../ui/dialog"
import { CreateDestination, DetectTelegramChats, Message, OutMessage, init, openNew, update } from "./dialog"
import { view as dialogView } from "./view"

const view = withViewInputs(dialogView, { id: "test-destination" })()
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
				Message.CompletedSave({ openCount: 1, isCreate: true, result: Result.fail({ title: "Bad", message: "nope" }) }),
			),
			expectOutMessage(
				OutMessage.RequestedToast({ type: "error", title: "Failed to save destination", description: "nope" }),
			),
		)
		const saving = update({ ...opened(), form: { ...opened().form, type: "webhook" } }, Message.ClickedSave()).model
		const created = update(saving, Message.CompletedSave({ openCount: 1, isCreate: true, result: Result.succeed(CREATED) }))
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
		const telegram = { ...opened(), form: { ...opened().form, type: "telegram" as const, telegramBotToken: token } }
		const detecting = update(telegram, Message.ClickedDetectChats()).model
		const reopened = openNew(update(detecting, Message.ClickedCancel()).model).model
		const onB = { ...reopened, form: { ...reopened.form, type: "telegram" as const, telegramBotToken: token } }
		expect(onB.isDetectingChats).toBe(false)
		const late = update(onB, Message.CompletedDetectChats({ openCount: 1, botToken: token, result: Result.succeed([chat]) }))
		expect(late.model.form.telegramChatId).toBe("")
	})

	test("a save is in flight once; a failure keeps the dialog open and reports the error", () => {
		const saving = update({ ...opened(), form: { ...opened().form, type: "webhook" } }, Message.ClickedSave())
		expect((saving.commands ?? []).map(({ name }) => name)).toEqual(["CreateAlertDestination"])
		expect(update(saving.model, Message.ClickedSave()).commands ?? []).toHaveLength(0)
		const failed = update(
			saving.model,
			Message.CompletedSave({ openCount: 1, isCreate: true, result: Result.fail({ title: "Bad", message: "nope" }) }),
		)
		expect(failed.model.dialog.isOpen).toBe(true)
		expect(failed.outMessage).toEqual(
			OutMessage.RequestedToast({ type: "error", title: "Failed to save destination", description: "nope" }),
		)
	})

	test("a reopen mid-save allows no second submit, and the late result leaves the new form open", () => {
		const saving = update({ ...opened(), form: { ...opened().form, type: "webhook" } }, Message.ClickedSave()).model
		const reopened = openNew(update(saving, Message.ClickedCancel()).model).model
		const onB = { ...reopened, form: { ...reopened.form, type: "webhook" as const } }
		expect(update(onB, Message.ClickedSave()).commands ?? []).toHaveLength(0)
		const late = update(onB, Message.CompletedSave({ openCount: 1, isCreate: true, result: Result.succeed(CREATED) }))
		expect(late.model.dialog.isOpen).toBe(true)
		expect(late.model.isSaving).toBe(false)
		expect(late.outMessage).toEqual(OutMessage.CreatedDestination({ id: CREATED }))
	})
})
