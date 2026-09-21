import { describe, expect, it } from "vitest"
import { INVESTIGATION_PROGRESS_STEPS } from "@maple/domain/http"

import { makeProgressRecorder, PROGRESS_HEARTBEAT_MS, stepLabel } from "./progress"

describe("stepLabel", () => {
	it("reads a verb-first tool name as a phrase, with no map to go stale", () => {
		expect(stepLabel("search_logs", {})).toBe("Search logs")
		expect(stepLabel("compare_periods", {})).toBe("Compare periods")
	})

	it("names the one argument a reader would want", () => {
		expect(stepLabel("inspect_trace", { trace_id: "7f3a9c", start_time: "…" })).toBe(
			"Inspect trace · 7f3a9c",
		)
		expect(stepLabel("diagnose_service", { service_name: "checkout-api" })).toBe(
			"Diagnose service · checkout-api",
		)
	})

	/** A label padded with whichever key came first reads as detail while carrying none. */
	it("says nothing extra when the arguments are only time bounds", () => {
		expect(stepLabel("find_errors", { start_time: "a", end_time: "b", limit: 50 })).toBe("Find errors")
	})

	it("keeps a long argument to one clamped line", () => {
		const label = stepLabel("sandbox_grep", {
			pattern: "a".repeat(80),
		})
		expect(label.length).toBeLessThan(60)
		expect(label.endsWith("…")).toBe(true)
	})

	it("keeps acronyms upper case", () => {
		expect(stepLabel("run_sql", { sql: "SELECT 1" })).toBe("Run SQL · SELECT 1")
	})
})

describe("makeProgressRecorder", () => {
	/** The write that turns "gathering evidence" into a page saying what. */
	it("writes the first step immediately", () => {
		const recorder = makeProgressRecorder()
		const record = recorder.step("search_logs", {}, 1_000)
		expect(record?.stepCount).toBe(1)
		expect(record?.steps.map((step) => step.label)).toEqual(["Search logs"])
	})

	it("swallows steps inside the heartbeat", () => {
		const recorder = makeProgressRecorder()
		recorder.step("search_logs", {}, 1_000)
		expect(recorder.step("find_errors", {}, 1_500)).toBeUndefined()
		expect(recorder.step("inspect_trace", {}, 2_000)).toBeUndefined()
	})

	it("writes again once the heartbeat has elapsed, carrying what it swallowed", () => {
		const recorder = makeProgressRecorder()
		recorder.step("search_logs", {}, 1_000)
		recorder.step("find_errors", {}, 1_500)
		const record = recorder.step("inspect_trace", {}, 1_000 + PROGRESS_HEARTBEAT_MS)
		expect(record?.stepCount).toBe(3)
		expect(record?.steps.map((step) => step.tool)).toEqual([
			"search_logs",
			"find_errors",
			"inspect_trace",
		])
	})

	/**
	 * Without the drain, a run that took four quick steps and stopped reports the
	 * first one forever, which is the shape of a stall rather than a finish.
	 */
	it("hands back the steps the heartbeat swallowed", () => {
		const recorder = makeProgressRecorder()
		recorder.step("search_logs", {}, 1_000)
		recorder.step("find_errors", {}, 1_500)
		expect(recorder.pending()?.stepCount).toBe(2)
	})

	it("has nothing pending once everything is written", () => {
		const recorder = makeProgressRecorder()
		recorder.step("search_logs", {}, 1_000)
		expect(recorder.pending()).toBeUndefined()
	})

	it("keeps the tail bounded, and counts past it", () => {
		const recorder = makeProgressRecorder()
		const total = INVESTIGATION_PROGRESS_STEPS + 5
		for (let index = 0; index < total; index += 1) {
			recorder.step(`tool_${index}`, {}, index * PROGRESS_HEARTBEAT_MS)
		}
		const record = recorder.pending() ?? recorder.step("last_one", {}, 10 ** 9)
		expect(record?.steps.length).toBeLessThanOrEqual(INVESTIGATION_PROGRESS_STEPS)
		expect(record?.stepCount).toBeGreaterThan(INVESTIGATION_PROGRESS_STEPS)
	})

	it("timestamps the record with its newest step, which is what liveness reads", () => {
		const recorder = makeProgressRecorder()
		recorder.step("search_logs", {}, 1_000)
		recorder.step("find_errors", {}, 4_000)
		expect(recorder.pending()?.updatedAt).toBe(4_000)
	})
})
