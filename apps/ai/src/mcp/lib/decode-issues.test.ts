import { describe, expect, it } from "vitest"
import { Exit, Schema, Array as Arr, Record as Rec } from "effect"
import { toInputSchema } from "../tools/registry"
import { argumentWarnings, formatDecodeFailure, normalizeArguments, suggestParameter } from "./decode-issues"
import * as P from "./params"

const failureFor = (tool: string, schema: Schema.Codec<unknown, unknown, never, unknown>, input: unknown) => {
	const published = toInputSchema(schema)
	const properties = Rec.keys((published.properties ?? {}) as object)
	const normalized = normalizeArguments(input, properties)
	const exit = Schema.decodeUnknownExit(schema)(normalized.args)
	if (!Exit.isFailure(exit)) throw new Error("expected a decode failure")
	const error = Arr.flatMap(exit.cause.reasons, (reason) =>
		reason._tag === "Fail" ? [reason.error] : [],
	)[0]
	if (!Schema.isSchemaError(error)) throw new Error("expected a SchemaError")
	return formatDecodeFailure(tool, error, published, normalized)
}

// The shapes below are the most frequent "Invalid parameters" failures in two weeks of agent calls.
const SandboxGrep = Schema.Struct({
	repository: P.text("Repository as owner/name"),
	ref: P.optionalText("Commit SHA or branch"),
	pattern: P.text("POSIX regular expression to search for"),
	context_lines: P.optionalNumber("Lines of context"),
})

const SandboxExec = Schema.Struct({
	repository: P.text("Repository as owner/name"),
	command: P.text("Program to run, e.g. `git`, `wc`, `find`"),
	args: P.optionalList("Arguments"),
})

describe("decode failure messages", () => {
	it("names a missing required parameter with its type and description", () => {
		const message = failureFor("sandbox_grep", SandboxGrep, {
			repository: "acme/api",
			ref: "main",
			context_lines: 2,
		})
		expect(message).toContain("Invalid parameters for `sandbox_grep`:")
		expect(message).toContain(
			"Missing required `pattern` (string): POSIX regular expression to search for",
		)
		expect(message).toContain(
			"Parameters: repository (required), ref, pattern (required), context_lines.",
		)
	})

	it("points an unknown key at the parameter it most plausibly meant", () => {
		const message = failureFor("sandbox_exec", SandboxExec, {
			repository: "acme/api",
			cmd: "git",
			args: "log",
		})
		expect(message).toContain("Missing required `command`")
		expect(message).toContain("`cmd` is not a parameter of this tool. Did you mean `command`?")
	})

	it("reports a bad value against its parameter", () => {
		const message = failureFor("sandbox_grep", SandboxGrep, {
			repository: "acme/api",
			pattern: "x",
			context_lines: "many",
		})
		expect(message).toContain("`context_lines`")
		expect(message).not.toContain("Missing required")
	})
})

