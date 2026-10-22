import { defaultDestinationForm } from "@maple/web-data/alerts/form-utils"
import { Result } from "effect"
import { describe, expect, test } from "vitest"
import * as Select from "../../../ui/select"
import { isFormReady } from "./dialog"
import type { DestinationForm } from "./form"
import { init, Message, type Model, reset, update } from "./hazel-fields"

const names = (step: { readonly commands: ReadonlyArray<{ readonly name: string }> }) => step.commands.map(({ name }) => name)
const form = defaultDestinationForm("hazel-oauth")
const org = { id: "org_hz_1", name: "Acme", logoUrl: null }

const connected = (): Model => {
	const mounted = reset(init(), form).model
	const status = update(
		mounted,
		Message.CompletedFetchStatus({ key: mounted.status.key ?? "", result: Result.succeed({ connected: true, account: "ada@acme.test" }) }),
		form,
	).model
	return update(
		status,
		Message.CompletedFetchOrganizations({ key: status.organizations.key ?? "", result: Result.succeed([org]) }),
		form,
	).model
}

const pick = (model: Model, current: DestinationForm, select: "organization" | "channel", value: string) => {
	const message = Select.Message.SelectedItem({ index: 0, value })
	return select === "organization"
		? update(model, Message.GotOrganizationSelectMessage({ message }), current)
		: update(model, Message.GotChannelSelectMessage({ message }), current)
}

describe("hazel destination fields", () => {
	test("mounting reads the status and organizations; an organization's channels follow its pick", () => {
		expect(names(reset(init(), form))).toEqual(
			expect.arrayContaining(["FetchAlertHazelStatus", "FetchAlertHazelOrganizations"]),
		)
		const picked = pick(connected(), form, "organization", org.id)
		expect(names(picked)).toEqual(["FetchAlertHazelChannels"])
		const withOrg = { ...form, ...picked.form }
		expect(withOrg.hazelOrganizationName).toBe("Acme")
		const listed = update(
			picked.model,
			Message.CompletedFetchChannels({
				key: picked.model.channels.key ?? "",
				result: Result.succeed([{ id: "ch_1", name: "alerts", isPrivate: false }]),
			}),
			withOrg,
		).model
		const chosen = { ...withOrg, ...pick(listed, withOrg, "channel", "ch_1").form }
		expect(isFormReady(chosen, false)).toBe(true)
	})

	test("Connect starts once, and a started connect re-reads what it invalidates", () => {
		const started = update(connected(), Message.ClickedConnect(), form)
		expect(names(started)).toEqual(["ConnectAlertHazel"])
		expect(update(started.model, Message.ClickedConnect(), form).commands).toEqual([])
		const done = update(started.model, Message.CompletedConnect({ isStarted: true }), form)
		expect(names(done)).toEqual(
			expect.arrayContaining(["FetchAlertHazelStatus", "FetchAlertHazelOrganizations"]),
		)
	})

	test("a confirmed disconnect clears the picked organization and channel", () => {
		const confirmed = update(connected(), Message.ConfirmedDisconnect(), form)
		expect(names(confirmed)).toContain("DisconnectAlertHazel")
		const done = update(confirmed.model, Message.CompletedDisconnect(), { ...form, hazelOrganizationId: "org_hz_1" })
		expect(done.form?.hazelOrganizationId).toBe("")
	})
})
