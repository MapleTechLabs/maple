import { OrgId } from "@maple/domain"
import * as Policy from "@maple/domain/policy"
import { Array as Arr, Option, Result, Schema, String as Str } from "effect"
import { click, expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import * as Tabs from "@maple/views/ui/tabs"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../contract"
import { customRole, ON_CALL, roleList, roleMembers, STATUS_EDITOR } from "../roles/test-roles"
import { Message } from "./message"
import type { Model } from "./model"
import { init, unsavedChanges, update } from "./update"
import { view as pageView } from "./view"

const ORG = "org_acme"
const context: PageContext = { orgId: Schema.decodeSync(OrgId)(ORG), pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()

const run = (model: Model, messages: ReadonlyArray<Message>): Model =>
	Arr.reduce(messages, model, (current, message) => pageUpdate(current, message).model)

const opened = (roleKey: string, grants = Policy.grantsOf(["org:admin"])): Model =>
	run(init({ _tag: "RoleEditor", roleId: roleKey }, context).model, [
		Message.CompletedFetchSession({ orgId: ORG, grants }),
		Message.CompletedFetchRoles({ result: Result.succeed(roleList([ON_CALL, STATUS_EDITOR])) }),
		Message.CompletedFetchMembers({ result: Result.succeed(roleMembers([])) }),
	])

const RECT = { left: 0, right: 80, top: 0, bottom: 32, width: 80, height: 32 }
const tabsMounted = Mount.resolve(Tabs.MeasureTabIndicator, Tabs.Message.MeasuredIndicator({ rect: RECT }))

const saveArgs = (step: ReturnType<typeof pageUpdate>) =>
	Option.getOrUndefined(Arr.findFirst(step.commands ?? [], (command) => command.name === "SaveRole"))?.args

describe("custom role editor", () => {
	test("a permission ticked counts as an unsaved change for the role's holders", () => {
		const edited = run(opened(ON_CALL.id), [
			Message.ToggledPermission({ permission: "uptime_monitors:manage" }),
		])
		scene(
			{ update: pageUpdate, view },
			given(edited),
			tabsMounted,
			expectView(text("1 unsaved change")).toExist(),
			expectView(text("Applies to 3 members on their next request.")).toExist(),
		)
	})

	test("Save sends the drafts, and the saved role ends the unsaved changes", () => {
		const edited = run(opened(ON_CALL.id), [
			Message.ToggledPermission({ permission: "uptime_monitors:manage" }),
			Message.ToggledPermission({ permission: "ai:act" }),
		])
		const saving = pageUpdate(edited, Message.ClickedSave())
		expect(saveArgs(saving)).toMatchObject({
			roleId: ON_CALL.id,
			payload: { name: ON_CALL.name, permissions: expect.arrayContaining(["uptime_monitors:manage"]) },
		})
		expect(saveArgs(saving)).toMatchObject({
			payload: { permissions: expect.not.arrayContaining(["ai:act"]) },
		})
		const saved = customRole({
			...ON_CALL,
			permissions: edited.permissions,
			memberCount: ON_CALL.memberCount,
		})
		const done = pageUpdate(saving.model, Message.CompletedSave({ result: Result.succeed(saved) }))
		expect(unsavedChanges(done.model)).toBe(0)
		expect(done.outMessage).toMatchObject({ _tag: "RequestedToast", title: "On-call responder saved" })
	})

	test("Discard puts the role back as saved", () => {
		const edited = run(opened(ON_CALL.id), [
			Message.ToggledPermission({ permission: "uptime_monitors:manage" }),
			Message.ChangedName({ value: "Responder" }),
		])
		scene(
			{ update: pageUpdate, view },
			given(edited),
			tabsMounted,
			expectView(text("2 unsaved changes")).toExist(),
			click(role("button", { name: "Discard" })),
			expectView(text("2 unsaved changes")).toBeAbsent(),
			expectView(role("textbox", { name: "Name" })).toHaveValue("On-call responder"),
		)
	})

	test("compared with Member, only what differs is marked, and the difference is summed up", () => {
		scene(
			{ update: pageUpdate, view },
			given(opened(ON_CALL.id)),
			tabsMounted,
			expectView(text("Added")).toExist(),
			expectView(text(/^\d+ added/u)).toExist(),
			expectView(text("Member has it too")).toExist(),
		)
	})

	test("permissions a custom role may not hold are not offered", () => {
		scene(
			{ update: pageUpdate, view },
			given(opened(ON_CALL.id)),
			tabsMounted,
			expectView(text("Manage members")).toBeAbsent(),
			expectView(text("Manage billing")).toExist(),
		)
	})

	test("ticking a permission ticks what it needs, which stays ticked while it is", () => {
		// Status page edits need telemetry too, so untick them first to free Read telemetry.
		const reader = run(opened(STATUS_EDITOR.id), [
			Message.ToggledPermission({ permission: "status_pages:edit" }),
			Message.ToggledPermission({ permission: "telemetry:read" }),
		])
		expect(reader.permissions).not.toContain("telemetry:read")
		const withSql = run(reader, [Message.ToggledPermission({ permission: "query:sql" })])
		expect(withSql.permissions).toEqual(expect.arrayContaining(["telemetry:read", "query:sql"]))
		expect(
			run(withSql, [Message.ToggledPermission({ permission: "telemetry:read" })]).permissions,
		).toContain("telemetry:read")
		scene(
			{ update: pageUpdate, view },
			given(withSql),
			tabsMounted,
			expectView(role("checkbox", { name: /Read telemetry/u })).toBeDisabled(),
			expectView(text("Required by Run raw SQL")).toExist(),
		)
	})

	test("a permission needed by several says how many more need it", () => {
		scene(
			{ update: pageUpdate, view },
			given(opened(ON_CALL.id)),
			tabsMounted,
			expectView(text(/^Required by Run raw SQL and \d+ more$/u)).toExist(),
		)
	})

	test("a name past the limit cannot be saved", () => {
		const tooLong = run(opened(ON_CALL.id), [
			Message.ChangedName({ value: Str.repeat(Policy.CUSTOM_ROLE_NAME_MAX + 1)("x") }),
		])
		expect(saveArgs(pageUpdate(tooLong, Message.ClickedSave()))).toBeUndefined()
		scene(
			{ update: pageUpdate, view },
			given(tooLong),
			tabsMounted,
			expectView(role("button", { name: "Save role" })).toBeDisabled(),
		)
	})

	test("someone who cannot manage roles cannot tick a permission", () => {
		const asMember = opened(ON_CALL.id, Policy.grantsOf(["org:member"]))
		expect(
			run(asMember, [Message.ToggledPermission({ permission: "uptime_monitors:manage" })]).permissions,
		).toEqual(asMember.permissions)
	})
})

describe("built-in role", () => {
	test("opens read-only, with a way to duplicate it", () => {
		scene(
			{ update: pageUpdate, view },
			given(opened("engineer")),
			tabsMounted,
			expectView(text(/Duplicate it to make a custom role you can edit/u)).toExist(),
			expectView(role("button", { name: "Duplicate to customize" })).toExist(),
			expectView(text("Manage alerts")).toExist(),
			expectView(role("checkbox", { name: /Manage alerts/u })).toBeAbsent(),
			expectView(role("button", { name: "Save role" })).toBeAbsent(),
		)
	})

	test("marks what it grants and what it doesn't, without controls", () => {
		scene(
			{ update: pageUpdate, view },
			given(opened("analyst")),
			tabsMounted,
			expectView(text("Granted")).toExist(),
			expectView(text("Not granted")).toExist(),
			expectView(role("checkbox")).toBeAbsent(),
		)
	})

	test("Admin lists the permissions only Admin holds", () => {
		scene(
			{ update: pageUpdate, view },
			given(opened("admin")),
			tabsMounted,
			expectView(text("Manage members")).toExist(),
		)
	})
})

describe("members tab", () => {
	test("a role nobody holds says how to assign it", () => {
		const onMembers = run(opened(STATUS_EDITOR.id), [
			Message.GotTabsMessage({ message: { _tag: "ClickedTab", index: 1 } }),
		])
		scene(
			{ update: pageUpdate, view },
			given(onMembers),
			tabsMounted,
			expectView(text("No one holds Status page editor yet")).toExist(),
			expectView(role("link", { name: "Open Members page" })).toExist(),
		)
	})
})
