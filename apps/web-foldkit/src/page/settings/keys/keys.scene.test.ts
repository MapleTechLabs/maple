import { V2ApiKey } from "@maple/domain/http/v2"
import { Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
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
	test("admins read the ingest pair; members never ask for it", () => {
		expect(names(init({ isAdmin: true, userId: null }).commands)).toEqual(["FetchIngestKeys"])
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

	test("revoking asks first, then toasts and closes", () => {
		const asked = update(loaded(), Message.GotRowMenuMessage({ menuId: `keys-row-${key.id}`, message: { _tag: "ClickedTrigger" } })).model
		const opened = { ...asked, revoking: key }
		const confirming = update(opened, Message.ClickedConfirmRevoke())
		expect(names(confirming.commands)).toEqual(["RevokeApiKey"])
		const done = update(confirming.model, Message.CompletedRevoke({ id: key.id, result: Result.succeed(undefined) }))
		expect(done.outMessage).toEqual(PageOutMessage.RequestedToast({ type: "success", title: "Key revoked", description: "" }))
		expect(done.model.isRevoking).toBe(false)
	})

	test("a rolled ingest key refetches the pair and says the old one stopped", () => {
		const rolling = update({ ...loaded(), ingestRollType: "ingest_private" }, Message.ClickedConfirmIngestRoll())
		expect(names(rolling.commands)).toEqual(["RollIngestKey"])
		const rolled = update(rolling.model, Message.CompletedIngestRoll({ type: "ingest_private", result: Result.succeed(undefined) }))
		expect(names(rolled.commands)).toContain("FetchIngestKeys")
		expect(rolled.outMessage).toEqual(
			PageOutMessage.RequestedToast({
				type: "success",
				title: "Private ingest key rolled. The previous key stopped working immediately.",
				description: "",
			}),
		)
	})
})
