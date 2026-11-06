import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import { SloPublicId } from "@maple/domain/http/v2"
import { Result, Schema, Array as Arr } from "effect"
import { click, expect as expectView, given, role, scene, text, type, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "@maple/views/data/load-failure"
import * as Menu from "@maple/views/ui/menu"
import { PageOutMessage, type PageContext } from "../../contract"
import { sloHref } from "../shared/slo-commands"
import { checkoutSlo, searchSlo } from "../shared/slo-test-fixtures"
import { DESTINATION_ID, destinationRow, ORG } from "../shared/test-rows"
import { wirePayload } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const ENGINEER = Policy.grantsOf(["org:engineer"])
const MEMBER = Policy.grantsOf(["org:member"])

const orgId = Schema.decodeSync(OrgId)(ORG)
const publicId = Schema.encodeSync(SloPublicId)
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)

const steps = (model: Model, messages: ReadonlyArray<Message>): Model =>
	Arr.reduce(messages, model, (current, message) => pageUpdate(current, message).model)

const fresh = (search: Model["search"] = {}, grants = ENGINEER): Model =>
	steps(init({ _tag: "AlertsSloNew", search }, context).model, [
		Message.CompletedFetchSession({ orgId: ORG, grants }),
		Message.CompletedFetchServices({ services: ["checkout", "search"] }),
		Message.UpdatedDestinations({ orgId: ORG, rows: [destinationRow()] }),
	])

const named = (): Model =>
	steps(fresh(), [
		Message.ChangedText({ field: "name", value: "Checkout API" }),
		Message.ChangedText({ field: "serviceName", value: "checkout" }),
	])

