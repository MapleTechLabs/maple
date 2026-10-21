import { Result } from "effect"
import { describe, expect, test } from "vitest"
import { PageOutMessage } from "../../contract"
import { Message } from "./model"
import { init, isNameDirty, leaveEligibilityOf, nameDraftOf, update } from "./update"

const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) => (commands ?? []).map(({ name }) => name)

const acme = { id: "org_acme", name: "Acme Shop", hasImage: false, region: "us" } as const

const loaded = (isAdmin = true) => {
	const org = update(init(isAdmin).model, Message.CompletedFetchOrganization({ result: Result.succeed(acme) })).model
	return update(org, Message.CompletedFetchAdmins({ result: Result.succeed({ count: 1, firstAdminName: "Ada Lovelace" }) })).model
}

describe("general tab", () => {
	test("reads the organization and its admins from Clerk", () => {
		expect(names(init(true).commands)).toEqual(
			expect.arrayContaining(["FetchClerkOrganization", "FetchClerkOrganizationAdmins"]),
		)
	})

	test("an edited name is dirty and Save sends it trimmed", () => {
		const edited = update(loaded(), Message.ChangedName({ value: "  Acme Retail " })).model
		expect(isNameDirty(edited)).toBe(true)
		expect(update(edited, Message.ClickedSaveName()).commands?.[0]).toMatchObject({
			name: "RenameClerkOrganization",
			args: { submitted: "  Acme Retail ", sent: "Acme Retail" },
		})
	})

	test("a saved rename toasts and rereads the organization; the edit is no longer unsaved", () => {
		const edited = update(loaded(), Message.ChangedName({ value: "Acme Retail" })).model
		const saving = update(edited, Message.ClickedSaveName()).model
		const done = update(
			saving,
			Message.CompletedSaveName({ submitted: "Acme Retail", sent: "Acme Retail", result: Result.succeed(undefined) }),
		)
		expect(names(done.commands)).toEqual(["FetchClerkOrganization"])
		expect(done.outMessage).toEqual(PageOutMessage.RequestedToast({ type: "success", title: "Organization renamed", description: "" }))
		expect(isNameDirty(done.model)).toBe(false)
		expect(nameDraftOf(done.model)).toBe("Acme Retail")
	})

	test("the only admin cannot leave; a member can", () => {
		expect(leaveEligibilityOf(loaded(true))).toBe("last-admin")
		expect(leaveEligibilityOf(loaded(false))).toBe("allowed")
		expect(update(loaded(true), Message.ClickedConfirmLeave()).commands ?? []).toEqual([])
	})

	test("delete waits for the organization's name to be typed back", () => {
		const opened = loaded()
		expect(update(opened, Message.ClickedConfirmDelete()).commands ?? []).toEqual([])
		const typed = update(opened, Message.ChangedConfirmText({ value: "Acme Shop" })).model
		expect(names(update(typed, Message.ClickedConfirmDelete()).commands)).toEqual(["DeleteOrganization"])
	})
})
