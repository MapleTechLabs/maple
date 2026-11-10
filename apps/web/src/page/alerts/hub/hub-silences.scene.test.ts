import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import { AlertRuleId, AlertSilenceId } from "@maple/domain/http"
import { AlertMaintenanceWindowPublicId, type V2AlertSilence } from "@maple/domain/http/v2"
import { Result, Schema, Array as Arr } from "effect"
import * as Combobox from "@maple/views/ui/combobox"
import * as Dialog from "@maple/views/ui/dialog"
import { MountDialog } from "@maple/views/ui/dialog"
import {
	expect as expectView,
	Mount,
	given,
	role,
	scene,
	selector,
	submit,
	text,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../contract"
import { NOW, ORG, hubAt, ruleRow } from "../shared/test-rows"
import { silenceSuggestionsOf } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { init, routeChanged, update } from "./update"
import { view as pageView } from "./view"
import * as SilenceDialog from "../silence-dialog/dialog"

const orgId = Schema.decodeSync(OrgId)(ORG)
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const asSilenceId = Schema.decodeSync(AlertSilenceId)
const asRuleId = Schema.decodeSync(AlertRuleId)
const iso = (ms: number) => new Date(ms).toISOString()

const silence = (
	overrides: Partial<Omit<V2AlertSilence, "maintenance_window_id">> & {
		readonly startMin: number
		readonly endMin: number
	},
): V2AlertSilence => {
	const { startMin, endMin, ...rest } = overrides
	return {
		id: asSilenceId("22222222-2222-4222-8222-222222222222"),
		object: "alert_silence",
		reason: "Deploying checkout v2.3",
		matchers: { services: ["checkout"] },
		status: "active",
		starts_at: iso(NOW + startMin * 60_000),
		ends_at: iso(NOW + endMin * 60_000),
		maintenance_window_id: null,
		created_by: "user_1",
		created_at: iso(NOW),
		updated_at: iso(NOW),
		...rest,
	}
}

const onSilences = (grants: ReturnType<typeof Policy.grantsOf>, silences: ReadonlyArray<V2AlertSilence>) => {
	const entered = init(hubAt({ tab: "silences" }), context)
	expect(Arr.map(entered.commands ?? [], ({ name }) => name)).toContain("FetchAlertsHubSilences")
	return Arr.reduce(
		[
			Message.ReadClock({ nowMs: NOW }),
			Message.CompletedFetchSession({ orgId: ORG, grants }),
			Message.CompletedFetchSilences({
				key: entered.model.silences.key ?? "",
				result: Result.succeed(silences),
			}),
		],
		entered.model,
		(model, message) => pageUpdate(model, message).model,
	)
}

const ENGINEER = Policy.grantsOf(["org:engineer"])
const MEMBER = Policy.grantsOf(["org:member"])

describe("alerts hub, Silences tab", () => {
	test("an org without silences explains them and offers the first one", () => {
		scene(
			{ update: pageUpdate, view },
			given(onSilences(ENGINEER, [])),
			expectView(text("No silences yet")).toExist(),
			expectView(role("button", { name: "New silence" })).toExist(),
		)
	})

	test("groups silences by where they stand, with their window and scope", () => {
		scene(
			{ update: pageUpdate, view },
			given(
				onSilences(ENGINEER, [
					silence({ startMin: -10, endMin: 50 }),
					silence({
						id: asSilenceId("33333333-3333-4333-8333-333333333333"),
						reason: "Database migration",
						matchers: { tags: ["db"] },
						startMin: 120,
						endMin: 180,
					}),
				]),
			),
			expectView(text("Deploying checkout v2.3")).toExist(),
			expectView(text(/Until .+ · service checkout/u)).toExist(),
			expectView(text(/tag db/u)).toExist(),
			expectView(role("button", { name: "End now" })).toExist(),
			expectView(role("button", { name: "Cancel" })).toExist(),
		)
	})

	test("a maintenance window's silence names its window instead of offering to end it", () => {
		scene(
			{ update: pageUpdate, view },
			given(
				onSilences(ENGINEER, [
					{
						...silence({ startMin: -10, endMin: 50, reason: "Maintenance: Nightly DB" }),
						maintenance_window_id: Schema.decodeSync(AlertMaintenanceWindowPublicId)(
							"mw_23WPYrFnzjC78LcewZBWTvw",
						),
					},
				]),
			),
			expectView(text("Maintenance: Nightly DB")).toExist(),
			expectView(text("Managed by a maintenance window")).toExist(),
			expectView(role("button", { name: "End now" })).not.toExist(),
		)
	})

	test("ending a silence sends it once and a member cannot end one", () => {
		const model = onSilences(ENGINEER, [silence({ startMin: -10, endMin: 50 })])
		const step = pageUpdate(
			model,
			Message.ClickedEndSilence({ silenceId: asSilenceId("22222222-2222-4222-8222-222222222222") }),
		)
		expect(Arr.map(step.commands ?? [], ({ name }) => name)).toEqual(["EndAlertSilence"])
		expect(
			pageUpdate(
				step.model,
				Message.ClickedEndSilence({ silenceId: asSilenceId("22222222-2222-4222-8222-222222222222") }),
			).commands ?? [],
		).toEqual([])

		scene(
			{ update: pageUpdate, view },
			given(onSilences(MEMBER, [silence({ startMin: -10, endMin: 50 })])),
			expectView(role("button", { name: "End now" })).not.toExist(),
			expectView(role("button", { name: "New silence" })).not.toExist(),
		)
	})

	test("confirms a cancelled scheduled silence as cancelled, an ended active one as ended", () => {
		const id = asSilenceId("22222222-2222-4222-8222-222222222222")
		const model = onSilences(ENGINEER, [silence({ startMin: 60, endMin: 120 })])
		const toastOf = (result: V2AlertSilence) =>
			pageUpdate(model, Message.CompletedEndSilence({ silenceId: id, result: Result.succeed(result) }))
				.outMessage
		expect(toastOf(silence({ startMin: 0, endMin: 0, status: "ended" }))).toMatchObject({
			title: "Silence cancelled",
		})
		expect(toastOf(silence({ startMin: -30, endMin: 0, status: "ended" }))).toMatchObject({
			title: "Silence ended",
		})
	})

	test("reads the clock again when the list lands, so a new silence is placed by it", () => {
		const entered = init(hubAt({ tab: "silences" }), context).model
		const step = pageUpdate(
			entered,
			Message.CompletedFetchSilences({ key: entered.silences.key ?? "", result: Result.succeed([]) }),
		)
		expect(Arr.map(step.commands ?? [], ({ name }) => name)).toContain("ReadAlertsHubClock")
	})

	test("names a cancelled silence as cancelled, and a rule scope before rules sync", () => {
		scene(
			{ update: pageUpdate, view },
			given(
				onSilences(ENGINEER, [
					silence({ startMin: -5, endMin: -5, status: "ended" }),
					silence({
						id: asSilenceId("44444444-4444-4444-8444-444444444444"),
						reason: "Rule only",
						matchers: { rule_ids: [asRuleId("11111111-1111-4111-8111-111111111111")] },
						startMin: -10,
						endMin: 50,
					}),
				]),
			),
			expectView(text(/^Cancelled /u)).toExist(),
			// The row's badge agrees with its window line: a silence that never ran did not end.
			expectView(text("Cancelled")).toExist(),
			expectView(text("Ended")).not.toExist(),
			expectView(text(/· 1 rule$/u)).toExist(),
		)
	})
})

const SILENCES_URL = "/alerts/silences"
const callsOf = (commands: ReadonlyArray<{ readonly name: string; readonly args?: unknown }> | undefined) =>
	Arr.map(commands ?? [], ({ name, args }) => [name, args])
const namesOf = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)
const silenceMessage = (message: SilenceDialog.Message) => Message.GotSilenceDialogMessage({ message })
const scopeCombo = (field: SilenceDialog.ScopeField, message: Combobox.Message) =>
	silenceMessage(SilenceDialog.Message.GotScopeComboMessage({ field, message }))

