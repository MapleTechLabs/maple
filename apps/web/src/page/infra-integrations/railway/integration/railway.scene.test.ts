import { OrgId } from "@maple/domain"
import { Schema, Array as Arr } from "effect"
import { describe, expect, test } from "vitest"
import * as Field from "@maple/views/ui/field"
import { PageOutMessage, type PageContext } from "../../../contract"
import { Message } from "../../../integrations/message"
import type { Model } from "../../../integrations/model"
import { init, update } from "../../../integrations/update"
import { RailwayMessage } from "./railway"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const railway = (message: RailwayMessage) => Message.GotRailwayMessage({ message })
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)

const typed = (value: string): Model =>
	pageUpdate(
		init({ search: { integration: "railway" } }, context).model,
		railway(RailwayMessage.GotTokenMessage({ message: Field.Message.ChangedValue({ value }) })),
	).model

describe("railway card", () => {
	test("a short token is never sent; a valid one is sent once", () => {
		expect(names(pageUpdate(typed("abc"), railway(RailwayMessage.SubmittedToken())).commands)).toEqual([])
		const sent = pageUpdate(typed(" rw_token_0001 "), railway(RailwayMessage.SubmittedToken()))
		expect(names(sent.commands)).toEqual(["ConnectRailwayFromIntegrations"])
		expect(names(pageUpdate(sent.model, railway(RailwayMessage.SubmittedToken())).commands)).toEqual([])
	})

	test("a rejection stays on the form; a success toasts, clears it and re-reads the status", () => {
		const sent = pageUpdate(typed("rw_token_0001"), railway(RailwayMessage.SubmittedToken())).model
		const rejected = pageUpdate(
			sent,
			railway(RailwayMessage.FailedConnect({ error: "Railway rejected the token." })),
		)
		expect(rejected.model.railwayCard.connect.error).toBe("Railway rejected the token.")
		const done = pageUpdate(
			sent,
			railway(RailwayMessage.SucceededConnect({ title: "Railway connected", description: "d" })),
		)
		expect(done.model.railwayCard.connect.token.value).toBe("")
		expect(done.outMessage).toEqual(
			PageOutMessage.RequestedToast({ type: "success", title: "Railway connected", description: "d" }),
		)
		expect(done.model.railwayCard.connect.isSubmitting).toBe(false)
	})

	test("a poll joins the status read in flight; a finished sync asks again anyway", () => {
		const entered = init({ search: { integration: "railway" } }, context).model
		expect(names(pageUpdate(entered, railway(RailwayMessage.TickedSettle())).commands)).toEqual([])
		expect(
			names(pageUpdate(entered, railway(RailwayMessage.CompletedSync({ failure: null }))).commands),
		).toEqual(["LoadIntegrationsRailwayStatus"])
	})
})
