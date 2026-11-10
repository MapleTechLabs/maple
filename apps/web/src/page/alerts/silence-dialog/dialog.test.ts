import { describe, expect, it } from "vitest"
import { AlertSilenceId } from "@maple/domain/http"
import type { V2AlertSilence } from "@maple/domain/http/v2"
import { Option, Result, Schema } from "effect"
import * as Combobox from "@maple/views/ui/combobox"
import {
	endZoneLabel,
	init,
	isFormReady,
	matchersOf,
	Message,
	type Model,
	openFor,
	openNew,
	OutMessage,
	parseLocalDateTime,
	reasonError,
	scopeError,
	type ScopeField,
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

	it("reads a custom end on the viewer's clock on either side of a DST change", () => {
		// Berlin springs forward on 2026-03-29: 09:00 the day before is CET, 09:00 that day is CEST.
		const before = Date.UTC(2026, 2, 28, 12, 0)
		expect(parseLocalDateTime("2026-03-28T09:00", BERLIN)).toEqual(
			Option.some(Date.UTC(2026, 2, 28, 8, 0)),
		)
		expect(parseLocalDateTime("2026-03-29T09:00", BERLIN)).toEqual(
			Option.some(Date.UTC(2026, 2, 29, 7, 0)),
		)
		expect(silenceEndMs("custom", "2026-03-29T09:00", before, BERLIN)).toEqual(
			Option.some(Date.UTC(2026, 2, 29, 7, 0)),
		)
		// New York falls back on 2026-11-01: 12:00 that day is EST, five hours behind UTC.
		expect(parseLocalDateTime("2026-10-31T12:00", "America/New_York")).toEqual(
			Option.some(Date.UTC(2026, 9, 31, 16, 0)),
		)
		expect(parseLocalDateTime("2026-11-01T12:00", "America/New_York")).toEqual(
			Option.some(Date.UTC(2026, 10, 1, 17, 0)),
		)
		// The same wall clock read as UTC is a different instant: the form never assumes UTC.
		expect(parseLocalDateTime("2026-03-29T09:00", "UTC")).toEqual(
			Option.some(Date.UTC(2026, 2, 29, 9, 0)),
		)
	})

	it("names the zone the custom end is in, as it is at that end", () => {
		const model = { timeZone: BERLIN, nowMs: Date.UTC(2026, 2, 28, 12, 0) }
		expect(endZoneLabel({ ...model, until: "" })).toBe("CET")
		expect(endZoneLabel({ ...model, until: "2026-03-28T18:00" })).toBe("CET")
		expect(endZoneLabel({ ...model, until: "2026-03-29T09:00" })).toBe("CEST")
		expect(endZoneLabel({ ...model, timeZone: "UTC", until: "" })).toBe("UTC")
		// A zone ICU has no abbreviation for reads as its offset.
		expect(endZoneLabel({ ...model, timeZone: "Asia/Kolkata", until: "" })).toBe("UTC+5:30")
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
	it("takes the chips of each field and drops the empty ones", () => {
		expect(
			matchersOf({
				_tag: "Typed",
				services: ["checkout", "payments"],
				tags: [],
				environments: ["production"],
			}),
		).toEqual({ services: ["checkout", "payments"], environments: ["production"] })
	})
})

describe("scope chips", () => {
	const pick = (model: Model, field: ScopeField, value: string) =>
		update(
			model,
			Message.GotScopeComboMessage({ field, message: Combobox.Message.ClickedItem({ value }) }),
		).model

	it("picking a suggestion adds a chip, picking it again or removing it takes it off", () => {
		const opened = openNew(init("silence"), BERLIN, NOW).model
		const picked = pick(pick(opened, "services", "checkout"), "environments", "production")
		expect(matchersOf(picked.scope)).toEqual({ services: ["checkout"], environments: ["production"] })
		expect(matchersOf(pick(picked, "services", "checkout").scope)).toEqual({
			environments: ["production"],
		})
		const removed = update(
			picked,
			Message.GotScopeComboMessage({
				field: "environments",
				message: Combobox.Message.RemovedChip({ value: "production" }),
			}),
		).model
		expect(matchersOf(removed.scope)).toEqual({ services: ["checkout"] })
	})

	it("a typed name is picked with Enter, and the next open starts without chips", () => {
		const opened = openNew(init("silence"), BERLIN, NOW).model
		const combo = (message: Combobox.Message) => Message.GotScopeComboMessage({ field: "tags", message })
		const enter = (model: Model, value: string) =>
			update(
				update(model, combo(Combobox.Message.ChangedInput({ value }))).model,
				// The view lists the suggestions, then what is typed when it is none of them.
				combo(Combobox.Message.PressedInputKey({ key: "Enter", items: ["database", value] })),
			).model
		// The first suggestion that matches wins; a name nothing suggests is added as typed.
		const entered = enter(enter(opened, "dat"), "queue")
		expect(matchersOf(entered.scope)).toEqual({ tags: ["database", "queue"] })
		expect(entered.combos.tags.inputValue).toBe("")
		expect(matchersOf(openNew(entered, BERLIN, NOW).model.scope)).toEqual({})
	})

	it("a scope fixed by a rule ignores the chips", () => {
		const fixed = openFor(
			init("silence"),
			{ label: "Rule", matchers: { rule_ids: [] } },
			BERLIN,
			NOW,
		).model
		expect(pick(fixed, "services", "checkout").scope).toEqual(fixed.scope)
	})
})

describe("isFormReady", () => {
	const typed = (service: string) => ({
		_tag: "Typed" as const,
		services: service === "" ? [] : [service],
		tags: [],
		environments: [],
	})

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

	it("a tried save on an incomplete form sends nothing and turns the errors on, an empty custom end included", () => {
		const opened = openNew(init("silence"), BERLIN, NOW).model
		const custom = update(opened, Message.ChangedDuration({ duration: "custom" })).model
		expect(untilError(custom)).toEqual(Option.none())
		const tried = update(custom, Message.ClickedSave())
		expect(tried.commands ?? []).toEqual([])
		expect(tried.model.isSaving).toBe(false)
		expect(tried.model.isShowingErrors).toBe(true)
		expect(untilError(tried.model)).toEqual(Option.some("Pick a date and time"))
		expect(reasonError(tried.model.reason)).toEqual(Option.some("Add a reason"))
		expect(scopeError(tried.model.scope)).toEqual(
			Option.some("Add at least one service, environment or tag"),
		)
		// The next open starts quiet again.
		expect(openNew(tried.model, BERLIN, NOW).model.isShowingErrors).toBe(false)
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
		maintenance_window_id: null,
		created_by: "user_1",
		created_at: new Date(NOW).toISOString(),
		updated_at: new Date(NOW).toISOString(),
	}
	const saving = () => {
		const opened = openNew(init("silence"), BERLIN, NOW).model
		const typed = { ...opened, reason: "deploy", scope: { ...opened.scope, services: ["checkout"] } }
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
