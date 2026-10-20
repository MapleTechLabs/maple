import { V2ApiKey, V2ApiKeyWithSecret } from "@maple/domain/http/v2"
import { Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
import * as Dialog from "../../../ui/dialog"
import * as Field from "../../../ui/field"
import { PageOutMessage } from "../../contract"
import * as CreateDialog from "./create-dialog"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"

const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) => (commands ?? []).map(({ name }) => name)

const key = Schema.decodeUnknownSync(V2ApiKey)({
	id: "key_aXwpxqBkqtYwtBtmsGbR41",
	object: "api_key",
	name: "CI deploy",
	description: null,
	key_prefix: "maple_ak_0003",
	kind: "standard",
	scopes: ["alerts:write"],
	revoked: false,
	revoked_at: null,
	last_used_at: null,
	expires_at: null,
	created_at: "2026-10-01T12:00:00.000Z",
	created_by: "user_2Nk8mXqPfR3yZ1aB4cD5eF6g",
	created_by_email: "ada@acme.test",
})

const loaded = (): Model => update(init({ isAdmin: true, userId: null }).model, Message.UpdatedApiKeys({ rows: [key] })).model
const create = (message: CreateDialog.Message) => Message.GotCreateMessage({ message })
const steps = (model: Model, messages: ReadonlyArray<Message>) =>
	messages.reduce((current, message) => update(current, message).model, model)

describe("keys tab", () => {
	test("entry reads nothing: the keys follow the synced shape and ingest keys live in Ingestion", () => {
		expect(names(init({ isAdmin: true, userId: null }).commands)).toEqual([])
		expect(names(init({ isAdmin: false, userId: "user_1" }).commands)).toEqual([])
	})

	test("Create stays blocked until the key has a name, then posts the restricted scopes", () => {
		const opened = update(loaded(), Message.ClickedCreateKey()).model
		expect(update(opened, create(CreateDialog.Message.ClickedCreate())).commands ?? []).toEqual([])
		const filled = steps(opened, [
			create(CreateDialog.Message.GotNameMessage({ message: Field.Message.ChangedValue({ value: " Grafana " }) })),
			create(CreateDialog.Message.ClickedAccessMode({ mode: "restricted" })),
			create(CreateDialog.Message.ClickedScopeLevel({ family: "dashboards", level: "read" })),
		])
		const submitted = update(filled, create(CreateDialog.Message.ClickedCreate()))
		expect(names(submitted.commands)).toEqual(["CreateApiKey"])
		expect(submitted.commands?.[0]).toMatchObject({
			args: { payload: { name: "Grafana", kind: "standard", scopes: ["dashboards:read"] } },
		})
	})

	test("Escape mid-create keeps the create in flight; reopening shows the one-time secret", () => {
		const opened = update(loaded(), Message.ClickedCreateKey()).model
		const named = steps(opened, [
			create(CreateDialog.Message.GotNameMessage({ message: Field.Message.ChangedValue({ value: "Grafana" }) })),
		])
		const creating = update(named, create(CreateDialog.Message.ClickedCreate())).model
		const dismissed = steps(creating, [create(CreateDialog.Message.GotDialogMessage({ message: Dialog.Message.PressedEscape() }))])
		const reopened = update(dismissed, Message.ClickedCreateKey()).model
		const refilled = steps(reopened, [
			create(CreateDialog.Message.GotNameMessage({ message: Field.Message.ChangedValue({ value: "Again" }) })),
		])
		expect(names(update(refilled, create(CreateDialog.Message.ClickedCreate())).commands)).toEqual([])
		const secret = Schema.decodeUnknownSync(V2ApiKeyWithSecret)({ ...Schema.encodeSync(V2ApiKey)(key), secret: "maple_ak_secret" })
		const landed = steps(dismissed, [create(CreateDialog.Message.CompletedCreate({ kind: "standard", result: Result.succeed(secret) }))])
		expect(update(landed, Message.ClickedCreateKey()).model.create.created?.secret).toBe("maple_ak_secret")
	})

	test("revoking asks first, then toasts and closes", () => {
		const asked = update(loaded(), Message.GotRowMenuMessage({ menuId: `keys-row-${key.id}`, message: { _tag: "ClickedTrigger" } })).model
		const opened = { ...asked, revoking: key }
		const confirming = update(opened, Message.ClickedConfirmRevoke())
		expect(names(confirming.commands)).toEqual(["RevokeApiKey"])
		const done = update(confirming.model, Message.CompletedRevoke({ id: key.id, result: Result.succeed(undefined) }))
		expect(done.outMessage).toEqual(PageOutMessage.RequestedToast({ type: "success", title: "Key revoked", description: "" }))
		expect(done.model.isRevoking).toBe(false)
	})
})