describe("SLO form", () => {
	test("a new SLO lists what is missing and cannot be created", () => {
		scene(
			{ update: pageUpdate, view },
			given(fresh()),
			expectView(role("heading", { name: "New SLO" })).toExist(),
			expectView(text("Name the SLO.")).toExist(),
			expectView(text("Pick a service.")).toExist(),
			expectView(role("button", { name: "Create SLO" })).toBeDisabled(),
		)
	})

	test("a custom target outside 50% to 99.999% blocks saving until it is in range", () => {
		scene(
			{ update: pageUpdate, view },
			given(named()),
			click(role("button", { name: "Custom" })),
			type(role("textbox", { name: "Custom target" }), "99.9999"),
			expectView(text("Set a target between 50% and 99.999%.")).toExist(),
			expectView(role("button", { name: "Create SLO" })).toBeDisabled(),
		)
		scene(
			{ update: pageUpdate, view },
			given(named()),
			click(role("button", { name: "Custom" })),
			type(role("textbox", { name: "Custom target" }), "99.8"),
			expectView(text("Ready to save")).toExist(),
			expectView(role("button", { name: "Create SLO" })).not.toBeDisabled(),
		)
	})

	test("the target's hint says what budget it leaves over the window", () => {
		scene(
			{ update: pageUpdate, view },
			given(named()),
			expectView(
				text("An error budget of 0.1% of events, about 43 minutes of full outage over 30 days."),
			).toExist(),
			click(role("button", { name: "99.99%" })),
			click(role("button", { name: "7 days" })),
			expectView(
				text("An error budget of 0.01% of events, about 1 minute of full outage over 7 days."),
			).toExist(),
		)
	})

	test("latency picks a threshold off the ladder the rollups count", () => {
		scene(
			{ update: pageUpdate, view },
			given(named()),
			expectView(role("group", { name: "Latency threshold" })).not.toExist(),
			click(role("button", { name: "Latency" })),
			expectView(role("button", { name: "50 ms" })).toExist(),
			expectView(role("button", { name: "10 s" })).toExist(),
			click(role("button", { name: "1 s" })),
			expectView(text("Good events are entry-point spans faster than 1 s.")).toExist(),
		)
	})

	test("Create sends the SLO as the API takes it and opens the new SLO", () => {
		const ready = steps(named(), [
			Message.ChangedText({ field: "environments", value: "production, staging, production" }),
			Message.GotDestinationMenuMessage({
				tier: "critical",
				message: Menu.Message.ClickedItem({
					index: 0,
					item: { kind: "Item", value: DESTINATION_ID },
				}),
			}),
		])
		const saving = pageUpdate(ready, Message.ClickedSave())
		expect(saving.commands).toMatchObject([
			{
				name: "SaveSloDraft",
				args: {
					editingId: null,
					payload: {
						name: "Checkout API",
						service_name: "checkout",
						environments: ["production", "staging"],
						sli: { type: "availability" },
						target_percent: 99.9,
						window_days: 30,
						alerting: {
							enabled: true,
							critical_destination_ids: [DESTINATION_ID],
							warning_destination_ids: [],
						},
					},
				},
			},
		])
		const created = checkoutSlo()
		expect(
			pageUpdate(saving.model, Message.CompletedSave({ result: Result.succeed(created) })).outMessage,
		).toEqual(
			PageOutMessage.RequestedNavigation({
				url: sloHref(created.id),
				isReplace: true,
				toast: { type: "success", title: "SLO created", description: "" },
			}),
		)
	})

	test("the destinations a tier notifies are picked from the org's and can be removed", () => {
		const picked = pageUpdate(
			named(),
			Message.GotDestinationMenuMessage({
				tier: "warning",
				message: Menu.Message.ClickedItem({
					index: 0,
					item: { kind: "Item", value: DESTINATION_ID },
				}),
			}),
		).model
		expect(picked.form.warningDestinationIds).toEqual([DESTINATION_ID])
		expect(picked.form.criticalDestinationIds).toEqual([])
		scene(
			{ update: pageUpdate, view },
			given(picked),
			click(role("button", { name: "Stop notifying On-call webhook" })),
			expectView(role("button", { name: "Stop notifying On-call webhook" })).not.toExist(),
		)
	})

	test("turning alerting off hides the tiers' destinations", () => {
		scene(
			{ update: pageUpdate, view },
			given(named()),
			expectView(text("Pages when the budget burns at 14.4x over 1h and 5m.")).toExist(),
			click(role("switch")),
			expectView(text("Pages when the budget burns at 14.4x over 1h and 5m.")).not.toExist(),
		)
	})

	test("a failed save stays on the form and says why", () => {
		const saving = pageUpdate(named(), Message.ClickedSave()).model
		const failed = pageUpdate(
			saving,
			Message.CompletedSave({ result: Result.fail(toLoadFailure(new Error("refused"))) }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(failed),
			expectView(text("Couldn't save the SLO")).toExist(),
			expectView(role("button", { name: "Create SLO" })).not.toBeDisabled(),
		)
	})

	test("editing reads the SLO and fills the form from it", () => {
		const slo = searchSlo({ target_percent: 99.7 })
		const entry = init({ _tag: "AlertsSloNew", search: { sloId: publicId(slo.id) } }, context)
		expect(names(entry.commands)).toContain("FetchSloFormSlo")
		const loaded = steps(entry.model, [
			Message.CompletedFetchSession({ orgId: ORG, grants: ENGINEER }),
			Message.CompletedFetchServices({ services: ["checkout"] }),
			Message.CompletedFetchExisting({
				key: entry.model.existing.key ?? "",
				result: Result.succeed(slo),
			}),
		])
		scene(
			{ update: pageUpdate, view },
			given(loaded),
			expectView(role("heading", { name: "Edit SLO" })).toExist(),
			expectView(role("textbox", { name: "Name" })).toHaveValue("Search latency"),
			expectView(role("button", { name: "Latency" })).toHaveAttr("aria-pressed", "true"),
			expectView(role("button", { name: "500 ms" })).toHaveAttr("aria-pressed", "true"),
			// 99.7 is off the presets, so it reads as a custom target.
			expectView(role("textbox", { name: "Custom target" })).toHaveValue("99.7"),
			expectView(role("button", { name: "28 days" })).toHaveAttr("aria-pressed", "true"),
			expectView(role("button", { name: "Save changes" })).not.toBeDisabled(),
		)
		expect(wirePayload(loaded.form)).toMatchObject({
			service_name: "search",
			sli: { type: "latency", threshold_ms: 500 },
			target_percent: 99.7,
			window_days: 28,
			alerting: { enabled: false },
		})
	})

	test("a member is told only admins and engineers change SLOs", () => {
		scene(
			{ update: pageUpdate, view },
			given(fresh({}, MEMBER)),
			expectView(text("Only org admins and engineers can create or change SLOs")).toExist(),
			expectView(role("button", { name: "Create SLO" })).not.toExist(),
		)
	})
})
