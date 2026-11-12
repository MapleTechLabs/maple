import { OrgId } from "@maple/domain"
import {
	AlertRuleId,
	AuditDetectionInvalidError,
	AuditTrailForbiddenError,
	type AuditDetection,
	type AuditDetectionCreateRequest,
	type AuditDetectionListResponse,
} from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { toLoadFailure } from "@maple/views/data/load-failure"
import * as Menu from "@maple/views/ui/menu"
import { Array as Arr, Result, Schema, String as Str } from "effect"
import {
	change,
	click,
	Command,
	expect as expectView,
	expectOutMessage,
	given,
	role,
	scene,
	selector,
	text,
	type,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import {
	detectionDestinationsOf,
	detectionsOf,
	ON_CALL_ID,
	SECURITY_CHANNEL_ID,
} from "../../../lab/security-detections-fixture"
import { AppRoute } from "../../../route"
import { type PageContext, PageOutMessage } from "../../contract"
import { SaveDetection } from "./command"
import { formIssues, wirePayload } from "./derive"
import { emptyForm } from "./form"
import { Message, type Model } from "./model"
import { enter, update } from "./update"
import { view as pageView } from "./view"

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_acme"),
	pinnedNamespace: null,
	timeZone: "UTC",
}
const NOW = Date.UTC(2026, 9, 31, 14, 32)
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)
const EXISTING = "SecurityApiDetectionFormExisting"
const SAVE = "SecurityApiDetectionSave"

const ADMIN = Policy.allPermissions
const ENGINEER = Policy.grantsOf(["org:engineer"])
const adminsOnly = text("Only org admins can create or change detections")
const createButton = role("button", { name: "Create detection" })
const saveButton = role("button", { name: "Save changes" })
const issues = selector('[aria-label="Fix before saving"]')

const routeOf = (search: Model["search"] = {}) => AppRoute.SecurityDetectionNew({ search })
/** The hosted product: the session, not the build, says what the viewer may do. */
const init = (search: Model["search"] = {}) => enter(routeOf(search), context, true)

const steps = (model: Model, messages: ReadonlyArray<Message>): Model =>
	Arr.reduce(messages, model, (current, message) => pageUpdate(current, message).model)

const grantsRead = (grants: ReadonlyArray<Policy.Permission>) =>
	Message.CompletedReadGrants({ orgId: context.orgId, grants: [...grants] })

const destinationsSynced = Message.UpdatedDestinations({
	orgId: context.orgId,
	rows: [...detectionDestinationsOf(context.orgId, NOW)],
})

/** The editor as an admin opens it on a new detection. */
const fresh = (search: Model["search"] = {}): Model =>
	steps(init(search).model, [grantsRead(ADMIN), destinationsSynced])

const LIST: AuditDetectionListResponse = detectionsOf(NOW)
const [VERCEL_ROLES] = LIST.detections

/** The editor on `detection`, once the list that holds it answered. */
const editing = (detection: AuditDetection | undefined, list = LIST): Model => {
	const entered = init({ detectionId: detection?.id ?? "" })
	const asked = steps(entered.model, [grantsRead(ADMIN), destinationsSynced])
	return pageUpdate(
		asked,
		Message.CompletedFetchExisting({ key: asked.existing.key ?? "", result: Result.succeed(list) }),
	).model
}

/** The detection as the API answers a save of `payload`. */
const saved = (payload: AuditDetectionCreateRequest): AuditDetection => ({
	id: VERCEL_ROLES?.id ?? Schema.decodeSync(AlertRuleId)("0199b002-0000-7000-8000-000000000009"),
	name: payload.name,
	enabled: payload.enabled ?? true,
	filters: payload.filters ?? {},
	windowMinutes: payload.windowMinutes,
	threshold: payload.threshold,
	severity: payload.severity,
	destinationIds: payload.destinationIds ?? [],
	createdAt: NOW,
	updatedAt: NOW,
})

