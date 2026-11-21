import { describe, expect, it } from "vitest"
import { answerMentions, call, calls, grade, never, noTools, observeCall } from "./targets"

describe("eval targets", () => {
	it("scores what a call means: a retired alias reads as the current parameter", () => {
		const observed = [
			observeCall("get_service_top_operations", { service_name: "api", metric: "ERROR_RATE" }, false),
		]
		const result = grade(
			[calls(call("get_service_top_operations", { service: "api", metric: "error_rate" }))],
			observed,
			"",
		)
		expect(result.pass).toBe(true)
		expect(observed[0]?.invalid).toBe(false)
	})

	it("accepts any listed alternative, anywhere in the trajectory", () => {
		const observed = [
			observeCall("list_services", {}, false),
			observeCall(
				"query_data",
				{ source: "traces", kind: "breakdown", group_by: "span_name", service: "api" },
				false,
			),
		]
		const check = calls(
			call("get_service_top_operations", { service: "api" }),
			call("query_data", {
				kind: "breakdown",
				group_by: "span_name",
				service: "api",
				metric: { orDefault: "count" },
			}),
		)
		expect(grade([check], observed, "").pass).toBe(true)
	})

	it("does not let a substring stand in for a different service", () => {
		const observed = [observeCall("find_errors", { service: "subscriptions-api" }, false)]
		expect(grade([calls(call("find_errors", { service: "api" }))], observed, "").pass).toBe(false)
	})

	it("matches free text by substring only when asked to", () => {
		const observed = [observeCall("search_logs", { search: "token publicApiKey expired" }, false)]
		expect(
			grade([calls(call("search_logs", { search: { includes: "publicapikey" } }))], observed, "").pass,
		).toBe(true)
	})

	it("finds a substring in a JSON argument whether it came as text or structured", () => {
		const dropReady = calls(
			call("manage_ingest_rule", {
				action: "create",
				conditions: { includes: "/ready" },
				rule_action: { includes: "drop" },
			}),
		)
		const rule = (route: string, structured: boolean) => {
			const conditions = [{ field: "attribute", key: "http.route", op: "eq", value: route }]
			const action = { type: "drop", keep_percent: 0 }
			return [
				observeCall(
					"manage_ingest_rule",
					{
						action: "create",
						name: "Drop probes",
						signals: ["traces"],
						conditions: structured ? conditions : JSON.stringify(conditions),
						rule_action: structured ? action : JSON.stringify(action),
					},
					false,
				),
			]
		}
		expect(grade([dropReady], rule("/ready", false), "").pass).toBe(true)
		expect(grade([dropReady], rule("/ready", true), "").pass).toBe(true)
		expect(grade([dropReady], rule("/health", true), "").pass).toBe(false)
	})

	it("reads a family call's action as an argument a target can name", () => {
		const ended = [observeCall("manage_alert_silence", { action: "END", silence_id: "s1" }, false)]
		expect(grade([calls(call("manage_alert_silence", { action: "end" }))], ended, "").pass).toBe(true)
		expect(grade([calls(call("manage_alert_silence", { action: "create" }))], ended, "").pass).toBe(false)
		// With no action the call resolves to none, so no action target matches it.
		const bare = [observeCall("manage_alert_silence", { silence_id: "s1" }, false)]
		expect(grade([calls(call("manage_alert_silence", { action: "end" }))], bare, "").pass).toBe(false)
		expect(bare[0]?.invalid).toBe(true)
	})

	it("flags unknown tools and unknown keys as invalid calls", () => {
		expect(observeCall("not_a_tool", {}, false).invalid).toBe(true)
		expect(observeCall("find_errors", { servce: "api" }, false).invalid).toBe(true)
	})

	it("grades negative cases: no tools, forbidden tools, and the answer", () => {
		expect(grade([noTools], [], "A span is one operation.").pass).toBe(true)
		expect(grade([noTools], [observeCall("list_services", {}, false)], "").pass).toBe(false)
		const claimed = [observeCall("claim_error_issue", { issue_id: "x" }, false)]
		expect(grade([never("claim_error_issue")], claimed, "").pass).toBe(false)
		expect(
			grade([answerMentions("db.query", "connection reset")], [], "A Connection Reset in db").pass,
		).toBe(true)
	})

	it("gives partial credit in the score, never in pass", () => {
		const result = grade([noTools, answerMentions("x")], [], "nothing")
		expect(result.pass).toBe(false)
		expect(result.score).toBe(0.5)
		expect(result.explanation).toContain("calls: no calls")
	})
})
