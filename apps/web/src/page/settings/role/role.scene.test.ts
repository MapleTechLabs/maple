import { OrgId } from "@maple/domain"
import * as Policy from "@maple/domain/policy"
import { Array as Arr, Option, Result, Schema, String as Str } from "effect"
import { click, expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { toLoadFailure } from "@maple/views/data/load-failure"
import * as Combobox from "@maple/views/ui/combobox"
import * as Tabs from "@maple/views/ui/tabs"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../contract"
import { customRole, ON_CALL, roleList, roleMembers, STATUS_EDITOR } from "../roles/test-roles"
import { Message } from "./message"
import type { Model } from "./model"
import { init, namespaceChoices, unsavedChanges, update } from "./update"
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

const CHECKOUT = customRole({
	id: Policy.CustomRoleId.make("role_checkout0000"),
	name: "Checkout team",
	permissions: [Policy.SCOPED_READ, "support:join"],
	namespaces: ["checkout"],
	memberCount: 2,
})

const openedLimited = (grants = Policy.grantsOf(["org:admin"])): Model =>
	run(init({ _tag: "RoleEditor", roleId: CHECKOUT.id }, context).model, [
		Message.CompletedFetchSession({ orgId: ORG, grants }),
		Message.CompletedFetchRoles({ result: Result.succeed(roleList([ON_CALL, CHECKOUT])) }),
		Message.CompletedFetchMembers({ result: Result.succeed(roleMembers([])) }),
		Message.CompletedFetchNamespaces({
			result: Result.succeed(["checkout", "payments", "search", "", "it's"]),
		}),
	])

/** One click in the namespace list: adds the namespace, or removes it when already chosen. */
const clickNamespace = (value: string) =>
	Message.GotNamespacesMessage({ message: Combobox.Message.ClickedItem({ value }) })

describe("a role limited to namespaces", () => {
	test("turning the limit on unticks what needs every namespace, Read telemetry included", () => {
		const limited = run(opened(ON_CALL.id), [Message.ToggledLimit()])
		expect(limited.isLimited).toBe(true)
		expect(limited.permissions).not.toContain("telemetry:read")
		expect(limited.permissions).not.toContain("alerts:manage")
		expect(Arr.every(limited.permissions, Policy.holdableWhenScoped)).toBe(true)
		// What needs no telemetry stays ticked.
		expect(limited.permissions).toContain("devices:connect")
	})

	test("it cannot be saved until a namespace is chosen, then sends the namespaces and no telemetry tick", () => {
		const limited = run(opened(ON_CALL.id), [Message.ToggledLimit()])
		expect(saveArgs(pageUpdate(limited, Message.ClickedSave()))).toBeUndefined()

		const chosen = run(limited, [clickNamespace("payments"), clickNamespace("checkout")])
		expect(saveArgs(pageUpdate(chosen, Message.ClickedSave()))).toMatchObject({
			roleId: ON_CALL.id,
			payload: {
				namespaces: ["checkout", "payments"],
				permissions: expect.not.arrayContaining(["telemetry:read", Policy.SCOPED_READ]),
			},
		})
	})

	test("a permission that needs every namespace cannot be ticked while the limit is on", () => {
		const before = openedLimited()
		const after = run(before, [
			Message.ToggledPermission({ permission: "alerts:manage" }),
			Message.ToggledPermission({ permission: "telemetry:read" }),
			Message.ToggledPermission({ permission: "query:sql" }),
		])
		expect(after.permissions).toEqual(before.permissions)
	})

	test("opens with the limit on, its namespaces chosen and nothing unsaved", () => {
		const model = openedLimited()
		expect(unsavedChanges(model)).toBe(0)
		scene(
			{ update: pageUpdate, view },
			given(model),
			tabsMounted,
			expectView(role("switch", { name: "Limit to namespaces" })).toBeChecked(),
			expectView(text("checkout")).toExist(),
			expectView(text("Replaced by the namespace limit")).toExist(),
			expectView(text("Needs every namespace")).toExist(),
		)
	})

	test("another namespace is one unsaved change, and saving it ends the change", () => {
		const edited = run(openedLimited(), [clickNamespace("search")])
		expect(unsavedChanges(edited)).toBe(1)
		const saving = pageUpdate(edited, Message.ClickedSave())
		expect(saveArgs(saving)).toMatchObject({ payload: { namespaces: ["checkout", "search"] } })
		const done = pageUpdate(
			saving.model,
			Message.CompletedSave({
				result: Result.succeed(customRole({ ...CHECKOUT, namespaces: ["checkout", "search"] })),
			}),
		)
		expect(done.model.namespaces).toEqual(["checkout", "search"])
		expect(done.model.isLimited).toBe(true)
	})

	test("turning the limit off ticks Read telemetry and sends no namespaces", () => {
		const lifted = run(openedLimited(), [Message.ToggledLimit()])
		expect(lifted.permissions).toContain("telemetry:read")
		expect(saveArgs(pageUpdate(lifted, Message.ClickedSave()))).toMatchObject({
			payload: {
				namespaces: [],
				permissions: expect.arrayContaining(["telemetry:read", "support:join"]),
			},
		})
	})

	test("turning the limit on and off again puts every tick back", () => {
		const before = opened(ON_CALL.id)
		const after = run(before, [Message.ToggledLimit(), Message.ToggledLimit()])
		expect([...after.permissions].sort()).toEqual([...before.permissions].sort())
		expect(unsavedChanges(after)).toBe(0)
	})

	// Nothing was set aside, so nothing comes back: a role that never read telemetry does not start to.
	test("turning the limit on and off on a role with no telemetry leaves it without any", () => {
		const bare = customRole({
			id: Policy.CustomRoleId.make("role_bare00000000"),
			name: "Bare",
			permissions: [],
		})
		const model = run(init({ _tag: "RoleEditor", roleId: bare.id }, context).model, [
			Message.CompletedFetchSession({ orgId: ORG, grants: Policy.grantsOf(["org:admin"]) }),
			Message.CompletedFetchRoles({ result: Result.succeed(roleList([bare])) }),
			Message.ToggledLimit(),
			Message.ToggledLimit(),
		])
		expect(model.permissions).toEqual([])
		expect(unsavedChanges(model)).toBe(0)
	})

	// Read telemetry was ticked only for Run raw SQL: it still goes when SQL does, after a round trip.
	test("a tick that was only implied is still only implied after the limit is turned on and off", () => {
		const bare = customRole({
			id: Policy.CustomRoleId.make("role_bare00000000"),
			name: "Bare",
			permissions: [],
		})
		const model = run(init({ _tag: "RoleEditor", roleId: bare.id }, context).model, [
			Message.CompletedFetchSession({ orgId: ORG, grants: Policy.grantsOf(["org:admin"]) }),
			Message.CompletedFetchRoles({ result: Result.succeed(roleList([bare])) }),
			Message.ToggledPermission({ permission: "query:sql" }),
			Message.ToggledLimit(),
			Message.ToggledLimit(),
		])
		expect([...model.permissions].sort()).toEqual(["query:sql", "telemetry:read"])
		const unticked = run(model, [Message.ToggledPermission({ permission: "query:sql" })])
		expect(unticked.permissions).toEqual([])
	})

	test("a namespace the list does not know is added by typing its exact name", () => {
		const type = (value: string) =>
			Message.GotNamespacesMessage({ message: Combobox.Message.ChangedInput({ value }) })
		const typed = run(openedLimited(), [type(" audit ")])
		expect(namespaceChoices(typed)).toContain("audit")
		const added = run(typed, [clickNamespace("audit")])
		expect(saveArgs(pageUpdate(added, Message.ClickedSave()))).toMatchObject({
			payload: { namespaces: ["audit", "checkout"] },
		})
		// What could not be a namespace is not offered.
		expect(namespaceChoices(run(openedLimited(), [type("it's")]))).toEqual([
			"checkout",
			"payments",
			"search",
		])
	})

	test("Discard puts the limit back as saved", () => {
		const discarded = run(openedLimited(), [
			Message.ToggledLimit(),
			Message.ToggledPermission({ permission: "alerts:manage" }),
			Message.ClickedDiscard(),
		])
		expect(discarded.isLimited).toBe(true)
		expect(discarded.namespaces).toEqual(["checkout"])
		expect(unsavedChanges(discarded)).toBe(0)
	})

	test("offers only namespaces a role can name", () => {
		expect(openedLimited().knownNamespaces).toEqual(["checkout", "payments", "search"])
	})

	test("refuses to save more namespaces than a role may name", () => {
		const many = Arr.makeBy(Policy.MAX_ROLE_NAMESPACES + 1, (index) => `ns-${index}`)
		const crowded = run(
			{ ...openedLimited(), knownNamespaces: many },
			Arr.map(many, (namespace) => clickNamespace(namespace)),
		)
		expect(saveArgs(pageUpdate(crowded, Message.ClickedSave()))).toBeUndefined()
	})

	test("says so when the namespace list could not be read, and keeps the role's own", () => {
		const failed = pageUpdate(
			openedLimited(),
			Message.CompletedFetchNamespaces({ result: Result.fail(toLoadFailure(new Error("down"))) }),
		).model
		expect(failed.isNamespaceListFailed).toBe(true)
		expect(failed.namespaces).toEqual(["checkout"])
	})

	test("someone who cannot manage roles reads the limit as a sentence, with no switch", () => {
		scene(
			{ update: pageUpdate, view },
			given(openedLimited(Policy.grantsOf(["org:member"]))),
			tabsMounted,
			expectView(text("Limited to checkout")).toExist(),
			expectView(role("switch", { name: "Limit to namespaces" })).toBeAbsent(),
		)
	})

	test("a built-in role offers no limit", () => {
		scene(
			{ update: pageUpdate, view },
			given(opened("engineer")),
			tabsMounted,
			expectView(role("switch", { name: "Limit to namespaces" })).toBeAbsent(),
			expectView(text("Read telemetry in chosen namespaces")).toBeAbsent(),
		)
	})
})

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

	test("unticking a permission unticks what it alone had ticked, and keeps what was ticked by hand", () => {
		const reader = run(opened(STATUS_EDITOR.id), [
			Message.ToggledPermission({ permission: "status_pages:edit" }),
			Message.ToggledPermission({ permission: "telemetry:read" }),
		])
		const withSql = run(reader, [Message.ToggledPermission({ permission: "query:sql" })])
		expect(
			run(withSql, [Message.ToggledPermission({ permission: "query:sql" })]).permissions,
		).not.toContain("telemetry:read")
		const byHand = run(reader, [
			Message.ToggledPermission({ permission: "telemetry:read" }),
			Message.ToggledPermission({ permission: "query:sql" }),
			Message.ToggledPermission({ permission: "query:sql" }),
		])
		expect(byHand.permissions).toContain("telemetry:read")
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