describe("security detection editor", () => {
	test("nothing is asked of the API until the session says who is looking", () => {
		expect(names(init({ detectionId: VERCEL_ROLES?.id }).commands)).not.toContain(EXISTING)
		scene(
			{ update: pageUpdate, view },
			given(init().model),
			expectView(createButton).toBeAbsent(),
			expectView(adminsOnly).toBeAbsent(),
		)
	})

	test("an engineer is told the editor is for admins and gets no form", () => {
		const answered = pageUpdate(init({ detectionId: VERCEL_ROLES?.id }).model, grantsRead(ENGINEER))

		expect(names(answered.commands)).toEqual([])
		scene(
			{ update: pageUpdate, view },
			given(answered.model),
			expectView(adminsOnly).toExist(),
			expectView(saveButton).toBeAbsent(),
			expectView(role("link", { name: "Back to detections" })).toHaveAttr(
				"href",
				"/security/detections",
			),
		)
	})

	// A failed session read answers with no grants at all: the form opens, and the API decides.
	test("a session that could not be read opens the form, and the API's refusal is what locks it", () => {
		const open = steps(init().model, [
			grantsRead([]),
			Message.ChangedText({ field: "name", value: "Any" }),
		])
		scene({ update: pageUpdate, view }, given(open), expectView(createButton).toExist())

		const refused = steps(open, [
			Message.ClickedSave(),
			Message.CompletedSave({
				result: Result.fail(
					toLoadFailure(
						new AuditTrailForbiddenError({ message: "Only org admins can read the audit log." }),
					),
				),
			}),
		])
		scene(
			{ update: pageUpdate, view },
			given(refused),
			expectView(adminsOnly).toExist(),
			expectView(createButton).toBeAbsent(),
		)
	})

	test("a new detection counts every event, says what is missing and cannot be created", () => {
		scene(
			{ update: pageUpdate, view },
			given(fresh()),
			expectView(role("heading", { name: "New detection" })).toExist(),
			expectView(role("combobox", { name: "Platform" })).toHaveValue(""),
			expectView(text("Every audit event")).toExist(),
			expectView(issues).toHaveText("Fix before saving: Name the detection."),
			expectView(createButton).toBeDisabled(),
		)
	})

	test("a ready-made detection opens filled in, and nothing is created by opening it", () => {
		const entered = init({ template: "sign_in" })

		expect(names(entered.commands)).not.toContain(SAVE)
		scene(
			{ update: pageUpdate, view },
			given(steps(entered.model, [grantsRead(ADMIN), destinationsSynced])),
			expectView(role("textbox", { name: "Name" })).toHaveValue("Repeated sign-in failures"),
			expectView(role("combobox", { name: "Start from" })).toHaveValue("sign_in"),
			expectView(role("combobox", { name: "Category" })).toHaveValue("authentication"),
			expectView(role("combobox", { name: "Outcome" })).toHaveValue("failure"),
			expectView(role("textbox", { name: "Count" })).toHaveValue("5"),
			expectView(role("textbox", { name: "Window in minutes" })).toHaveValue("10"),
			expectView(role("button", { name: "Critical" })).toHaveAttr("aria-pressed", "true"),
			expectView(text("Fires on 5 or more in 10 minutes. Checked every minute.")).toExist(),
			expectView(text("Ready to save")).toExist(),
		)
	})

	test("the audit log's filters prefill what it counts, and nothing else", () => {
		const prefilled = fresh({
			provider: "vercel",
			category: "credential",
			outcome: "denied",
			action: " project.env-var.created ",
		})

		expect(wirePayload(prefilled.form).filters).toEqual({
			provider: "vercel",
			category: "credential",
			outcome: "denied",
			action: "project.env-var.created",
		})
		scene(
			{ update: pageUpdate, view },
			given(prefilled),
			expectView(role("combobox", { name: "Platform" })).toHaveValue("vercel"),
			expectView(role("textbox", { name: "Action (optional)" })).toHaveValue("project.env-var.created"),
			expectView(role("textbox", { name: "Name" })).toHaveValue(""),
		)
	})

	// The URL is anyone's to write: a platform, category or outcome the API has no name for
	// counts as "Any" and is never sent.
	test("a prefill value this build does not know is dropped", () => {
		const odd = fresh({
			provider: "github",
			category: "licensing",
			outcome: "throttled",
			template: "nope",
		})

		expect(wirePayload(odd.form).filters).toEqual({})
		scene(
			{ update: pageUpdate, view },
			given(odd),
			expectView(role("combobox", { name: "Platform" })).toHaveValue(""),
			expectView(role("combobox", { name: "Start from" })).toHaveValue(""),
		)
	})

	test("the count and the window are held to the bounds the API takes", () => {
		const named = { ...emptyForm(), name: "Refusals" }
		const issuesOf = (fields: Partial<typeof named>) => formIssues({ ...named, ...fields })

		expect(issuesOf({})).toEqual([])
		expect(issuesOf({ threshold: "0" })).toEqual(["Set a count from 1 to 100,000."])
		expect(issuesOf({ threshold: "100001" })).toEqual(["Set a count from 1 to 100,000."])
		expect(issuesOf({ threshold: "2.5" })).toEqual(["Set a count from 1 to 100,000."])
		expect(issuesOf({ threshold: "100000", windowMinutes: "1440" })).toEqual([])
		expect(issuesOf({ windowMinutes: "4" })).toEqual(["Set a window from 5 to 1,440 minutes."])
		expect(issuesOf({ windowMinutes: "1441" })).toEqual(["Set a window from 5 to 1,440 minutes."])
		expect(issuesOf({ windowMinutes: "" })).toEqual(["Set a window from 5 to 1,440 minutes."])
	})

	test("a name or an action longer than the API takes blocks saving", () => {
		const named = { ...emptyForm(), name: "Refusals" }

		expect(formIssues({ ...named, name: Str.repeat(120)("a") })).toEqual([])
		expect(formIssues({ ...named, name: Str.repeat(121)("a") })).toEqual([
			"Keep the name to 120 characters.",
		])
		expect(formIssues({ ...named, name: "   " })).toEqual(["Name the detection."])
		expect(formIssues({ ...named, action: Str.repeat(256)("a") })).toEqual([])
		expect(formIssues({ ...named, action: Str.repeat(257)("a") })).toEqual([
			"Keep the action to 256 characters.",
		])
	})

	test("a window out of bounds is named in the bar and the button stays off until it is fixed", () => {
		scene(
			{ update: pageUpdate, view },
			given(fresh({ template: "refused" })),
			type(role("textbox", { name: "Window in minutes" }), "2"),
			expectView(issues).toHaveText("Fix before saving: Set a window from 5 to 1,440 minutes."),
			expectView(createButton).toBeDisabled(),
			type(role("textbox", { name: "Window in minutes" }), "30"),
			expectView(text("Ready to save")).toExist(),
			expectView(createButton).not.toBeDisabled(),
		)
	})

	test("creating sends the form as the API takes it and goes back to the list on its answer", () => {
		const payload: AuditDetectionCreateRequest = {
			name: "Denied credential changes",
			enabled: true,
			filters: { category: "credential", outcome: "denied" },
			windowMinutes: 15,
			threshold: 3,
			severity: "critical",
			destinationIds: [],
		}

		scene(
			{ update: pageUpdate, view },
			given(fresh()),
			type(role("textbox", { name: "Name" }), "  Denied credential changes "),
			change(role("combobox", { name: "Category" }), "credential"),
			change(role("combobox", { name: "Outcome" }), "denied"),
			type(role("textbox", { name: "Count" }), "3"),
			type(role("textbox", { name: "Window in minutes" }), "15"),
			click(role("button", { name: "Critical" })),
			expectView(text("Credentials · Denied")).toExist(),
			click(createButton),
			Command.resolve(
				SaveDetection({ editingId: null, payload }),
				Message.CompletedSave({ result: Result.succeed(saved(payload)) }),
			),
			expectOutMessage(
				PageOutMessage.RequestedNavigation({
					url: "/security/detections",
					isReplace: true,
					toast: { type: "success", title: "Detection created", description: "" },
				}),
			),
		)
	})

	test("editing reads the detection, fills the form from it and saves the change to that detection", () => {
		const detection = VERCEL_ROLES
		const entered = init({ detectionId: detection?.id })
		expect(names(pageUpdate(entered.model, grantsRead(ADMIN)).commands)).toEqual([EXISTING])

		const payload: AuditDetectionCreateRequest = {
			name: "Role changes on Vercel",
			enabled: true,
			filters: { provider: "vercel", action: "team.member.role.updated" },
			windowMinutes: 5,
			threshold: 2,
			severity: "warning",
			destinationIds: [SECURITY_CHANNEL_ID],
		}
		scene(
			{ update: pageUpdate, view },
			given(editing(detection)),
			expectView(role("heading", { name: "Edit detection" })).toExist(),
			expectView(role("combobox", { name: "Start from" })).toBeAbsent(),
			expectView(role("textbox", { name: "Name" })).toHaveValue("Role changes on Vercel"),
			expectView(role("combobox", { name: "Platform" })).toHaveValue("vercel"),
			expectView(role("textbox", { name: "Action (optional)" })).toHaveValue(
				"team.member.role.updated",
			),
			expectView(text("#security")).toExist(),
			type(role("textbox", { name: "Count" }), "2"),
			click(saveButton),
			Command.resolve(
				SaveDetection({ editingId: detection?.id ?? null, payload }),
				Message.CompletedSave({ result: Result.succeed(saved(payload)) }),
			),
			expectOutMessage(
				PageOutMessage.RequestedNavigation({
					url: "/security/detections",
					isReplace: true,
					toast: { type: "success", title: "Changes saved", description: "" },
				}),
			),
		)
	})

	// A duplicate name, an unknown destination and the per-org cap all come back as this error.
	test("a save the API calls invalid stays on the form and shows the API's own message", () => {
		const message = 'Another alert rule is already named "Burst of refused requests".'
		const failed = steps(fresh({ template: "refused" }), [
			Message.ClickedSave(),
			Message.CompletedSave({
				result: Result.fail(toLoadFailure(new AuditDetectionInvalidError({ message }))),
			}),
		])

		scene(
			{ update: pageUpdate, view },
			given(failed),
			expectView(text("Couldn't save the detection")).toExist(),
			expectView(text(message)).toExist(),
			expectView(createButton).not.toBeDisabled(),
		)
	})

	test("a save in flight is not sent twice", () => {
		const saving = pageUpdate(fresh({ template: "refused" }), Message.ClickedSave())

		expect(names(saving.commands)).toEqual([SAVE])
		expect(names(pageUpdate(saving.model, Message.ClickedSave()).commands)).toEqual([])
	})

	test("the destinations it notifies are picked from the org's and can be removed", () => {
		const picked = pageUpdate(
			fresh({ template: "refused" }),
			Message.GotDestinationMenuMessage({
				message: Menu.Message.ClickedItem({ index: 1, item: { kind: "Item", value: ON_CALL_ID } }),
			}),
		).model

		expect(wirePayload(picked.form).destinationIds).toEqual([ON_CALL_ID])
		scene(
			{ update: pageUpdate, view },
			given(picked),
			click(role("button", { name: "Stop notifying Security on-call" })),
			expectView(role("button", { name: "Stop notifying Security on-call" })).toBeAbsent(),
			expectView(text("Nobody yet. The incident still opens, and no one is told.")).toExist(),
		)
	})

	test("starting from a ready-made detection in the editor keeps a name already typed", () => {
		const typed = pageUpdate(fresh(), Message.ChangedText({ field: "name", value: "Key churn" })).model
		const picked = pageUpdate(typed, Message.PickedTemplate({ id: "credential" })).model

		expect(wirePayload(picked.form)).toMatchObject({
			name: "Key churn",
			filters: { category: "credential" },
			threshold: 1,
			windowMinutes: 5,
			severity: "warning",
		})
		// A name that came from a template follows the next template.
		const switched = steps(fresh({ template: "membership" }), [Message.PickedTemplate({ id: "refused" })])
		expect(switched.form.name).toBe("Burst of refused requests")
	})

	test("a detection the org no longer has, or an id that is not one, says so", () => {
		const gone = editing(VERCEL_ROLES, { detections: [] })
		scene(
			{ update: pageUpdate, view },
			given(gone),
			expectView(text("Detection not found")).toExist(),
			expectView(saveButton).toBeAbsent(),
		)

		const mistyped = init({ detectionId: "not-an-id" })
		expect(names(pageUpdate(mistyped.model, grantsRead(ADMIN)).commands)).toEqual([])
		scene(
			{ update: pageUpdate, view },
			given(pageUpdate(mistyped.model, grantsRead(ADMIN)).model),
			expectView(text("Detection not found")).toExist(),
		)
	})
})
