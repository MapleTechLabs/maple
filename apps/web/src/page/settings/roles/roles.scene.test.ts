import { CreateRoleRequest, RoleConflictError } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { Array as Arr, Context, Effect, Option, Result, Schema, String as Str } from "effect"
import { expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import * as Dialog from "@maple/views/ui/dialog"
import { MountSelect, Message as SelectMessage } from "@maple/views/ui/select"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "@maple/views/data/load-failure"
import * as CreateDialog from "./create-dialog"
import { Message, type Model } from "./model"
import { MapleInternalApiClient } from "../../../platform/api-clients"
import { createRole } from "./roles"
import { customRole, ON_CALL, roleId, roleList, roleMembers, STATUS_EDITOR } from "./test-roles"
import { entriesOf, init, update } from "./update"
import { headerActions, view as tabView } from "./view"

const ADMIN = Policy.grantsOf(["org:admin"])
const MEMBER = Policy.grantsOf(["org:member"])

const view = withViewInputs(tabView, {})()
const actions = withViewInputs(headerActions, {})()

const dialogMounted = Mount.resolve(Dialog.MountDialog, Dialog.Message.CompletedMountDialog())

const run = (model: Model, messages: ReadonlyArray<Message>): Model =>
	Arr.reduce(messages, model, (current, message) => update(current, message).model)

const loaded = (grants: ReadonlyArray<Policy.Permission> = ADMIN): Model =>
	run(init(grants).model, [
		Message.CompletedFetchRoles({ result: Result.succeed(roleList([ON_CALL, STATUS_EDITOR])) }),
	])

const namesOf = (step: { readonly commands?: ReadonlyArray<{ readonly name: string }> }) =>
	Arr.map(step.commands ?? [], (command) => command.name)

const argsOf = (
	step: { readonly commands?: ReadonlyArray<{ readonly name: string; readonly args?: unknown }> },
	name: string,
) => Option.getOrUndefined(Arr.findFirst(step.commands ?? [], (command) => command.name === name))?.args

describe("roles list", () => {
	test("built-in roles come first in their order, then the organization's own", () => {
		expect(Arr.map(entriesOf(loaded()), (entry) => entry.name)).toEqual([
			"Analyst",
			"Member",
			"Engineer",
			"Admin",
			"On-call responder",
			"Status page editor",
		])
	})

	test("each row says what the role holds and how many people hold it", () => {
		scene(
			{ update, view },
			given(loaded()),
			expectView(role("link", { name: "Admin" })).toExist(),
			expectView(text(`All ${Policy.allPermissions.length}`)).toExist(),
			expectView(text(`16 of ${Policy.allPermissions.length}`)).toExist(),
			expectView(text(`${ON_CALL.permissions.length} of ${Policy.allPermissions.length}`)).toExist(),
		)
	})

	test("a role's holders show as avatars, with the rest counted and nobody shown as None", () => {
		scene(
			{ update, view },
			given(loaded()),
			// Member: eight holders, four avatars then +4.
			expectView(role("group", { name: "8 members hold Member" })).toExist(),
			expectView(text("+4")).toExist(),
			expectView(role("group", { name: "3 members hold On-call responder" })).toExist(),
			expectView(text("None")).toExist(),
		)
	})

	test("a failed load offers Try again, which reads the list again", () => {
		const failed = run(init(ADMIN).model, [
			Message.CompletedFetchRoles({ result: Result.fail(toLoadFailure(new Error("down"))) }),
		])
		scene({ update, view }, given(failed), expectView(role("button", { name: "Try again" })).toExist())
		expect(namesOf(update(failed, Message.ClickedRetry()))).toEqual(["FetchRoles"])
	})

	test("someone who cannot manage roles sees Create role locked with who can", () => {
		scene(
			{ update, view: actions },
			given(loaded(MEMBER)),
			expectView(role("group", { name: Policy.denialFor("roles:manage").message })).toExist(),
		)
	})
})

describe("create role dialog", () => {
	const opened = () => update(loaded(), Message.ClickedCreate()).model
	const child = (message: CreateDialog.Message) => Message.GotCreateMessage({ message })
	const pickTemplate = (key: string) =>
		child(
			CreateDialog.Message.GotTemplateMessage({
				message: SelectMessage.SelectedItem({ index: 0, value: key }),
			}),
		)

	test("a custom role can be the template", () => {
		const filled = run(opened(), [
			child(CreateDialog.Message.ChangedName({ value: "Night shift" })),
			pickTemplate(ON_CALL.id),
		])
		expect(argsOf(update(filled, child(CreateDialog.Message.SubmittedCreate())), "CreateRole")).toEqual({
			name: "Night shift",
			description: "",
			permissions: Arr.filter(ON_CALL.permissions, Policy.grantableToCustomRoles),
		})
	})

	test("no template starts the role with no permissions", () => {
		const filled = run(opened(), [
			child(CreateDialog.Message.ChangedName({ value: "Night shift" })),
			pickTemplate("engineer"),
			pickTemplate(""),
		])
		expect(
			argsOf(update(filled, child(CreateDialog.Message.SubmittedCreate())), "CreateRole"),
		).toMatchObject({
			permissions: [],
		})
	})

	test("a copy of Engineer starts with what Engineer holds that a custom role may", () => {
		const filled = run(opened(), [
			child(CreateDialog.Message.ChangedName({ value: " Incident commander " })),
			pickTemplate("engineer"),
		])
		const submitted = update(filled, child(CreateDialog.Message.SubmittedCreate()))
		expect(argsOf(submitted, "CreateRole")).toEqual({
			name: "Incident commander",
			description: "",
			permissions: Arr.filter(Policy.builtInRoles[2].permissions, Policy.grantableToCustomRoles),
		})
		const created = update(
			submitted.model,
			child(CreateDialog.Message.CompletedCreate({ result: Result.succeed(STATUS_EDITOR) })),
		)
		expect(created.outMessage).toMatchObject({
			_tag: "RequestedNavigation",
			url: `/settings/roles/${STATUS_EDITOR.id}`,
		})
	})

	test("a taken name is said in the dialog, which stays open to fix it", () => {
		const failure = toLoadFailure(
			new RoleConflictError({
				message: "A role named Incident commander already exists.",
				reason: "name_taken",
			}),
		)
		const failed = run(opened(), [
			child(CreateDialog.Message.ChangedName({ value: "Incident commander" })),
			child(CreateDialog.Message.SubmittedCreate()),
			child(CreateDialog.Message.CompletedCreate({ result: Result.fail(failure) })),
		])
		expect(failed.create.dialog.isOpen).toBe(true)
		scene({ update, view }, given(failed), dialogMounted, expectView(text(failure.message)).toExist())
	})

	test("a long role's copy is named to fit, and creates", () => {
		const longRole = customRole({
			id: roleId("long"),
			name: "Platform reliability incident commander",
			permissions: ["telemetry:read"],
		})
		const listed = run(init(ADMIN).model, [
			Message.CompletedFetchRoles({ result: Result.succeed(roleList([longRole])) }),
		])
		const duplicated = update(
			listed,
			Message.GotRowMenuMessage({
				menuId: `role-actions-${longRole.id}`,
				message: { _tag: "ClickedItem", index: 1, item: { kind: "Item", value: "duplicate" } },
			}),
		).model
		expect(duplicated.create.name).toBe("Platform reliability incident comma copy")
		const args = argsOf(update(duplicated, child(CreateDialog.Message.SubmittedCreate())), "CreateRole")
		expect(Schema.decodeUnknownExit(CreateRoleRequest)(args)._tag).toBe("Success")
	})

	test("a name past the limit cannot be submitted", () => {
		const tooLong = run(opened(), [
			child(
				CreateDialog.Message.ChangedName({ value: Str.repeat(Policy.CUSTOM_ROLE_NAME_MAX + 1)("x") }),
			),
		])
		expect(namesOf(update(tooLong, child(CreateDialog.Message.SubmittedCreate())))).not.toContain(
			"CreateRole",
		)
	})

	test("a draft the dialog let through fails the call instead of throwing", async () => {
		const outcome = await Effect.runPromise(
			createRole({
				name: Str.repeat(Policy.CUSTOM_ROLE_NAME_MAX + 1)("x"),
				description: "",
				permissions: [],
			}).pipe(
				// The decode fails first, so the API client is never reached.
				Effect.provide(Context.makeUnsafe<MapleInternalApiClient>(new Map())),
				Effect.result,
			),
		)
		expect(outcome._tag).toBe("Failure")
	})

	test("a nameless role cannot be submitted", () => {
		const submitted = update(opened(), child(CreateDialog.Message.SubmittedCreate()))
		expect(namesOf(submitted)).not.toContain("CreateRole")
	})
})

describe("delete role dialog", () => {
	const deleting = () => {
		const step = update(
			loaded(),
			Message.GotRowMenuMessage({
				menuId: `role-actions-${ON_CALL.id}`,
				message: { _tag: "ClickedItem", index: 2, item: { kind: "Item", value: "delete" } },
			}),
		)
		return { step, model: step.model }
	}

	test("a role people hold asks where they move, lists them, and sends the pick", () => {
		const { step, model } = deleting()
		expect(argsOf(step, "FetchDeletedRoleMembers")).toEqual({ roleId: ON_CALL.id })
		const withMembers = run(model, [
			Message.CompletedFetchDeleteMembers({
				roleId: ON_CALL.id,
				result: Result.succeed(
					roleMembers([
						{ id: "user_grace", name: "Grace Hopper" },
						{ id: "user_alan", name: "Alan Turing" },
						{ id: "user_katherine", name: "Katherine Johnson" },
					]),
				),
			}),
			Message.GotReassignMessage({ message: { _tag: "SelectedItem", index: 2, value: "engineer" } }),
		])
		scene(
			{ update, view },
			given(withMembers),
			dialogMounted,
			expectView(text("3 members hold it. Choose the role they move to.")).toExist(),
			expectView(text("Grace Hopper")).toExist(),
		)
		expect(argsOf(update(withMembers, Message.ClickedConfirmDelete()), "DeleteRole")).toEqual({
			roleId: ON_CALL.id,
			name: ON_CALL.name,
			reassignTo: { _tag: "BuiltIn", clerkKey: "org:engineer" },
		})
	})

	test("its members may move to any other role but Admin, which would promote them all unconfirmed", () => {
		const { model } = deleting()
		const withMembers = run(model, [
			Message.CompletedFetchDeleteMembers({
				roleId: ON_CALL.id,
				result: Result.succeed(roleMembers([{ id: "user_grace", name: "Grace Hopper" }])),
			}),
			Message.GotReassignMessage({ message: SelectMessage.ClickedTrigger({ selectedIndex: 1 }) }),
		])
		scene(
			{ update, view },
			given(withMembers),
			dialogMounted,
			Mount.resolve(MountSelect, SelectMessage.CompletedMountSelect()),
			expectView(role("option", { name: "Engineer" })).toExist(),
			expectView(role("option", { name: "Admin" })).toBeAbsent(),
		)
	})

	test("deleted, the list reads again and the toast names the role", () => {
		const { model } = deleting()
		const confirmed = update(model, Message.ClickedConfirmDelete()).model
		const done = update(
			confirmed,
			Message.CompletedDelete({ name: ON_CALL.name, result: Result.succeed(undefined) }),
		)
		expect(namesOf(done)).toContain("FetchRoles")
		expect(done.outMessage).toMatchObject({ _tag: "RequestedToast", title: "On-call responder deleted" })
	})
})
