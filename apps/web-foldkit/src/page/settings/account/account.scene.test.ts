import { DigestSubscriptionResponse } from "@maple/domain/http"
import { Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
import * as EmailPreferences from "./email-preferences/update"
import { Message as EmailPreferencesMessage } from "./email-preferences/model"
import * as Password from "./password/update"
import { Message as PasswordMessage } from "./password/model"
import { canRemove } from "./emails/update"
import type { AccountUser } from "./user"

const user: AccountUser = {
	id: "user_ada",
	firstName: "Ada",
	lastName: "Lovelace",
	fullName: "Ada Lovelace",
	hasImage: false,
	primaryEmail: "ada@acme.test",
	primaryEmailAddressId: "email_primary",
	emails: [
		{ id: "email_primary", email: "ada@acme.test", isVerified: true },
		{ id: "email_other", email: "ada@lovelace.test", isVerified: true },
	],
	passkeys: [],
	externalAccounts: [],
	passwordEnabled: true,
	totpEnabled: false,
	backupCodeEnabled: false,
	deleteSelfEnabled: true,
}

describe("password tab", () => {
	const loaded = Password.update(Password.init().model, PasswordMessage.CompletedReadUser({ user })).model
	const typed = [
		PasswordMessage.ChangedPassword({ field: "current", value: "old-password-1" }),
		PasswordMessage.ChangedPassword({ field: "next", value: "new-password-2" }),
		PasswordMessage.ChangedPassword({ field: "confirm", value: "new-password-2" }),
	].reduce((model, message) => Password.update(model, message).model, loaded)

	test("a short or mismatched password cannot be submitted", () => {
		const short = Password.update(loaded, PasswordMessage.ChangedPassword({ field: "next", value: "short" })).model
		expect(Password.isTooShort(short)).toBe(true)
		expect(Password.canSubmit(short)).toBe(false)
	})

	test("submit sends the current password, the new one and the sign-out choice", () => {
		expect(Password.update(typed, PasswordMessage.ClickedSubmit()).commands?.[0]).toMatchObject({
			name: "UpdateClerkPassword",
			args: { newPassword: "new-password-2", currentPassword: "old-password-1", signOutOfOtherSessions: true },
		})
	})

	test("a changed password clears the fields", () => {
		const done = Password.update(typed, PasswordMessage.CompletedSubmit({ hadPassword: true, result: Result.succeed(undefined) }))
		expect([done.model.current, done.model.next, done.model.confirm]).toEqual(["", "", ""])
	})
})

describe("email addresses tab", () => {
	test("the primary address and the last verified one cannot be removed", () => {
		expect(canRemove(user, { id: "email_primary", email: "ada@acme.test", isVerified: true })).toBe(false)
		expect(canRemove(user, { id: "email_other", email: "ada@lovelace.test", isVerified: true })).toBe(true)
		const single = { ...user, primaryEmailAddressId: null, emails: [{ id: "only", email: "ada@acme.test", isVerified: true }] }
		expect(canRemove(single, { id: "only", email: "ada@acme.test", isVerified: true })).toBe(false)
	})
})

describe("email preferences tab", () => {
	const subscription = Schema.decodeUnknownSync(DigestSubscriptionResponse)({
		id: "0199a0d6-0000-7000-8000-000000000001",
		email: "ada@acme.test",
		enabled: true,
		dayOfWeek: 1,
		sendHour: 9,
		timezone: "Europe/London",
		namespaces: [],
		environments: ["production"],
		lastSentAt: null,
		webAnalyticsEnabled: false,
		createdAt: 0,
		updatedAt: 0,
	})
	const entered = EmailPreferences.update(
		EmailPreferences.init().model,
		EmailPreferencesMessage.CompletedReadEntry({
			email: "ada@acme.test",
			orgName: "Acme Shop",
			supportedZones: ["Europe/London"],
			browserZone: "Europe/Berlin",
		}),
	).model

	test("someone who never subscribed gets Monday 09:00 in the browser's zone, and a toggle records it", () => {
		const fresh = EmailPreferences.update(entered, EmailPreferencesMessage.CompletedFetchSubscription({ result: Result.succeed(null) })).model
		expect(EmailPreferences.draftOf(fresh)).toMatchObject({ dayOfWeek: 1, sendHour: 9, timezone: "Europe/Berlin" })
		expect(EmailPreferences.update(fresh, EmailPreferencesMessage.ToggledOps()).commands?.[0]).toMatchObject({
			name: "ToggleDigest",
			args: { isOn: false, enabled: false, fields: { timezone: "Europe/Berlin" } },
		})
	})

	test("turning the web digest on keeps the ops digest's state", () => {
		const saved = EmailPreferences.update(
			entered,
			EmailPreferencesMessage.CompletedFetchSubscription({ result: Result.succeed(subscription) }),
		).model
		expect(EmailPreferences.update(saved, EmailPreferencesMessage.ToggledWeb()).commands?.[0]).toMatchObject({
			name: "ToggleDigest",
			args: { digest: "web", isOn: true, enabled: true, fields: { webAnalyticsEnabled: true } },
		})
	})

	test("a schedule edit is unsaved until Save sends the whole draft", () => {
		const saved = EmailPreferences.update(
			entered,
			EmailPreferencesMessage.CompletedFetchSubscription({ result: Result.succeed(subscription) }),
		).model
		const edited = EmailPreferences.update(saved, EmailPreferencesMessage.ChangedSchedule({ field: "dayOfWeek", value: "2" })).model
		expect(EmailPreferences.isDraftDirty(edited)).toBe(true)
		expect(EmailPreferences.update(edited, EmailPreferencesMessage.ClickedSave()).commands?.[0]).toMatchObject({
			name: "SaveDigestPreferences",
			args: { submitted: { dayOfWeek: 2, sendHour: 9, timezone: "Europe/London", environments: ["production"] } },
		})
	})

	test("Save waits while a digest toggle is in flight, so it cannot resend the old enabled state", () => {
		const saved = EmailPreferences.update(
			entered,
			EmailPreferencesMessage.CompletedFetchSubscription({ result: Result.succeed(subscription) }),
		).model
		const edited = EmailPreferences.update(saved, EmailPreferencesMessage.ChangedSchedule({ field: "dayOfWeek", value: "2" })).model
		const toggling = EmailPreferences.update(edited, EmailPreferencesMessage.ToggledOps()).model
		expect(EmailPreferences.update(toggling, EmailPreferencesMessage.ClickedSave()).commands ?? []).toEqual([])
	})
})
