import { AlertDestinationId } from "@maple/domain/http"
import { Result, Schema } from "effect"
import {
	click,
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
import { CreateDestination, Message, OutMessage, init, openNew, update } from "./dialog"
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
				Message.CompletedSave({ isCreate: true, result: Result.fail({ title: "Bad", message: "nope" }) }),
			),
			expectOutMessage(
				OutMessage.RequestedToast({ type: "error", title: "Failed to save destination", description: "nope" }),
			),
		)
		const saving = update({ ...opened(), form: { ...opened().form, type: "webhook" } }, Message.ClickedSave()).model
		const created = update(saving, Message.CompletedSave({ isCreate: true, result: Result.succeed(CREATED) }))
		expect(created.outMessage).toEqual(OutMessage.CreatedDestination({ id: CREATED }))
		expect(created.model.dialog.isOpen).toBe(false)
	})

	test("a save is in flight once; a failure keeps the dialog open and reports the error", () => {
		const saving = update({ ...opened(), form: { ...opened().form, type: "webhook" } }, Message.ClickedSave())
		expect((saving.commands ?? []).map(({ name }) => name)).toEqual(["CreateAlertDestination"])
		expect(update(saving.model, Message.ClickedSave()).commands ?? []).toHaveLength(0)
		const failed = update(
			saving.model,
			Message.CompletedSave({ isCreate: true, result: Result.fail({ title: "Bad", message: "nope" }) }),
		)
		expect(failed.model.dialog.isOpen).toBe(true)
		expect(failed.outMessage).toEqual(
			OutMessage.RequestedToast({ type: "error", title: "Failed to save destination", description: "nope" }),
		)
	})
})
