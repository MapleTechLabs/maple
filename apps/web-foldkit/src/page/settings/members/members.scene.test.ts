import { Result } from "effect"
import { describe, expect, test } from "vitest"
import * as Field from "../../../ui/field"
import { PageOutMessage } from "../../contract"
import { Message } from "./model"
import { hasMore, init, update } from "./update"

const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) => (commands ?? []).map(({ name }) => name)

const member = (id: string, isCurrentUser: boolean) => ({
	id,
	name: isCurrentUser ? "Ada Lovelace" : "Grace Hopper",
	identifier: `${id}@acme.test`,
	role: isCurrentUser ? "org:admin" : "org:member",
	createdAtMs: 0,
	isCurrentUser,
})

const loaded = () =>
	update(
		update(init(true).model, Message.CompletedFetchOrganization({ name: "Acme Shop" })).model,
		Message.CompletedFetchMembers({ page: 1, result: Result.succeed({ rows: [member("ada", true), member("grace", false)], total: 12 }) }),
	).model

describe("members tab", () => {
	test("a member reads the first admin's name for the notice; an admin does not", () => {
		expect(names(init(false).commands)).toContain("FetchMembersAdminName")
		expect(names(init(true).commands)).not.toContain("FetchMembersAdminName")
	})

	test("Load more asks Clerk for the next page and appends it", () => {
		const model = loaded()
		const more = update(model, Message.ClickedLoadMoreMembers())
		expect(more.commands?.[0]).toMatchObject({ name: "FetchClerkMemberships", args: { page: 2 } })
		const appended = update(
			more.model,
			Message.CompletedFetchMembers({ page: 2, result: Result.succeed({ rows: [member("linus", false)], total: 12 }) }),
		).model
		const rows = appended.members._tag === "Success" ? appended.members.data.rows : []
		expect(rows.map((row) => row.id)).toEqual(["ada", "grace", "linus"])
		expect(appended.members._tag === "Success" && hasMore(appended.members.data)).toBe(true)
	})

	test("Send invitation sends the trimmed email with the picked role, then refreshes invitations", () => {
		const typed = update(
			loaded(),
			Message.GotInviteEmailMessage({ message: Field.Message.ChangedValue({ value: " grace@acme.test " }) }),
		).model
		expect(update(typed, Message.SubmittedInvite()).commands?.[0]).toMatchObject({
			name: "InviteClerkMember",
			args: { email: "grace@acme.test", role: "org:member" },
		})
		const sent = update(typed, Message.CompletedInvite({ email: "grace@acme.test", result: Result.succeed(undefined) }))
		expect(names(sent.commands)).toContain("FetchClerkInvitations")
		expect(sent.outMessage).toEqual(
			PageOutMessage.RequestedToast({ type: "success", title: "Invitation sent to grace@acme.test", description: "" }),
		)
	})

	test("a role change waits on the confirm strip", () => {
		const pending = { ...loaded(), pendingRole: { memberId: "grace", name: "Grace Hopper", next: "org:admin" as const } }
		expect(update(pending, Message.ClickedConfirmRole()).commands?.[0]).toMatchObject({
			name: "ChangeClerkMemberRole",
			args: { memberId: "grace", next: "org:admin" },
		})
		expect(update(pending, Message.ClickedCancelRole()).model.pendingRole).toBeNull()
	})
})
