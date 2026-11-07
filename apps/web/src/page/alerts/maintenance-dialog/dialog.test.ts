import type { LoadFailure } from "@maple/views/data/load-failure"
import { Array as Arr, Option, Result } from "effect"
import { describe, expect, it } from "vitest"
import { runningWindow, weeklyWindow } from "../shared/maintenance-test-fixtures"
import {
	daysError,
	durationError,
	endsAtError,
	formErrors,
	init,
	Message,
	type Model,
	openEdit,
	openNew,
	update,
} from "./dialog"

// 2026-11-06 14:20 in Berlin (UTC+1).
const NOW = Date.UTC(2026, 10, 6, 13, 20)
const BERLIN = "Europe/Berlin"

const run = (model: Model, messages: ReadonlyArray<Message>): Model =>
	Arr.reduce(messages, model, (current, message) => update(current, message).model)

const opened = (): Model => openNew(init("test-window"), NOW, BERLIN).model

const saveArgs = (model: Model) => {
	const step = update(model, Message.ClickedSave())
	return { step, commands: step.commands ?? [] }
}

describe("weekly validation", () => {
	it("asks for at least one day", () => {
		expect(daysError([])).toEqual(Option.some("Pick at least one day"))
		expect(daysError(["sat"])).toEqual(Option.none())
	})

	it("holds the duration to 5 minutes through 7 days, in whole minutes", () => {
		expect(durationError("120")).toEqual(Option.none())
		expect(durationError("10080")).toEqual(Option.none())
		expect(Option.isSome(durationError("4"))).toBe(true)
		expect(Option.isSome(durationError("10081"))).toBe(true)
		expect(Option.isSome(durationError("1.5"))).toBe(true)
		expect(Option.isSome(durationError("two hours"))).toBe(true)
	})

	it("refuses to save without days and shows every error instead", () => {
		const model = run(opened(), [
			Message.ChangedName({ value: "Nightly backup" }),
			Message.ChangedMatcher({ field: "services", value: "checkout" }),
			Message.ChangedDuration({ value: "3" }),
		])
		const { step, commands } = saveArgs(model)
		expect(commands).toEqual([])
		expect(step.model.isShowingErrors).toBe(true)
		expect(formErrors(step.model)).toEqual(["Pick at least one day", "Enter 5 to 10080 minutes (7 days)"])
	})
})

describe("once validation", () => {
	it("needs the end after the start, within 30 days and ahead of now", () => {
		const at = (startsAt: string, endsAt: string) =>
			endsAtError({ startsAt, endsAt, timeZone: BERLIN, nowMs: NOW, editingId: null })
		expect(at("2026-11-07T22:00", "2026-11-07T21:00")).toEqual(
			Option.some("End the window after it starts"),
		)
		expect(at("2026-11-07T22:00", "2026-12-10T22:00")).toEqual(
			Option.some("A one-off window can last at most 30 days"),
		)
		expect(at("2026-11-01T22:00", "2026-11-02T01:00")).toEqual(Option.some("Pick an end in the future"))
		expect(at("2026-11-07T22:00", "2026-11-08T01:00")).toEqual(Option.none())
	})

	it("saves nothing while the end comes first", () => {
		const model = run(opened(), [
			Message.ChangedName({ value: "Datacenter move" }),
			Message.ChangedMatcher({ field: "tags", value: "infra" }),
			Message.ChangedKind({ kind: "once" }),
			Message.ChangedStartsAt({ value: "2026-11-07T22:00" }),
			Message.ChangedEndsAt({ value: "2026-11-07T20:00" }),
		])
		expect(saveArgs(model).commands).toEqual([])
	})
})

describe("payload", () => {
	it("creates a weekly window with days in week order and the defaults on", () => {
		const model = run(opened(), [
			Message.ReadZones({ browserZone: BERLIN, zones: [BERLIN, "UTC"] }),
			Message.ChangedName({ value: " Nightly backup " }),
			Message.ChangedMatcher({ field: "services", value: "checkout, payments" }),
			Message.ToggledDay({ day: "thu" }),
			Message.ToggledDay({ day: "mon" }),
		])
		const { commands } = saveArgs(model)
		expect(commands).toEqual([
			expect.objectContaining({
				name: "SaveMaintenanceWindow",
				args: {
					openCount: 1,
					editingId: null,
					payload: {
						name: "Nightly backup",
						reason: null,
						matchers: { services: ["checkout", "payments"] },
						schedule: {
							type: "weekly",
							time_zone: BERLIN,
							days: ["mon", "thu"],
							start_time: "02:00",
							duration_minutes: 120,
						},
						exclude_from_baselines: true,
						enabled: true,
					},
				},
			}),
		])
	})

	it("creates a one-off window with its times read in the picked zone", () => {
		const model = run(opened(), [
			Message.ChangedName({ value: "Datacenter move" }),
			Message.ChangedReason({ value: "Rack swap" }),
			Message.ChangedMatcher({ field: "environments", value: "production" }),
			Message.ChangedKind({ kind: "once" }),
			Message.ChangedStartsAt({ value: "2026-11-07T22:00" }),
			Message.ChangedEndsAt({ value: "2026-11-08T01:00" }),
			Message.ToggledExcludeFromBaselines(),
		])
		expect(saveArgs(model).commands[0]).toMatchObject({
			args: {
				payload: {
					reason: "Rack swap",
					schedule: {
						type: "once",
						starts_at: "2026-11-07T21:00:00.000Z",
						ends_at: "2026-11-08T00:00:00.000Z",
					},
					exclude_from_baselines: false,
				},
			},
		})
	})

	it("edits a window in place, keeping its rules, zone and options", () => {
		const editing = openEdit(init("test-window"), weeklyWindow, NOW, "UTC").model
		// The browser's zone does not replace the window's own.
		const model = run(editing, [Message.ReadZones({ browserZone: "UTC", zones: ["UTC"] })])
		expect(saveArgs(model).commands[0]).toMatchObject({
			args: {
				editingId: weeklyWindow.id,
				payload: {
					name: weeklyWindow.name,
					reason: weeklyWindow.reason,
					matchers: weeklyWindow.matchers,
					schedule: weeklyWindow.schedule,
					exclude_from_baselines: true,
					enabled: true,
				},
			},
		})
		const withRule = openEdit(init("test-window"), runningWindow, NOW, "UTC").model
		expect(saveArgs(withRule).commands[0]).toMatchObject({
			args: { payload: { matchers: runningWindow.matchers, schedule: runningWindow.schedule } },
		})
	})

	it("keeps the dialog open with the server's refusal inline", () => {
		const model = run(opened(), [
			Message.ChangedName({ value: "Nightly backup" }),
			Message.ChangedMatcher({ field: "services", value: "checkout" }),
			Message.ToggledDay({ day: "sat" }),
		])
		const saving = saveArgs(model).step.model
		const failure: LoadFailure = {
			_tag: "@maple/http/errors/AlertValidationError",
			type: "invalid_request_error",
			code: "invalid_request",
			title: "Invalid request",
			message: "Unknown rule in matchers.",
			retryable: false,
			recovery: "fix_request",
		}
		const failed = update(saving, Message.CompletedSave({ openCount: 1, result: Result.fail(failure) }))
		expect(failed.model.saveError).toBe("Unknown rule in matchers.")
		expect(failed.model.isSaving).toBe(false)
		expect(failed.model.dialog.isOpen).toBe(true)
	})
})
