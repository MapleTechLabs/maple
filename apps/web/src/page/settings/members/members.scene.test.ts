import * as Policy from "@maple/domain/policy"
import { AsyncData } from "foldkit"
import { Result, Array as Arr, Option } from "effect"
import { expect as expectView, given, scene, selector, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { Message, type Model } from "./model"
import { init, revisit, update } from "./update"
import { view } from "./view"

const ADMIN = Policy.grantsOf(["org:admin"])

const member = (id: string) => ({
	id,
	name: id,
	identifier: `${id}@acme.test`,
	imageUrl: "",
	role: "org:member",
	createdAtMs: 0,
	isCurrentUser: false,
})

describe("members tab", () => {
	test("only a member manager reads pending invitations; a member asks for the admin's name", () => {
		const names = (grants: ReadonlyArray<Policy.Permission>) =>
			Arr.map(init(grants).commands ?? [], (command) => command.name)
		expect(names(ADMIN)).toContain("FetchClerkInvitations")
		const asMember = names(Policy.grantsOf(["org:member"]))
		expect(asMember).not.toContain("FetchClerkInvitations")
		expect(asMember).toContain("FetchMembersAdminName")
	})

	test("a failed Load more keeps the rows and frees the button for another try", () => {
		const firstPage = {
			rows: Array.from({ length: 10 }, (_, index) => member(`user_${index}`)),
			total: 12,
		}
		const loaded = update(
			init(ADMIN).model,
			Message.CompletedFetchMembers({ page: 1, generation: 0, result: Result.succeed(firstPage) }),
		).model
		const fetching = update(loaded, Message.ClickedLoadMoreMembers())
		expect(Arr.map(fetching.commands ?? [], (command) => command.name)).toEqual(["FetchClerkMemberships"])
		const failed = update(
			fetching.model,
			Message.CompletedFetchMembers({
				page: 2,
				generation: 0,
				result: Result.fail(toLoadFailure(new Error("rate limited"))),
			}),
		).model
		const data = AsyncData.getOrElse(failed.members, () => null)
		expect(data?.rows).toHaveLength(10)
		expect(data?.isFetchingMore).toBe(false)
		expect(
			Arr.map(
				update(failed, Message.ClickedLoadMoreMembers()).commands ?? [],
				(command) => command.name,
			),
		).toEqual(["FetchClerkMemberships"])
	})
})

describe("members paging under a mutation", () => {
	test("a Load more in flight when a role change re-reads page 1 is dropped, not appended", () => {
		const firstPage = {
			rows: Array.from({ length: 10 }, (_, index) => member(`user_${index}`)),
			total: 12,
		}
		const loaded = update(
			init(ADMIN).model,
			Message.CompletedFetchMembers({ page: 1, generation: 0, result: Result.succeed(firstPage) }),
		).model
		const paging = update(loaded, Message.ClickedLoadMoreMembers()).model
		const changed = update(
			paging,
			Message.CompletedRoleChange({
				memberId: "user_1",
				name: "user_1",
				next: "org:admin",
				result: Result.succeed(undefined),
			}),
		)
		const reread = Arr.findFirst(
			changed.commands ?? [],
			(command) => command.name === "FetchClerkMemberships",
		)
		expect(Option.getOrUndefined(reread)?.args).toMatchObject({ page: 1 })
		const generation = changed.model.membersGeneration
		const refreshed = update(
			changed.model,
			Message.CompletedFetchMembers({ page: 1, generation, result: Result.succeed(firstPage) }),
		).model
		const stale = update(
			refreshed,
			Message.CompletedFetchMembers({
				page: 2,
				generation: 0,
				result: Result.succeed({ rows: [member("user_10"), member("user_11")], total: 12 }),
			}),
		).model
		const data = AsyncData.getOrElse(stale.members, () => null)
		expect(data?.rows).toHaveLength(10)
		expect(data?.isFetchingMore).toBe(false)
	})
})

describe("a role picked while another saves", () => {
	const pick = (model: Model, memberId: string, value: string) =>
		update(
			model,
			Message.GotRoleSelectMessage({ memberId, message: { _tag: "SelectedItem", index: 0, value } }),
		).model

	const savingAThenPickingB = () => {
		const loaded = update(
			init(ADMIN).model,
			Message.CompletedFetchMembers({
				page: 1,
				generation: 0,
				result: Result.succeed({ rows: [member("user_a"), member("user_b")], total: 2 }),
			}),
		).model
		const saving = update(pick(loaded, "user_a", "org:admin"), Message.ClickedConfirmRole()).model
		return pick(saving, "user_b", "org:admin")
	}

	test("the first change's success keeps the second pick on its confirm strip", () => {
		const done = update(
			savingAThenPickingB(),
			Message.CompletedRoleChange({
				memberId: "user_a",
				name: "user_a",
				next: "org:admin",
				result: Result.succeed(undefined),
			}),
		).model
		expect(done.pendingRole).toMatchObject({ _tag: "Confirming", memberId: "user_b" })
		expect(Arr.map(update(done, Message.ClickedConfirmRole()).commands ?? [], (c) => c.name)).toEqual([
			"ChangeClerkMemberRole",
		])
	})

	test("a second pick for the member being saved is dropped, so one save runs per member", () => {
		const loaded = update(
			init(ADMIN).model,
			Message.CompletedFetchMembers({
				page: 1,
				generation: 0,
				result: Result.succeed({ rows: [member("user_a")], total: 1 }),
			}),
		).model
		const saving = update(pick(loaded, "user_a", "org:admin"), Message.ClickedConfirmRole()).model
		const repicked = pick(saving, "user_a", "org:engineer")
		expect(repicked.pendingRole).toMatchObject({ _tag: "Saving", next: "org:admin" })
		expect(update(repicked, Message.ClickedConfirmRole()).commands ?? []).toEqual([])
	})

	test("the first change's failure leaves the second pick alone", () => {
		const failed = update(
			savingAThenPickingB(),
			Message.CompletedRoleChange({
				memberId: "user_a",
				name: "user_a",
				next: "org:admin",
				result: Result.fail("Couldn't change role"),
			}),
		)
		expect(failed.model.pendingRole).toMatchObject({ _tag: "Confirming", memberId: "user_b" })
		expect(failed.outMessage).toMatchObject({ _tag: "RequestedToast" })
	})
})

describe("members revisits after a failure", () => {
	test("two quick revisits read page 1 twice and only the newer answer lands", () => {
		const failure = Result.fail(toLoadFailure(new Error("down")))
		const failed = update(
			init(ADMIN).model,
			Message.CompletedFetchMembers({ page: 1, generation: 0, result: failure }),
		).model
		const generationOf = (step: ReturnType<typeof revisit>) =>
			Option.getOrUndefined(
				Arr.findFirst(step.commands ?? [], (command) => command.name === "FetchClerkMemberships"),
			)?.args?.generation
		const first = revisit(failed)
		const second = revisit(first.model)
		expect(generationOf(second)).not.toBe(generationOf(first))
		const newer = { rows: [member("user_new")], total: 1 }
		const landed = update(
			second.model,
			Message.CompletedFetchMembers({
				page: 1,
				generation: second.model.membersGeneration,
				result: Result.succeed(newer),
			}),
		).model
		const older = { rows: [member("user_old")], total: 1 }
		const late = update(
			landed,
			Message.CompletedFetchMembers({
				page: 1,
				generation: first.model.membersGeneration,
				result: Result.succeed(older),
			}),
		).model
		const lateRows = AsyncData.getOrElse(late.members, () => null)?.rows
		expect(lateRows === undefined ? undefined : Arr.map(lateRows, (row) => row.id)).toEqual(["user_new"])
	})
})

describe("members avatars", () => {
	test("a member's Clerk image is drawn over the initials", () => {
		const withOrg = update(init(ADMIN).model, Message.CompletedFetchOrganization({ name: "Acme" })).model
		const rows = [{ ...member("ada"), imageUrl: "https://img.clerk.test/ada.png" }, member("bob")]
		const page = Result.succeed({ rows, total: 2 })
		const loaded = update(
			withOrg,
			Message.CompletedFetchMembers({ page: 1, generation: 0, result: page }),
		).model
		const image = selector('[data-slot="avatar-image"]')
		scene(
			{
				update: (model: Model, message: Message) => update(model, message),
				view: withViewInputs(view, { nowMs: 0, timeZone: "UTC", isKnownMember: false })(),
			},
			given(loaded),
			expectView(image).toHaveAttr("src", "https://img.clerk.test/ada.png"),
		)
	})
})
