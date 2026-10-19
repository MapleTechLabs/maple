import { OrgId } from "@maple/domain"
import { Schema } from "effect"
import { describe, expect, test } from "vitest"
import * as Field from "../../ui/field"
import { PageOutMessage, type PageContext } from "../contract"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const typed = (value: string): Model =>
	pageUpdate(
		init({ search: { integration: "railway" } }, context).model,
		Message.GotRailwayTokenMessage({ message: Field.Message.ChangedValue({ value }) }),
	).model

describe("railway card", () => {
	test("a short token is never sent; a valid one is sent once", () => {
		expect(names(pageUpdate(typed("abc"), Message.SubmittedRailwayToken()).commands)).toEqual([])
		const sent = pageUpdate(typed(" rw_token_0001 "), Message.SubmittedRailwayToken())
		expect(names(sent.commands)).toEqual(["ConnectRailwayFromIntegrations"])
		expect(names(pageUpdate(sent.model, Message.SubmittedRailwayToken()).commands)).toEqual([])
	})

	test("a rejection stays on the form; a success toasts, clears it and re-reads the status", () => {
		const sent = pageUpdate(typed("rw_token_0001"), Message.SubmittedRailwayToken()).model
		const rejected = pageUpdate(
			sent,
			Message.FailedRailwayConnect({ error: "Railway rejected the token." }),
		)
		expect(rejected.model.railwayCard.connect.error).toBe("Railway rejected the token.")
		const done = pageUpdate(
			sent,
			Message.SucceededRailwayConnect({ title: "Railway connected", description: "d" }),
		)
		expect(done.model.railwayCard.connect.token.value).toBe("")
		expect(done.outMessage).toEqual(
			PageOutMessage.RequestedToast({ type: "success", title: "Railway connected", description: "d" }),
		)
		expect(done.model.railwayCard.connect.isSubmitting).toBe(false)
	})

	test("a poll joins the status read in flight; a finished sync asks again anyway", () => {
		const entered = init({ search: { integration: "railway" } }, context).model
		expect(names(pageUpdate(entered, Message.TickedRailwaySettle()).commands)).toEqual([])
		expect(names(pageUpdate(entered, Message.CompletedRailwaySync({ failure: null })).commands)).toEqual([
			"LoadIntegrationsRailwayStatus",
		])
	})
})
