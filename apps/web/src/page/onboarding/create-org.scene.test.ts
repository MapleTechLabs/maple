import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import {
	click,
	Command,
	expect as expectView,
	given,
	label,
	Mount,
	role,
	scene,
	submit,
	text,
	type,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { currentRegion } from "../../lib/region"
import {
	CreateOrganization,
	init,
	JoinInvitation,
	LeaveFor,
	Message,
	type Model,
	MountDitherField,
	update,
} from "./create-org"
import { view as createOrgView } from "./create-org-view"

const view = (model: Model, h: HtmlBuilder<Message>): Html => createOrgView(h, model, "david@acme.dev")

const user = Option.some({ fullName: "David Smith", email: "david@acme.dev", imageUrl: "" })
const mounted = Mount.resolve(MountDitherField, Message.CompletedMountDitherField())
const nameField = label("What should we call it?")
const form = role("form", { name: "Create your organization" })

const invited = update(
	init(user).model,
	Message.LoadedInvitations({
		invitations: [{ id: "orginv_1", orgId: "org_heartbeat", orgName: "Heartbeat", imageUrl: "" }],
	}),
).model

describe("create your first organization", () => {
	test("the name is guessed from the work email and the button follows what is typed", () => {
		scene(
			{ update, view },
			given(init(user).model),
			mounted,
			expectView(role("heading", { name: "Let's give your team a home." })).toExist(),
			expectView(nameField).toHaveValue("Acme"),
			expectView(text("We guessed from acme.dev. Rename it whenever you like.")).toExist(),
			type(nameField, "Acme Labs"),
			expectView(role("button", { name: "Create Acme Labs" })).toExist(),
		)
	})

	test("creating sends the name and region, then opens the new org", () => {
		scene(
			{ update, view },
			given(init(user).model),
			mounted,
			submit(form),
			Command.expectExact(CreateOrganization({ name: "Acme", region: currentRegion })),
			expectView(role("button", { name: "Create Acme" })).toBeDisabled(),
			Command.resolve(CreateOrganization, Message.SucceededCreate({ orgId: "org_acme" })),
			Command.expectExact(LeaveFor({ orgId: "org_acme", targetUrl: null })),
			Command.resolve(LeaveFor, Message.CompletedLeave()),
		)
	})

	test("a refused create shows the API's reason and lets them try again", () => {
		scene(
			{ update, view },
			given(init(user).model),
			mounted,
			submit(form),
			Command.resolve(CreateOrganization, Message.FailedCreate({ message: "Name is already taken" })),
			expectView(text("Name is already taken")).toExist(),
			expectView(role("button", { name: "Create Acme" })).not.toBeDisabled(),
		)
	})

	test("a failure without a reason still tells them it did not work", () => {
		scene(
			{ update, view },
			given(init(user).model),
			mounted,
			submit(form),
			Command.resolve(CreateOrganization, Message.FailedCreate({ message: "" })),
			expectView(text("Couldn't create your organization. Try again.")).toExist(),
		)
	})

	test("an empty name cannot be submitted", () => {
		scene(
			{ update, view },
			given(init(user).model),
			mounted,
			type(nameField, "   "),
			expectView(role("button", { name: "Create your organization" })).toBeDisabled(),
			submit(form),
			Command.expectNone(),
		)
	})

	test("an invitation can be joined instead of creating a new org", () => {
		scene(
			{ update, view },
			given(invited),
			mounted,
			expectView(text("Heartbeat")).toExist(),
			click(role("button", { name: "Join Heartbeat" })),
			Command.expectExact(JoinInvitation({ invitationId: "orginv_1" })),
			expectView(role("button", { name: "Create Acme" })).toBeDisabled(),
			Command.resolve(JoinInvitation, Message.SucceededJoin({ orgId: "org_heartbeat" })),
			Command.expectExact(LeaveFor({ orgId: "org_heartbeat", targetUrl: null })),
			Command.resolve(LeaveFor, Message.CompletedLeave()),
		)
	})

	test("a personal address suggests the person's own team", () => {
		const personal = init(
			Option.some({ fullName: "David Smith", email: "david@gmail.com", imageUrl: "" }),
		).model
		expect(personal.name).toBe("David's team")
		expect(personal.suggestedFrom).toBeNull()
	})
})