describe("argument normalization", () => {
	it("rewrites a retired name to the current one and keeps the current one when both are sent", () => {
		expect(normalizeArguments({ service_name: "api" }, ["service"], P.SERVICE_ALIASES)).toEqual({
			args: { service: "api" },
			renamed: [["service_name", "service"]],
			unknown: [],
		})
		expect(
			normalizeArguments({ service_name: "old", service: "new" }, ["service"], P.SERVICE_ALIASES).args,
		).toEqual({ service: "new" })
	})

	it("drops unknown keys and reports them", () => {
		const normalized = normalizeArguments({ servce: "api", limit: 5 }, ["service", "limit"])
		expect(normalized.args).toEqual({ limit: 5 })
		expect(normalized.unknown).toEqual([{ key: "servce", suggestions: ["service"] }])
	})

	it("points a key that names a whole window at both bounds", () => {
		const known = ["service", "start_time", "end_time", "limit"]
		const unknown = (key: string) => normalizeArguments({ [key]: "today" }, known).unknown
		expect(unknown("time_range")).toEqual([
			{ key: "time_range", suggestions: ["start_time", "end_time"] },
		])
		expect(unknown("lookback")).toEqual([{ key: "lookback", suggestions: ["start_time", "end_time"] }])
		// One bound stays one bound.
		expect(unknown("start")).toEqual([{ key: "start", suggestions: ["start_time"] }])
		// A closer match that is not a bound wins over the window guess.
		const withDuration = [...known, "min_duration_ms", "max_duration_ms"]
		expect(normalizeArguments({ min_duration: 5 }, withDuration).unknown).toEqual([
			{ key: "min_duration", suggestions: ["min_duration_ms"] },
		])
		// A tool without a window gets no window suggestion.
		expect(normalizeArguments({ time_range: "1h" }, ["service"]).unknown).toEqual([
			{ key: "time_range", suggestions: [] },
		])
	})

	it("warns that the result is for the call without the ignored key", () => {
		const normalized = normalizeArguments({ time_range: "today" }, ["start_time", "end_time"])
		expect(argumentWarnings(normalized, "list_services")).toEqual([
			"`time_range` is not a parameter of `list_services`. It was ignored, and this result is for the call without it. Did you mean `start_time`/`end_time`?",
		])
	})

	it("fixes the case of an enum value when exactly one published value matches", () => {
		const enums = new Map([["severity", ["TRACE", "ERROR"]]])
		expect(normalizeArguments({ severity: "error" }, ["severity"], {}, enums).args).toEqual({
			severity: "ERROR",
		})
		expect(normalizeArguments({ severity: "fatal" }, ["severity"], {}, enums).args).toEqual({
			severity: "fatal",
		})
	})

	it("reads a camelCase or singular/plural spelling as the declared parameter", () => {
		const known = ["issue_id", "to_state", "environments", "workflow_state"]
		const normalized = normalizeArguments(
			{ issueId: "iss_1", toState: "done", environment: ["prod"], workflow_states: "todo" },
			known,
		)
		expect(normalized.args).toEqual({
			issue_id: "iss_1",
			to_state: "done",
			environments: ["prod"],
			workflow_state: "todo",
		})
		expect(normalized.unknown).toEqual([])
		// A published alias still wins over the spelling rules.
		expect(
			normalizeArguments({ workflowState: "done" }, ["to_state"], { workflow_state: "to_state" }).args,
		).toEqual({ to_state: "done" })
	})

	it("reads a relative time_range as the start of a window ending now, and says how", () => {
		const nowMs = Date.parse("2026-08-20T17:04:05Z")
		const known = ["start_time", "end_time", "service"]
		const normalized = normalizeArguments(
			{ time_range: "6h", service: "api" },
			known,
			{},
			new Map(),
			nowMs,
		)
		expect(normalized.args).toEqual({ start_time: "2026-08-20 11:04:05", service: "api" })
		expect(argumentWarnings(normalized, "error_detail").join()).toContain(
			"start_time=2026-08-20 11:04:05",
		)
		expect(normalizeArguments({ lookback: "last 2 days" }, known, {}, new Map(), nowMs).args).toEqual({
			start_time: "2026-08-18 17:04:05",
		})
		// An explicit start_time wins, and a value that is not a duration stays an unknown key.
		expect(
			normalizeArguments(
				{ time_range: "6h", start_time: "2026-08-20 16:00:00" },
				known,
				{},
				new Map(),
				nowMs,
			).args,
		).toEqual({ start_time: "2026-08-20 16:00:00" })
		expect(normalizeArguments({ time_range: "today" }, known, {}, new Map(), nowMs).unknown).toHaveLength(
			1,
		)
		// With an end_time the lookback ends there, not at now.
		expect(
			normalizeArguments(
				{ time_range: "2h", end_time: "2026-08-20 12:00:00" },
				known,
				{},
				new Map(),
				nowMs,
			).args,
		).toEqual({ start_time: "2026-08-20 10:00:00", end_time: "2026-08-20 12:00:00" })
	})

	it("does not read a duration or a non-window key as a lookback", () => {
		const nowMs = Date.parse("2026-08-20T17:04:05Z")
		const known = ["start_time", "end_time", "min_duration_ms", "window_minutes"]
		for (const key of ["min_duration", "window", "duration"]) {
			const normalized = normalizeArguments({ [key]: "5m" }, known, {}, new Map(), nowMs)
			expect(normalized.args).toEqual({})
			expect(normalized.unknown.map((entry) => entry.key)).toEqual([key])
		}
	})

	it("reads a lookback after aliases: an explicit start wins and the resolved end_time anchors it", () => {
		const nowMs = Date.parse("2026-08-20T17:04:05Z")
		const known = ["start_time", "end_time"]
		const aliases = { since: "start_time", from: "start_time" }
		expect(
			normalizeArguments(
				{ timeRange: "6h", endTime: "2026-08-20 12:00:00" },
				known,
				aliases,
				new Map(),
				nowMs,
			).args,
		).toEqual({ start_time: "2026-08-20 06:00:00", end_time: "2026-08-20 12:00:00" })
		expect(
			normalizeArguments(
				{ time_range: "6h", from: "2026-08-20 16:00:00" },
				known,
				aliases,
				new Map(),
				nowMs,
			).args,
		).toEqual({ start_time: "2026-08-20 16:00:00" })
		// A duration under an aliased key is a lookback; a timestamp under it is the alias.
		expect(normalizeArguments({ since: "24h" }, known, aliases, new Map(), nowMs).args).toEqual({
			start_time: "2026-08-19 17:04:05",
		})
		expect(
			normalizeArguments({ since: "2026-08-20 10:00:00" }, known, aliases, new Map(), nowMs).args,
		).toEqual({
			start_time: "2026-08-20 10:00:00",
		})
	})

	it("ignores a zero or absurd lookback instead of failing the call", () => {
		const nowMs = Date.parse("2026-08-20T17:04:05Z")
		for (const value of ["0h", "99999999999w", "5000d"]) {
			const normalized = normalizeArguments({ time_range: value }, ["start_time"], {}, new Map(), nowMs)
			expect(normalized.args).toEqual({})
			expect(normalized.unknown.map((entry) => entry.key)).toEqual(["time_range"])
		}
	})

	it("does not map a list onto a parameter that takes one value", () => {
		const normalized = normalizeArguments({ services: ["api", "web"] }, ["service"])
		expect(normalized.args).toEqual({})
		expect(normalized.unknown.map((entry) => entry.key)).toEqual(["services"])
		expect(
			normalizeArguments({ services: "api,web" }, ["service"]).unknown.map((entry) => entry.key),
		).toEqual(["services"])
		expect(normalizeArguments({ services: "api" }, ["service"]).args).toEqual({ service: "api" })
	})

	it("suggests nothing for a key unlike any parameter", () => {
		expect(suggestParameter("banana", ["service", "limit"])).toBeUndefined()
		expect(suggestParameter("start", ["start_time", "end_time"])).toBe("start_time")
	})
})
