import { describe, expect, test } from "bun:test"
import { Array as Arr, Option, Result } from "effect"
import {
	buildBody,
	errorMessageOf,
	parseField,
	parseHeader,
	resolveApiPath,
	withQuery,
	type Field,
} from "./api-request"
import { ApiResponseError } from "../commands/api"
import { describeFailure } from "../lib/failure"

const fields = (...raw: ReadonlyArray<string>): ReadonlyArray<Field> =>
	Arr.map(raw, (r) => {
		const parsed = parseField(r)
		if (Result.isFailure(parsed)) throw new Error(parsed.failure.message)
		return parsed.success
	})

const body = (...raw: ReadonlyArray<string>) => {
	const built = buildBody(fields(...raw))
	return Result.isSuccess(built) ? built.success : built.failure.message
}

describe("resolveApiPath", () => {
	test("joins a path onto the workspace origin", () => {
		const url = resolveApiPath("https://api.maple.dev", "/v2/services?limit=5")
		expect(Result.isSuccess(url) && url.success.toString()).toBe(
			"https://api.maple.dev/v2/services?limit=5",
		)
	})

	test("refuses anything that could send the token to another host", () => {
		for (const path of [
			"https://evil.example/v2",
			"//evil.example/v2",
			"v2/services",
			"/\\evil.example",
		]) {
			expect(Result.isFailure(resolveApiPath("https://api.maple.dev", path))).toBe(true)
		}
	})
})

describe("-d fields", () => {
	test("strings, typed JSON values and nested keys build one body", () => {
		expect(
			body("name=checkout", "limit:=10", "enabled:=true", "metadata[team]=core", "ids[]=a", "ids[]=b"),
		).toEqual({
			name: "checkout",
			limit: 10,
			enabled: true,
			metadata: { team: "core" },
			ids: ["a", "b"],
		})
	})

	test("a value may itself contain = signs", () => {
		expect(body("filter=a=b")).toEqual({ filter: "a=b" })
	})

	test("the same key twice is a usage error, not a silent overwrite", () => {
		expect(body("name=a", "name=b")).toContain("conflicts")
		expect(body("meta=a", "meta[x]=b")).toContain("conflicts")
	})

	test("__proto__ is refused and leaves Object.prototype untouched; inherited names are plain keys", () => {
		expect(body("__proto__[team]=core")).toContain("reserved")
		expect(body("__proto__=x")).toContain("reserved")
		expect("team" in {}).toBe(false)
		expect(body("constructor=x", "toString[a]=b")).toEqual({ constructor: "x", toString: { a: "b" } })
	})

	test("malformed fields and bad JSON are refused", () => {
		expect(Result.isFailure(parseField("novalue"))).toBe(true)
		expect(Result.isFailure(parseField("=x"))).toBe(true)
		expect(Result.isFailure(parseField("limit:=ten"))).toBe(true)
	})

	test("GET fields keep their keys verbatim in the query string", () => {
		const url = withQuery(
			new URL("https://api.maple.dev/v2/traces"),
			fields("filter[service]=api", "limit:=5"),
		)
		expect(url.searchParams.get("filter[service]")).toBe("api")
		expect(url.searchParams.get("limit")).toBe("5")
	})
})

describe("-H headers", () => {
	test("parses Name: value and refuses a missing name", () => {
		const header = parseHeader("Idempotency-Key:  abc ")
		expect(Result.isSuccess(header) && header.success).toEqual(["Idempotency-Key", "abc"])
		expect(Result.isFailure(parseHeader("no colon"))).toBe(true)
	})
})

describe("errorMessageOf", () => {
	test("reads the v2 error envelope and plain messages", () => {
		expect(errorMessageOf({ error: { message: "not found" } })).toEqual(Option.some("not found"))
		expect(errorMessageOf({ message: "bad input" })).toEqual(Option.some("bad input"))
		expect(errorMessageOf({})).toEqual(Option.none())
	})
})

describe("a refused raw API request", () => {
	test("a 4xx is the user's request to fix; a 5xx is a real failure", () => {
		const report = (status: number) =>
			describeFailure(new ApiResponseError({ status, message: `GET /v2/x returned HTTP ${status}` }))
		expect(report(404).expected).toBe(true)
		expect(report(404).message).toBe("GET /v2/x returned HTTP 404")
		expect(report(502).expected).toBe(false)
	})
})
