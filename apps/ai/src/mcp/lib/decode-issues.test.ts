import { describe, expect, it } from "vitest"
import { Exit, Schema } from "effect"
import { toInputSchema } from "../tools/registry"
import { formatDecodeFailure, normalizeArguments, suggestParameter } from "./decode-issues"
import * as P from "./params"

const failureFor = (tool: string, schema: Schema.Codec<unknown, unknown, never, unknown>, input: unknown) => {
	const published = toInputSchema(schema)
	const properties = Object.keys((published.properties ?? {}) as object)
	const normalized = normalizeArguments(input, properties)
	const exit = Schema.decodeUnknownExit(schema)(normalized.args)
	if (!Exit.isFailure(exit)) throw new Error("expected a decode failure")
	const error = exit.cause.reasons.flatMap((reason) => (reason._tag === "Fail" ? [reason.error] : []))[0]
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
		expect(normalized.unknown).toEqual([{ key: "servce", suggestion: "service" }])
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

	it("suggests nothing for a key unlike any parameter", () => {
		expect(suggestParameter("banana", ["service", "limit"])).toBeUndefined()
		expect(suggestParameter("start", ["start_time", "end_time"])).toBe("start_time")
	})
})
