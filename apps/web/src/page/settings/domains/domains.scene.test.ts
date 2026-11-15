import * as Policy from "@maple/domain/policy"
import { Array as Arr, Result } from "effect"
import { describe, expect, test } from "vitest"
import * as Field from "@maple/views/ui/field"
import * as Select from "@maple/views/ui/select"
import { visibleTabs, visibleSections } from "../nav"
import { type DomainRow, Message, type Model } from "./model"
import { init, isOnDomain, normalizeDomain, update } from "./update"

const row = (overrides: Partial<DomainRow> = {}): DomainRow => ({
	id: "dmn_1",
	name: "acme.com",
	isVerified: false,
	enrollment: "manual_invitation",
	affiliationEmail: null,
	...overrides,
})

const names = (step: { readonly commands?: ReadonlyArray<{ readonly name: string }> }) =>
	Arr.map(step.commands ?? [], (command) => command.name)

const loaded = (rows: ReadonlyArray<DomainRow>): Model =>
	update(init().model, Message.CompletedFetchDomains({ result: Result.succeed(rows) })).model

const typed = (value: string) => Field.update(Field.init(), Field.Message.ChangedValue({ value })).model

describe("domain input", () => {
	test("a pasted URL, address or trailing dot all mean the bare domain", () => {
		expect(normalizeDomain(" https://Acme.com/login ")).toBe("acme.com")
		expect(normalizeDomain("ops@acme.com")).toBe("acme.com")
		expect(normalizeDomain("acme.com.")).toBe("acme.com")
	})

	test("the verification address must sit on the domain itself, not a lookalike", () => {
		expect(isOnDomain("Me@Acme.com", "acme.com")).toBe(true)
		expect(isOnDomain("me@notacme.com", "acme.com")).toBe(false)
		expect(isOnDomain("me@mail.acme.com", "acme.com")).toBe(false)
	})
})

describe("domains tab", () => {
	test("only an organization admin sees the tab", () => {
		const tabs = (roles: ReadonlyArray<string>) =>
			visibleTabs(
				visibleSections({
					isClerk: true,
					grants: Policy.grantsOf(roles),
					canAccessDataPlatform: false,
					hasDataSources: false,
				}),
			)
		expect(tabs(["org:admin"])).toContain("domains")
		expect(tabs(["org:member"])).not.toContain("domains")
	})

	test("adding a domain goes straight on to verifying it", () => {
		const start = { ...init().model, domainField: typed("Acme.com") }
		const submitted = update(start, Message.SubmittedAdd())
		expect(names(submitted)).toEqual(["CreateClerkDomain"])
		const added = update(submitted.model, Message.CompletedAdd({ result: Result.succeed(row()) }))
		expect(names(added)).toContain("FetchClerkDomains")
		expect(added.model.verifying).toMatchObject({ id: "dmn_1", step: "email" })
		expect(added.model.verifyDialog.isOpen).toBe(true)
	})

	test("no code is sent to an address off the domain", () => {
		const open = update(loaded([row()]), Message.ClickedVerify({ id: "dmn_1" })).model
		const wrong = update({ ...open, emailField: typed("me@gmail.com") }, Message.SubmittedVerify())
		expect(names(wrong)).toEqual([])
		const right = update({ ...open, emailField: typed("me@acme.com") }, Message.SubmittedVerify())
		expect(names(right)).toEqual(["PrepareClerkDomainVerification"])
	})

	test("a sent code moves to the code step, and a right code closes the dialog and re-reads", () => {
		const open = update(loaded([row()]), Message.ClickedVerify({ id: "dmn_1" })).model
		const sent = update(
			{ ...open, isVerifyPending: true },
			Message.CompletedSendCode({
				id: "dmn_1",
				email: "me@acme.com",
				result: Result.succeed(undefined),
			}),
		).model
		expect(sent.verifying).toMatchObject({ step: "code", email: "me@acme.com" })
		const attempted = update({ ...sent, codeField: typed("424242") }, Message.SubmittedVerify())
		expect(names(attempted)).toEqual(["AttemptClerkDomainVerification"])
		const verified = update(
			attempted.model,
			Message.CompletedAttemptCode({
				id: "dmn_1",
				name: "acme.com",
				result: Result.succeed(undefined),
			}),
		)
		expect(verified.model.verifying).toBeNull()
		expect(names(verified)).toContain("FetchClerkDomains")
	})

	test("a wrong code keeps the dialog on the code step for another try", () => {
		const open = update(loaded([row()]), Message.ClickedVerify({ id: "dmn_1" })).model
		const onCode = {
			...open,
			verifying: { id: "dmn_1", name: "acme.com", step: "code" as const, email: "me@acme.com" },
		}
		const failed = update(
			{ ...onCode, isVerifyPending: true },
			Message.CompletedAttemptCode({
				id: "dmn_1",
				name: "acme.com",
				result: Result.fail("Incorrect code"),
			}),
		)
		expect(failed.model.verifying?.step).toBe("code")
		expect(failed.model.isVerifyPending).toBe(false)
		expect(failed.outMessage?._tag).toBe("RequestedToast")
	})

	test("picking auto-invite on a verified domain saves it, and a failed save puts the select back", () => {
		const model = loaded([row({ isVerified: true })])
		const picked = update(
			model,
			Message.GotEnrollmentSelectMessage({
				id: "dmn_1",
				message: Select.Message.SelectedItem({ index: 0, value: "automatic_invitation" }),
			}),
		)
		expect(names(picked)).toContain("UpdateClerkDomainEnrollment")
		expect(picked.model.savingEnrollment).toEqual(["dmn_1"])
		const failed = update(
			picked.model,
			Message.CompletedEnrollment({
				id: "dmn_1",
				name: "acme.com",
				next: "automatic_invitation",
				result: Result.fail("Forbidden"),
			}),
		)
		expect(failed.model.savingEnrollment).toEqual([])
		expect(failed.model.enrollmentSelects).toEqual({})
	})
})