/** The Silences tab with `?sheet=silence` followed: the panel is open. */
const withPanel = (grants = ENGINEER) =>
	routeChanged(onSilences(grants, []), hubAt({ tab: "silences", sheet: "silence" }), context)

describe("alerts hub, silence side panel", () => {
	test("New silence opens the panel through the URL, as a history entry on this section", () => {
		const model = onSilences(ENGINEER, [])
		const step = pageUpdate(model, Message.ClickedNewSilence())
		expect(callsOf(step.commands)).toEqual([
			["PushAlertsHubSheet", { href: SILENCES_URL, id: "silence" }],
		])
		expect(step.model.silenceDialog.dialog.isOpen).toBe(false)
	})

	test("the URL opens it with a chips input per scope field, Cancel and a save", () => {
		const opened = withPanel()
		expect(opened.model.silenceDialog.dialog.isOpen).toBe(true)
		scene(
			{ update: pageUpdate, view },
			given(opened.model),
			Mount.resolve(MountDialog, Dialog.Message.CompletedMountDialog()),
			expectView(role("dialog", { name: "Silence notifications" })).toExist(),
			expectView(role("combobox", { name: "Services" })).toExist(),
			expectView(role("combobox", { name: "Environments" })).toExist(),
			expectView(role("combobox", { name: "Tags" })).toExist(),
			expectView(
				text("Fill in at least one. A rule is silenced only if it matches every field you fill in."),
			).toExist(),
			expectView(role("button", { name: "Cancel" })).toExist(),
			expectView(role("button", { name: "Silence for 1 hour" })).not.toBeDisabled(),
			expectView(role("alert")).not.toExist(),
		)
	})

	test("saving an incomplete form sends nothing and says what is missing, field by field", () => {
		scene(
			{ update: pageUpdate, view },
			given(withPanel().model),
			Mount.resolve(MountDialog, Dialog.Message.CompletedMountDialog()),
			submit(selector("form")),
			expectView(text("Add at least one service, environment or tag")).toExist(),
			expectView(text("Add a reason")).toExist(),
			expectView(role("textbox", { name: "Reason" })).toHaveAttr("aria-invalid", "true"),
			expectView(role("button", { name: "Silence for 1 hour" })).not.toBeDisabled(),
		)
		const tried = pageUpdate(withPanel().model, silenceMessage(SilenceDialog.Message.ClickedSave()))
		expect(namesOf(tried.commands)).toEqual([])
		// Each line goes as its field is filled in.
		const reasoned = pageUpdate(
			tried.model,
			silenceMessage(SilenceDialog.Message.ChangedReason({ value: "Deploying checkout v2.3" })),
		).model
		scene(
			{ update: pageUpdate, view },
			given(reasoned),
			Mount.resolve(MountDialog, Dialog.Message.CompletedMountDialog()),
			expectView(text("Add a reason")).not.toExist(),
			expectView(text("Add at least one service, environment or tag")).toExist(),
		)
	})

	test("the chips inputs suggest what the org's rules name, and a picked one becomes a chip", () => {
		const withRules = pageUpdate(
			withPanel().model,
			Message.UpdatedRules({
				orgId: ORG,
				rows: [
					ruleRow(1, { service_names_json: ["checkout"], tags_json: ["db"] }),
					ruleRow(2, {
						service_names_json: ["payments", "checkout"],
						environments_json: ["staging"],
					}),
				],
			}),
		).model
		expect(silenceSuggestionsOf(withRules)).toEqual({
			services: ["checkout", "payments"],
			environments: ["production", "staging"],
			tags: ["db"],
		})
		const listed = pageUpdate(withRules, scopeCombo("services", Combobox.Message.ClickedInput())).model
		scene(
			{ update: pageUpdate, view },
			given(listed),
			Mount.resolve(MountDialog, Dialog.Message.CompletedMountDialog()),
			Mount.resolve(Combobox.MountCombobox, Combobox.Message.CompletedMountCombobox()),
			expectView(role("option", { name: "checkout" })).toExist(),
			expectView(role("option", { name: "payments" })).toExist(),
		)
		const picked = pageUpdate(
			listed,
			scopeCombo("services", Combobox.Message.ClickedItem({ value: "payments" })),
		).model
		scene(
			{ update: pageUpdate, view },
			given(picked),
			Mount.resolve(MountDialog, Dialog.Message.CompletedMountDialog()),
			Mount.resolve(Combobox.MountCombobox, Combobox.Message.CompletedMountCombobox()),
			expectView(role("button", { name: "Remove payments" })).toExist(),
		)
	})

	test("a picked end is on the viewer's clock, and the field names the zone", () => {
		const berlin: PageContext = { ...context, timeZone: "Europe/Berlin" }
		const opened = routeChanged(
			onSilences(ENGINEER, []),
			hubAt({ tab: "silences", sheet: "silence" }),
			berlin,
		).model
		const custom = update(
			opened,
			silenceMessage(SilenceDialog.Message.ChangedDuration({ duration: "custom" })),
			berlin,
		).model
		scene(
			{ update: (model: Model, message: Message) => update(model, message, berlin), view },
			given(custom),
			Mount.resolve(MountDialog, Dialog.Message.CompletedMountDialog()),
			// NOW is 1 October: Berlin is on summer time.
			expectView(text("Ends, CEST")).toExist(),
			expectView(text("Your local time. At most 30 days from now.")).toExist(),
		)
	})

	test("a link straight to the panel waits for the clock and the viewer's grants, and a member never gets it", () => {
		const entered = init(hubAt({ tab: "silences", sheet: "silence" }), context).model
		expect(entered.silenceDialog.dialog.isOpen).toBe(false)
		const clocked = pageUpdate(entered, Message.ReadClock({ nowMs: NOW })).model
		expect(clocked.silenceDialog.dialog.isOpen).toBe(false)
		const granted = pageUpdate(
			clocked,
			Message.CompletedFetchSession({ orgId: ORG, grants: ENGINEER }),
		).model
		expect(granted.silenceDialog.dialog.isOpen).toBe(true)
		expect(granted.silenceDialog.nowMs).toBe(NOW)
		expect(withPanel(MEMBER).model.silenceDialog.dialog.isOpen).toBe(false)
	})

	test("a member's link loses its `?sheet=` once the grants say so, replaced away", () => {
		const entered = init(hubAt({ tab: "silences", sheet: "silence" }), context).model
		const clocked = pageUpdate(entered, Message.ReadClock({ nowMs: NOW })).model
		const granted = pageUpdate(clocked, Message.CompletedFetchSession({ orgId: ORG, grants: MEMBER }))
		expect(granted.model.silenceDialog.dialog.isOpen).toBe(false)
		expect(granted.model.search.sheet).toBeUndefined()
		expect(callsOf(granted.commands)).toEqual([
			["DismissAlertsHubSheet", { href: `${SILENCES_URL}?sheet=silence`, id: "silence" }],
		])
	})

	test("the panel opens only on the Silences section", () => {
		const onRules = routeChanged(
			onSilences(ENGINEER, []),
			hubAt({ tab: "rules", sheet: "silence" }),
			context,
		)
		expect(onRules.model.silenceDialog.dialog.isOpen).toBe(false)
		expect(
			pageUpdate(onRules.model, Message.ReadClock({ nowMs: NOW })).model.silenceDialog.dialog.isOpen,
		).toBe(false)
	})

	test("a clock tick after Cancel, before the URL change lands, leaves it closed", () => {
		const cancelled = pageUpdate(withPanel().model, silenceMessage(SilenceDialog.Message.ClickedCancel()))
		expect(cancelled.model.search.sheet).toBeUndefined()
		const ticked = pageUpdate(cancelled.model, Message.ReadClock({ nowMs: NOW + 30_000 }))
		expect(ticked.model.silenceDialog.dialog.isOpen).toBe(false)
		const landed = routeChanged(ticked.model, hubAt({ tab: "silences" }), context)
		expect(landed.model.silenceDialog.dialog.isOpen).toBe(false)
		expect(namesOf(landed.commands)).not.toContain("DismissAlertsHubSheet")
	})

	test("Cancel and Escape close it and take `?sheet=` off the URL", () => {
		const dismissed = [
			["DismissAlertsHubSheet", { href: `${SILENCES_URL}?sheet=silence`, id: "silence" }],
		]
		const cancelled = pageUpdate(withPanel().model, silenceMessage(SilenceDialog.Message.ClickedCancel()))
		expect(cancelled.model.silenceDialog.dialog.isOpen).toBe(false)
		expect(Arr.filter(callsOf(cancelled.commands), ([name]) => name === "DismissAlertsHubSheet")).toEqual(
			dismissed,
		)
		const escaped = pageUpdate(
			withPanel().model,
			silenceMessage(
				SilenceDialog.Message.GotDialogMessage({ message: Dialog.Message.PressedEscape() }),
			),
		)
		expect(escaped.model.silenceDialog.dialog.isOpen).toBe(false)
		expect(Arr.filter(callsOf(escaped.commands), ([name]) => name === "DismissAlertsHubSheet")).toEqual(
			dismissed,
		)
	})

	test("Back closes it without touching the URL again, and the form starts fresh when it reopens", () => {
		const typed = pageUpdate(
			withPanel().model,
			silenceMessage(SilenceDialog.Message.ChangedReason({ value: "x" })),
		)
		const back = routeChanged(typed.model, hubAt({ tab: "silences" }), context)
		expect(back.model.silenceDialog.dialog.isOpen).toBe(false)
		expect(namesOf(back.commands)).not.toContain("DismissAlertsHubSheet")
		const reopened = routeChanged(back.model, hubAt({ tab: "silences", sheet: "silence" }), context)
		expect(reopened.model.silenceDialog.dialog.isOpen).toBe(true)
		expect(reopened.model.silenceDialog.reason).toBe("")
	})

	test("saving creates the silence, closes the panel, clears the URL and reads the list again", () => {
		const filled = Arr.reduce(
			[
				scopeCombo("services", Combobox.Message.ClickedItem({ value: "checkout" })),
				silenceMessage(SilenceDialog.Message.ChangedReason({ value: "Deploying checkout v2.3" })),
			],
			withPanel().model,
			(model, message) => pageUpdate(model, message).model,
		)
		const saving = pageUpdate(filled, silenceMessage(SilenceDialog.Message.ClickedSave()))
		expect(namesOf(saving.commands)).toEqual(["SaveAlertSilence"])
		const saved = pageUpdate(
			saving.model,
			silenceMessage(
				SilenceDialog.Message.CompletedSave({
					openCount: saving.model.silenceDialog.openCount,
					result: Result.succeed(silence({ startMin: 0, endMin: 60 })),
				}),
			),
		)
		expect(saved.model.silenceDialog.dialog.isOpen).toBe(false)
		expect(namesOf(saved.commands)).toEqual(
			expect.arrayContaining(["DismissAlertsHubSheet", "FetchAlertsHubSilences"]),
		)
		expect(saved.outMessage).toMatchObject({ title: "Alerts silenced" })
		// The refreshed list reads the clock again; the panel stays shut.
		expect(
			pageUpdate(saved.model, Message.ReadClock({ nowMs: NOW })).model.silenceDialog.dialog.isOpen,
		).toBe(false)
	})
})
