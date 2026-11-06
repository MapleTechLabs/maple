import { describe, expect, it } from "vitest"
import { AlertSilenceId } from "@maple/domain/http"
import type { V2AlertSilence } from "@maple/domain/http/v2"
import { Option, Result, Schema } from "effect"
import {
	init,
	isFormReady,
	matchersOf,
	Message,
	openNew,
	OutMessage,
	silenceEndMs,
	untilError,
	update,
} from "./dialog"

// 2026-11-06 14:20 in Berlin (UTC+1).
const NOW = Date.UTC(2026, 10, 6, 13, 20)
const BERLIN = "Europe/Berlin"

describe("silenceEndMs", () => {
	it("ends an hour or four hours from now", () => {
		expect(silenceEndMs("1h", "", NOW, BERLIN)).toEqual(Option.some(NOW + 60 * 60_000))
		expect(silenceEndMs("4h", "", NOW, BERLIN)).toEqual(Option.some(NOW + 4 * 60 * 60_000))
	})

	it("ends at the next 09:00 on the viewer's wall clock", () => {
		expect(silenceEndMs("morning", "", NOW, BERLIN)).toEqual(Option.some(Date.UTC(2026, 10, 7, 8, 0)))
		// At 00:30 the next 09:00 is this morning's, and across a month's end it rolls over.
		expect(silenceEndMs("morning", "", Date.UTC(2026, 9, 31, 23, 30), BERLIN)).toEqual(
			Option.some(Date.UTC(2026, 10, 1, 8, 0)),
		)
		// Across the DST change (Berlin falls back on 2026-10-25): 09:00 CET, not CEST.
		expect(silenceEndMs("morning", "", Date.UTC(2026, 9, 24, 20, 0), BERLIN)).toEqual(
			Option.some(Date.UTC(2026, 9, 25, 8, 0)),
		)
	})

	it("reads a custom end in the viewer's zone and refuses one in the past", () => {
		expect(silenceEndMs("custom", "2026-11-06T18:30", NOW, BERLIN)).toEqual(
			Option.some(Date.UTC(2026, 10, 6, 17, 30)),
		)
		expect(silenceEndMs("custom", "2026-11-06T09:00", NOW, BERLIN)).toEqual(Option.none())
		expect(silenceEndMs("custom", "tomorrow", NOW, BERLIN)).toEqual(Option.none())
	})
})

describe("matchersOf", () => {
	it("splits typed lists and drops empty fields", () => {
		expect(
			matchersOf({
				_tag: "Typed",
				services: " checkout, payments ,checkout",
				tags: "",
				environments: "production",
			}),
		).toEqual({ services: ["checkout", "payments"], environments: ["production"] })
	})
})

describe("isFormReady", () => {
	const typed = (services: string) => ({ _tag: "Typed" as const, services, tags: "", environments: "" })

	it("needs a reason and something to match", () => {
		const model = init("silence")
		expect(isFormReady({ ...model, reason: "deploy", scope: typed("") })).toBe(false)
		expect(isFormReady({ ...model, reason: " ", scope: typed("checkout") })).toBe(false)
		expect(isFormReady({ ...model, reason: "deploy", scope: typed("checkout") })).toBe(true)
	})

	it("needs a readable end for a custom duration", () => {
		const model = {
			...init("silence"),
			reason: "deploy",
			scope: typed("checkout"),
			duration: "custom" as const,
			timeZone: BERLIN,
			nowMs: NOW,
		}
		expect(isFormReady({ ...model, until: "" })).toBe(false)
		expect(isFormReady({ ...model, until: "2026-11-07T09:00" })).toBe(true)
		expect(isFormReady({ ...model, until: "2026-11-06T09:00" })).toBe(false)
		expect(untilError({ ...model, until: "2026-11-06T09:00" })).toEqual(
			Option.some("Pick a time in the future"),
		)
		expect(isFormReady({ ...model, until: "2026-12-24T09:00" })).toBe(false)
		expect(untilError({ ...model, until: "2026-12-24T09:00" })).toEqual(
			Option.some("A silence can last at most 30 days"),
		)
	})
})

describe("saving", () => {
	const SILENCE: V2AlertSilence = {
		id: Schema.decodeSync(AlertSilenceId)("22222222-2222-4222-8222-222222222222"),
		object: "alert_silence",
		reason: "deploy",
		matchers: { services: ["checkout"] },
		status: "active",
		starts_at: new Date(NOW).toISOString(),
		ends_at: new Date(NOW + 60 * 60_000).toISOString(),
		created_by: "user_1",
		created_at: new Date(NOW).toISOString(),
		updated_at: new Date(NOW).toISOString(),
	}
	const saving = () => {
		const opened = openNew(init("silence"), BERLIN, NOW).model
		const typed = { ...opened, reason: "deploy", scope: { ...opened.scope, services: "checkout" } }
		return update(typed, Message.ClickedSave()).model
	}

	it("closes the form and reports the new silence", () => {
		const model = saving()
		expect(model.isSaving).toBe(true)
		const saved = update(
			model,
			Message.CompletedSave({ openCount: model.openCount, result: Result.succeed(SILENCE) }),
		)
		expect(saved.model.isSaving).toBe(false)
		expect(saved.model.dialog.isOpen).toBe(false)
		expect(saved.outMessage).toEqual(OutMessage.CreatedSilence({ silence: SILENCE }))
	})

	it("leaves a reopened form alone when an older save lands", () => {
		const model = saving()
		const saved = update(
			model,
			Message.CompletedSave({ openCount: model.openCount - 1, result: Result.succeed(SILENCE) }),
		)
		expect(saved.model.dialog.isOpen).toBe(true)
		expect(saved.model.isSaving).toBe(true)
		expect(saved.outMessage).toEqual(OutMessage.CreatedSilence({ silence: SILENCE }))
	})

	it("leaves a reopened form saving when an older save fails", () => {
		const model = saving()
		const failed = update(
			model,
			Message.CompletedSave({ openCount: model.openCount - 1, result: Result.fail("nope") }),
		)
		expect(failed.model.isSaving).toBe(true)
	})

	it("keeps the form open and toasts the failure", () => {
		const model = saving()
		const failed = update(
			model,
			Message.CompletedSave({ openCount: model.openCount, result: Result.fail("nope") }),
		)
		expect(failed.model.isSaving).toBe(false)
		expect(failed.model.dialog.isOpen).toBe(true)
		expect(failed.outMessage).toEqual(
			OutMessage.RequestedToast({
				type: "error",
				title: "Couldn't silence alerts",
				description: "nope",
			}),
		)
	})
})
