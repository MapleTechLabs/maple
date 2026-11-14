import { describe, expect, it } from "vitest"
import { Option, Schema } from "effect"
import { AlertRuleId, AlertSilenceId } from "@maple/domain/http"
import type { V2AlertSilence } from "@maple/domain/http/v2"
import { activeSilenceFor, formatSilenceRange, formatSilenceTime, matchersForRule } from "./silences"

const ruleId = Schema.decodeSync(AlertRuleId)("11111111-1111-4111-8111-111111111111")
const asSilenceId = Schema.decodeSync(AlertSilenceId)

const NOW = Date.UTC(2026, 10, 6, 12, 0)
const iso = (ms: number) => new Date(ms).toISOString()

const silence = (
	id: string,
	matchers: V2AlertSilence["matchers"],
	startOffsetMin: number,
	endOffsetMin: number,
): V2AlertSilence => ({
	id: asSilenceId(id),
	object: "alert_silence",
	reason: "deploy",
	matchers,
	status: "active",
	starts_at: iso(NOW + startOffsetMin * 60_000),
	ends_at: iso(NOW + endOffsetMin * 60_000),
	maintenance_window_id: null,
	created_by: "user_1",
	created_at: iso(NOW),
	updated_at: iso(NOW),
})

const groupedRule = {
	id: ruleId,
	tags: [],
	serviceNames: [],
	environments: [],
	groupBy: ["service.name"],
	signalType: "error_rate" as const,
	queryBuilderDraft: null,
}

describe("silence times", () => {
	const BERLIN = "Europe/Berlin"

	it("reads on the viewer's clock, and names the day when it is not today there", () => {
		// NOW is 13:00 in Berlin.
		expect(formatSilenceTime(Date.UTC(2026, 10, 6, 14, 0), NOW, BERLIN)).toBe("03:00 PM")
		expect(formatSilenceTime(Date.UTC(2026, 10, 7, 8, 0), NOW, BERLIN)).toBe("Nov 7, 09:00 AM")
		// 23:30 UTC is still today in UTC, and already tomorrow in Berlin.
		const late = Date.UTC(2026, 10, 6, 23, 30)
		expect(formatSilenceTime(late, NOW, "UTC")).toBe("11:30 PM")
		expect(formatSilenceTime(late, NOW, BERLIN)).toBe("Nov 7, 12:30 AM")
	})

	it("reads on a 24h clock when asked, midnight as 00", () => {
		expect(formatSilenceTime(Date.UTC(2026, 10, 6, 14, 30), NOW, BERLIN, "h23")).toBe("15:30")
		expect(formatSilenceTime(Date.UTC(2026, 10, 7, 8, 0), NOW, BERLIN, "h23")).toBe("Nov 7, 09:00")
		expect(formatSilenceTime(Date.UTC(2026, 10, 6, 23, 30), NOW, BERLIN, "h23")).toBe("Nov 7, 00:30")
	})

	it("names the day of a window once when both ends share it", () => {
		const start = Date.UTC(2026, 10, 7, 14, 0)
		expect(formatSilenceRange(start, start + 60 * 60_000, NOW, BERLIN)).toBe(
			"Nov 7, 03:00 PM to 04:00 PM",
		)
		expect(formatSilenceRange(start, start + 24 * 60 * 60_000, NOW, BERLIN)).toBe(
			"Nov 7, 03:00 PM to Nov 8, 03:00 PM",
		)
		expect(formatSilenceRange(NOW + 60 * 60_000, NOW + 2 * 60 * 60_000, NOW, BERLIN)).toBe(
			"02:00 PM to 03:00 PM",
		)
	})
})

describe("activeSilenceFor", () => {
	it("picks the latest-ending silence in force, from the window not the stored status", () => {
		const long = silence("22222222-2222-4222-8222-222222222222", { rule_ids: [ruleId] }, -10, 120)
		const short = silence("33333333-3333-4333-8333-333333333333", { rule_ids: [ruleId] }, -10, 30)
		const ended = silence("44444444-4444-4444-8444-444444444444", { rule_ids: [ruleId] }, -60, -1)
		const scheduled = silence("55555555-5555-4555-8555-555555555555", { rule_ids: [ruleId] }, 5, 10)
		expect(
			Option.map(
				activeSilenceFor([long, ended, scheduled, short], groupedRule, null, NOW),
				(s) => s.id,
			),
		).toEqual(Option.some(long.id))
	})

	it("covers only the silenced group of a rule grouped by service", () => {
		const checkout = silence(
			"66666666-6666-4666-8666-666666666666",
			matchersForRule(groupedRule, "checkout"),
			-1,
			60,
		)
		expect(Option.isSome(activeSilenceFor([checkout], groupedRule, "checkout", NOW))).toBe(true)
		expect(Option.isSome(activeSilenceFor([checkout], groupedRule, "payments", NOW))).toBe(false)
	})
})

describe("matchersForRule", () => {
	const rule = (
		overrides: Partial<{ groupBy: ReadonlyArray<string> | null; serviceNames: ReadonlyArray<string> }>,
	) => ({
		id: ruleId,
		groupBy: null,
		serviceNames: [],
		signalType: "error_rate" as const,
		queryBuilderDraft: null,
		...overrides,
	})

	it("narrows to the incident's group the way the server matches it", () => {
		expect(matchersForRule(rule({ groupBy: ["service.name"] }), "checkout")).toEqual({
			rule_ids: [ruleId],
			services: ["checkout"],
		})
		expect(matchersForRule(rule({ serviceNames: ["checkout", "payments"] }), "payments")).toEqual({
			rule_ids: [ruleId],
			services: ["payments"],
		})
		expect(matchersForRule(rule({ groupBy: ["deployment.environment"] }), "staging")).toEqual({
			rule_ids: [ruleId],
			environments: ["staging"],
		})
		expect(matchersForRule(rule({ groupBy: ["service.name"] }), "__total__")).toEqual({
			rule_ids: [ruleId],
		})
		expect(matchersForRule(rule({ groupBy: ["http.route"] }), "/cart")).toEqual({ rule_ids: [ruleId] })
	})
})
