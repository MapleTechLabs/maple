import { Exit, Option, Record as Rec, Result, Schema, String as Str, Array as Arr } from "effect"
import { describe, expect, it } from "vitest"
import {
	appendRecentCheck,
	applyUptimeCheck,
	describeCertificateExpiry,
	extractVariables,
	filledUrlKeepsHost,
	interpolate,
	interpolateWithin,
	multiStepConfigProblem,
	stepUrlHost,
	StoredUptimeMonitorConfig,
	UPTIME_MAX_ASSERTIONS,
	UPTIME_MAX_BODY_LENGTH,
	UPTIME_MAX_ERROR_LENGTH,
	UPTIME_MAX_EXTRACTIONS,
	UPTIME_MAX_HEADER_NAME_LENGTH,
	UPTIME_MAX_HEADER_VALUE_LENGTH,
	UPTIME_MAX_HEADERS,
	UPTIME_MAX_STEP_NAME_LENGTH,
	UPTIME_MAX_URL_LENGTH,
	UPTIME_MAX_VARIABLE_LENGTH,
	UptimeMonitorConfig,
	UptimeMultiStepConfig,
	describeStaleProbe,
	effectiveAssertions,
	firstFailedAssertion,
	isCertificateExpiring,
	isMapleService,
	readJsonPath,
	UPTIME_RECENT_LIMIT,
	UptimeAssertion,
	type UptimeHttpObservation,
	uptimeHttpRequest,
} from "./uptime"

const repeat = (text: string, count: number) => Str.repeat(count)(text)

const observed = (overrides: Partial<UptimeHttpObservation> = {}): UptimeHttpObservation => ({
	statusCode: 200,
	durationMs: 96,
	headers: { "content-type": "application/json" },
	body: '{"status":"ok","checks":[{"name":"db","status":"ok"}]}',
	...overrides,
})

describe("firstFailedAssertion", () => {
	it("passes a healthy response", () => {
		expect(
			firstFailedAssertion(
				[
					{ _tag: "status", op: "is", value: "2xx" },
					{ _tag: "latency", underMs: 2000 },
					{ _tag: "body", op: "contains", value: '"status":"ok"' },
					{ _tag: "json_path", path: "checks[0].status", op: "equals", value: "ok" },
					{ _tag: "header", name: "Content-Type", op: "contains", value: "json" },
				],
				observed(),
			),
		).toBeNull()
	})

	it("reports the first failure as one sentence", () => {
		expect(
			firstFailedAssertion(
				[
					{ _tag: "status", op: "is", value: "2xx" },
					{ _tag: "latency", underMs: 50 },
				],
				observed({ statusCode: 503 }),
			),
		).toBe("Status 503, expected 2xx")
	})

	it("matches exact status codes and negations", () => {
		expect(
			firstFailedAssertion([{ _tag: "status", op: "is", value: "204" }], observed({ statusCode: 204 })),
		).toBeNull()
		expect(
			firstFailedAssertion(
				[{ _tag: "status", op: "is_not", value: "5xx" }],
				observed({ statusCode: 502 }),
			),
		).toBe("Status 502, expected not 5xx")
	})

	it("fails latency at the threshold", () => {
		expect(firstFailedAssertion([{ _tag: "latency", underMs: 96 }], observed())).toBe(
			"Responded in 96 ms, expected under 96 ms",
		)
	})

	it("fails json_path on a non-JSON body", () => {
		expect(
			firstFailedAssertion(
				[{ _tag: "json_path", path: "status", op: "exists" }],
				observed({ body: "<html>" }),
			),
		).toBe("JSON path status not found")
	})

	it("quotes only the start of a long value the target sent, and keeps the sentence bounded", () => {
		const secret = `${repeat("a", 100)}-tail-the-target-sent`
		const header = firstFailedAssertion(
			[{ _tag: "header", name: "X-Token", op: "equals", value: "expected" }],
			observed({ headers: { "x-token": secret } }),
		)
		expect(header).toBe(`Header X-Token is "${repeat("a", 100)}...", expected equals "expected"`)
		const json = firstFailedAssertion(
			[{ _tag: "json_path", path: "token", op: "equals", value: "expected" }],
			observed({ body: JSON.stringify({ token: secret }) }),
		)
		expect(json).toBe(`JSON path token is ${repeat("a", 100)}..., expected expected`)
		// A long configured value cannot stretch the sentence past what a report keeps.
		const long = firstFailedAssertion(
			[{ _tag: "body", op: "contains", value: repeat("x", UPTIME_MAX_ERROR_LENGTH * 2) }],
			observed(),
		)
		expect(long).toHaveLength(UPTIME_MAX_ERROR_LENGTH)
		expect(Str.endsWith("...")(long ?? "")).toBe(true)
	})

	it("treats a missing header as a failure", () => {
		expect(firstFailedAssertion([{ _tag: "header", name: "x-version", op: "exists" }], observed())).toBe(
			"Header x-version missing",
		)
	})
})

describe("readJsonPath", () => {
	it("walks objects and array indexes", () => {
		expect(readJsonPath({ a: [{ b: 3 }] }, "a[0].b")).toEqual(Option.some(3))
		expect(readJsonPath({ a: [] }, "a[2]")).toEqual(Option.none())
	})

	it("accepts JSONPath-style paths with a leading $", () => {
		const json = { status: "ok", checks: [{ status: "pass" }] }
		expect(readJsonPath(json, "$.status")).toEqual(Option.some("ok"))
		expect(readJsonPath(json, "status")).toEqual(Option.some("ok"))
		expect(readJsonPath(json, "$.checks[0].status")).toEqual(Option.some("pass"))
		expect(readJsonPath(json, "$.missing")).toEqual(Option.none())
	})

	it("reads a present JSON null as a value, not as missing", () => {
		expect(readJsonPath({ status: null }, "status")).toEqual(Option.some(null))
		expect(readJsonPath({ a: [null] }, "a[0]")).toEqual(Option.some(null))
		expect(readJsonPath({ a: [null] }, "a[1]")).toEqual(Option.none())
		const body = (text: string) => observed({ body: text })
		expect(
			firstFailedAssertion(
				[{ _tag: "json_path", path: "status", op: "exists" }],
				body('{"status":null}'),
			),
		).toBeNull()
		expect(
			firstFailedAssertion(
				[{ _tag: "json_path", path: "status", op: "equals", value: "null" }],
				body('{"status":null}'),
			),
		).toBeNull()
	})
})

describe("UptimeAssertion", () => {
	const decode = Schema.decodeUnknownExit(UptimeAssertion)

	it("requires a value for equals and contains, and none for exists", () => {
		expect(Exit.isFailure(decode({ _tag: "json_path", path: "status", op: "equals" }))).toBe(true)
		expect(Exit.isFailure(decode({ _tag: "header", name: "x-env", op: "equals" }))).toBe(true)
		expect(Exit.isFailure(decode({ _tag: "header", name: "x-env", op: "contains", value: "" }))).toBe(
			true,
		)
		expect(decode({ _tag: "header", name: "x-env", op: "exists" })).toEqual(
			Exit.succeed({ _tag: "header", name: "x-env", op: "exists" }),
		)
	})
})

describe("applyUptimeCheck", () => {
	const pending = { status: "pending", consecutiveFailures: 0, consecutiveSuccesses: 0 } as const

	it("goes down only after the configured failures in a row", () => {
		const once = applyUptimeCheck(pending, false, 2)
		expect(once.status).toBe("pending")
		expect(applyUptimeCheck(once, false, 2).status).toBe("down")
	})

	it("recovers on the first success", () => {
		const down = { status: "down", consecutiveFailures: 5, consecutiveSuccesses: 0 } as const
		expect(applyUptimeCheck(down, true, 2)).toEqual({
			status: "up",
			consecutiveFailures: 0,
			consecutiveSuccesses: 1,
		})
	})

	it("leaves a paused monitor alone", () => {
		const paused = { status: "paused", consecutiveFailures: 0, consecutiveSuccesses: 0 } as const
		expect(applyUptimeCheck(paused, false, 1)).toBe(paused)
	})
})

describe("appendRecentCheck", () => {
	it("keeps only the newest checks", () => {
		const full = Array.from({ length: UPTIME_RECENT_LIMIT }, (_, at) => ({ at, ok: true, durationMs: 1 }))
		const next = appendRecentCheck(full, { at: 999, ok: false, durationMs: null })
		expect(next).toHaveLength(UPTIME_RECENT_LIMIT)
		expect(next.at(-1)?.at).toBe(999)
		expect(next[0]?.at).toBe(1)
	})
})

describe("uptimeHttpRequest", () => {
	const config = {
		_tag: "http" as const,
		url: "https://api.example.com/hook",
		method: "POST" as const,
		headers: { "Content-Type": "application/json", "User-Agent": "custom/2" },
		body: '{"ping":true}',
		assertions: [],
		timeoutMs: 5000,
	}

	it("sends the body with the configured content type, and the caller's headers last", () => {
		const request = uptimeHttpRequest(config, { traceparent: "00-a-b-01" })
		expect(request.body).toEqual({ text: '{"ping":true}', contentType: "application/json" })
		expect(request.headers["User-Agent"]).toBe("custom/2")
		expect(request.headers.traceparent).toBe("00-a-b-01")
	})

	it("sends no body for a GET and plain text when no content type is configured", () => {
		expect(uptimeHttpRequest({ ...config, method: "GET" }).body).toBeNull()
		expect(uptimeHttpRequest({ ...config, headers: {} }).body?.contentType).toBe("text/plain")
	})
})

describe("effectiveAssertions", () => {
	it("judges a monitor without a status rule as expecting 2xx", () => {
		expect(firstFailedAssertion(effectiveAssertions([]), observed({ statusCode: 503 }))).toBe(
			"Status 503, expected 2xx",
		)
		const own = [{ _tag: "status" as const, op: "is" as const, value: "503" }]
		expect(firstFailedAssertion(effectiveAssertions(own), observed({ statusCode: 503 }))).toBeNull()
	})
})

describe("isMapleService", () => {
	it("matches the maple-services namespace, and uptime checks recorded before it by name", () => {
		expect(
			Arr.map(
				[
					{ serviceName: "anything", serviceNamespace: "maple-services" },
					{ serviceName: "maple-uptime", serviceNamespace: "" },
					{ serviceName: "checkout-api", serviceNamespace: "" },
					{ serviceName: "checkout-api", serviceNamespace: "payments" },
					// A user's own service that happens to share the name, in its own namespace.
					{ serviceName: "maple-uptime", serviceNamespace: "payments" },
				],
				isMapleService,
			),
		).toEqual([true, true, false, false, false])
	})
})

describe("describeStaleProbe", () => {
	it("names the last check and how long ago it was", () => {
		const now = Date.parse("2026-10-26T14:15:00Z")
		expect(describeStaleProbe(Date.parse("2026-10-26T14:03:20Z"), now)).toBe(
			"No check result since 2026-10-26 14:03 UTC (12 min ago)",
		)
		expect(describeStaleProbe(null, now)).toBe("No check result yet")
	})
})

describe("describeCertificateExpiry", () => {
	const now = Date.UTC(2026, 10, 15, 12)
	const certificate = (days: number, subject = "api.example.com") => ({
		expiresAt: now + days * 86_400_000,
		subject,
		issuer: "R11",
	})

	it("says how long is left, or how long ago it ran out", () => {
		expect([
			describeCertificateExpiry(certificate(9), now),
			describeCertificateExpiry(certificate(1), now),
			describeCertificateExpiry(certificate(0.5), now),
			describeCertificateExpiry(certificate(-2), now),
			describeCertificateExpiry(certificate(9, ""), now),
		]).toEqual([
			"Certificate for api.example.com expires in 9 days (2026-11-24)",
			"Certificate for api.example.com expires in 1 day (2026-11-16)",
			"Certificate for api.example.com expires today (2026-11-16)",
			"Certificate for api.example.com expired 2 days ago (2026-11-13)",
			"Certificate expires in 9 days (2026-11-24)",
		])
	})

	it("is expiring inside the warning window and after expiry, not before", () => {
		expect(Arr.map([15, 13.9, -1], (days) => isCertificateExpiring(certificate(days), now))).toEqual([
			false,
			true,
			true,
		])
	})
})

describe("multi-step checks", () => {
	const decode = Schema.decodeUnknownSync(UptimeMultiStepConfig)
	const step = (name: string, url: string, overrides: Record<string, unknown> = {}) => ({
		name,
		method: "GET",
		url,
		headers: {},
		assertions: [],
		extract: [],
		...overrides,
	})

	it("fills each {{name}} and names the first one without a value", () => {
		expect(interpolate("https://a.dev/{{ id }}?r={{region}}", { id: "42", region: "eu" })).toEqual(
			Result.succeed("https://a.dev/42?r=eu"),
		)
		expect(interpolate("Bearer {{token}}", {})).toEqual(Result.fail("token"))
		// A `$` in a value is sent as is, never read as a replacement pattern.
		expect(interpolate("{{a}}/{{a}}", { a: "p$&q$1" })).toEqual(Result.succeed("p$&q$1/p$&q$1"))
		// A value that looks like a reference is sent as is, not filled in again.
		expect(interpolate("{{a}}/{{b}}", { a: "{{b}}", b: "42" })).toEqual(Result.succeed("{{b}}/42"))
	})

	it("refuses a variable no earlier step sets, a body on GET, a variable or step name used twice", () => {
		const problems = Arr.map(
			[
				[step("A", "https://a.dev/{{x}}")],
				[step("A", "https://a.dev", { body: "{}" })],
				[
					step("A", "https://a.dev", {
						extract: [{ name: "x", from: { _tag: "header", name: "X" } }],
					}),
					step("B", "https://a.dev", {
						extract: [{ name: "x", from: { _tag: "header", name: "Y" } }],
					}),
				],
				[
					step("A", "https://a.dev", {
						extract: [{ name: "x", from: { _tag: "header", name: "X" } }],
					}),
					step("B", "https://a.dev/{{x}}"),
				],
				[step("A", "https://a.dev/one"), step("A", "https://a.dev/two")],
				[
					step("A", "https://a.dev", {
						extract: [
							{ name: "x", from: { _tag: "header", name: "X-One" } },
							{ name: "x", from: { _tag: "header", name: "X-Two" } },
						],
					}),
				],
				[
					step("A", "https://a.dev", {
						extract: [{ name: "x", from: { _tag: "header", name: "X" } }],
					}),
					step("B", "https://a.dev", { headers: { "User-Agent": "probe {{x}}" } }),
				],
			],
			(steps) => multiStepConfigProblem(decode({ _tag: "multistep", timeoutMs: 30_000, steps })),
		)
		expect(problems).toEqual([
			"Step 1 (A) uses {{x}}, which no earlier step extracts",
			"Step 1 (A): a request body needs POST, PUT, PATCH or DELETE",
			"Step 2 (B) extracts x, which an earlier step already set",
			null,
			"Step 2 (A): another step already has this name",
			"Step 1 (A) extracts x twice",
			"Step 2 (B): the User-Agent header can't use a variable",
		])
	})

	it("reads extractions from JSON and headers, and says which one is missing", () => {
		const response = observed({
			headers: { "x-region": "eu" },
			body: '{"session":{"token":"t-1","ttl":60}}',
		})
		expect(
			extractVariables(
				[
					{ name: "token", from: { _tag: "json_path", path: "session.token" } },
					{ name: "ttl", from: { _tag: "json_path", path: "session.ttl" } },
					{ name: "region", from: { _tag: "header", name: "X-Region" } },
				],
				response,
			),
		).toEqual(Result.succeed({ token: "t-1", ttl: "60", region: "eu" }))
		expect(
			extractVariables([{ name: "user", from: { _tag: "json_path", path: "session.user" } }], response),
		).toEqual(Result.fail("JSON path session.user not found, so user could not be set"))
	})
})

describe("request size limits", () => {
	const decode = Schema.decodeUnknownExit(UptimeMonitorConfig)
	const decodeStored = Schema.decodeUnknownExit(StoredUptimeMonitorConfig)
	const http = (overrides: Record<string, unknown>) => ({
		_tag: "http",
		url: "https://api.example.com/health",
		method: "POST",
		headers: {},
		assertions: [],
		timeoutMs: 10_000,
		...overrides,
	})
	const multistep = (overrides: Record<string, unknown>) => ({
		_tag: "multistep",
		timeoutMs: 30_000,
		steps: [
			{
				name: "Log in",
				method: "POST",
				url: "https://api.example.com/login",
				headers: {},
				assertions: [],
				extract: [],
				...overrides,
			},
		],
	})
	const status = { _tag: "status", op: "is", value: "2xx" }
	const manyHeaders = (count: number) =>
		Rec.fromEntries(Arr.makeBy(count, (index): [string, string] => [`x-header-${index}`, "v"]))
	const oversized: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
		["a body past the limit", { body: repeat("b", UPTIME_MAX_BODY_LENGTH + 1) }],
		["a URL past the limit", { url: `https://api.example.com/${repeat("p", UPTIME_MAX_URL_LENGTH)}` }],
		["too many headers", { headers: manyHeaders(UPTIME_MAX_HEADERS + 1) }],
		[
			"a header name past the limit",
			{ headers: { [repeat("n", UPTIME_MAX_HEADER_NAME_LENGTH + 1)]: "v" } },
		],
		[
			"a header value past the limit",
			{ headers: { "x-token": repeat("v", UPTIME_MAX_HEADER_VALUE_LENGTH + 1) } },
		],
		[
			"too many assertions",
			{ assertions: Array.from({ length: UPTIME_MAX_ASSERTIONS + 1 }, () => status) },
		],
	]

	it.each(oversized)("refuses %s on an HTTP check and on a step", (_label, overrides) => {
		expect(Exit.isFailure(decode(http(overrides)))).toBe(true)
		expect(Exit.isFailure(decode(multistep(overrides)))).toBe(true)
	})

	it("refuses a step name past the limit and too many extractions", () => {
		expect(
			Exit.isFailure(decode(multistep({ name: repeat("n", UPTIME_MAX_STEP_NAME_LENGTH + 1) }))),
		).toBe(true)
		const extract = Array.from({ length: UPTIME_MAX_EXTRACTIONS + 1 }, (_, index) => ({
			name: `v${index}`,
			from: { _tag: "header", name: "X" },
		}))
		expect(Exit.isFailure(decode(multistep({ extract })))).toBe(true)
	})

	it("accepts a request exactly at every limit", () => {
		const atLimit = {
			body: repeat("b", UPTIME_MAX_BODY_LENGTH),
			url: `https://a.dev/${repeat("p", UPTIME_MAX_URL_LENGTH - "https://a.dev/".length)}`,
			headers: {
				...manyHeaders(UPTIME_MAX_HEADERS - 1),
				[repeat("n", UPTIME_MAX_HEADER_NAME_LENGTH)]: repeat("v", UPTIME_MAX_HEADER_VALUE_LENGTH),
			},
			assertions: Array.from({ length: UPTIME_MAX_ASSERTIONS }, () => status),
		}
		expect(Exit.isSuccess(decode(http(atLimit)))).toBe(true)
		expect(
			Exit.isSuccess(decode(multistep({ ...atLimit, name: repeat("n", UPTIME_MAX_STEP_NAME_LENGTH) }))),
		).toBe(true)
	})

	it.each(oversized)("still reads a stored row with %s", (_label, overrides) => {
		expect(Exit.isSuccess(decodeStored(http(overrides)))).toBe(true)
		expect(Exit.isSuccess(decodeStored(multistep(overrides)))).toBe(true)
	})
})

describe("filling a template within a length", () => {
	it("fills a template that fits and names a variable without a value", () => {
		expect(interpolateWithin("/orders/{{id}}", { id: "42" }, 20)).toEqual(Result.succeed("/orders/42"))
		expect(interpolateWithin("/orders/{{id}}", {}, 20)).toEqual(
			Result.fail({ _tag: "missing", name: "id" }),
		)
	})

	it("refuses a result past the length, counting each use of a variable", () => {
		expect(interpolateWithin("{{a}}", { a: repeat("x", 11) }, 10)).toEqual(
			Result.fail({ _tag: "too_long" }),
		)
		expect(interpolateWithin("{{a}}{{a}}", { a: repeat("x", 6) }, 10)).toEqual(
			Result.fail({ _tag: "too_long" }),
		)
		expect(interpolateWithin("{{a}}{{a}}", { a: repeat("x", 5) }, 10)).toEqual(
			Result.succeed(repeat("x", 10)),
		)
	})

	it("refuses an extracted value longer than a variable holds, without quoting it", () => {
		const long = repeat("t", UPTIME_MAX_VARIABLE_LENGTH + 1)
		const extracted = extractVariables(
			[{ name: "token", from: { _tag: "header", name: "X-Token" } }],
			observed({ headers: { "x-token": long } }),
		)
		expect(Result.isFailure(extracted)).toBe(true)
		expect(Result.isFailure(extracted) ? extracted.failure : "").toMatch(/^token is longer than/u)
		expect(
			extractVariables(
				[{ name: "token", from: { _tag: "header", name: "X-Token" } }],
				observed({ headers: { "x-token": repeat("t", UPTIME_MAX_VARIABLE_LENGTH) } }),
			),
		).toEqual(Result.succeed({ token: repeat("t", UPTIME_MAX_VARIABLE_LENGTH) }))
	})
})

describe("who chooses a step URL's host", () => {
	it("reads a literal host, a host that is one variable, and a variable touching the host", () => {
		expect(stepUrlHost("https://api.example.com/orders/{{id}}")).toEqual({
			_tag: "literal",
			origin: "https://api.example.com",
		})
		expect(stepUrlHost("https://api.example.com?cursor={{next}}")).toEqual({
			_tag: "literal",
			origin: "https://api.example.com",
		})
		expect(stepUrlHost("https://{{host}}/orders")).toEqual({ _tag: "variable" })
		expect(stepUrlHost("https://{{host}}:8443/orders")).toEqual({ _tag: "variable" })
		expect(stepUrlHost("{{next_url}}")).toEqual({ _tag: "variable" })
		expect(stepUrlHost("https://api.example.com{{next}}")).toEqual({
			_tag: "mixed",
			origin: "https://api.example.com",
		})
		expect(stepUrlHost("https://{{tenant}}.example.com/")._tag).toBe("mixed")
		expect(stepUrlHost("https://user:{{password}}@api.example.com/")._tag).toBe("mixed")
		expect(stepUrlHost("https:{{rest}}")._tag).toBe("mixed")
	})

	it("refuses to save a template whose host a variable could extend", () => {
		const decode = Schema.decodeUnknownSync(UptimeMultiStepConfig)
		const config = (url: string) =>
			decode({
				_tag: "multistep",
				timeoutMs: 30_000,
				steps: [
					{
						name: "First",
						method: "GET",
						url: "https://api.example.com/start",
						headers: {},
						assertions: [],
						extract: [
							{ name: "next", from: { _tag: "json_path", path: "next" } },
							{ name: "host", from: { _tag: "json_path", path: "host" } },
						],
					},
					{ name: "Second", method: "GET", url, headers: {}, assertions: [], extract: [] },
				],
			})
		expect(multiStepConfigProblem(config("https://api.example.com{{next}}"))).toMatch(
			/^Step 2 \(Second\): a variable can't be part of the URL's host/u,
		)
		expect(multiStepConfigProblem(config("https://{{host}}.example.com/x"))).toMatch(
			/a variable can't be part of the URL's host/u,
		)
		expect(multiStepConfigProblem(config("https:///{{next}}"))).toMatch(/needs a valid http\(s\) host/u)
		expect(multiStepConfigProblem(config("https://api.example.com/{{next}}"))).toBeNull()
		expect(multiStepConfigProblem(config("https://api.example.com?page={{next}}"))).toBeNull()
		expect(multiStepConfigProblem(config("https://{{host}}/x"))).toBeNull()
		expect(multiStepConfigProblem(config("{{next}}"))).toBeNull()
	})

	it("holds a filled URL to the origin its template names", () => {
		const template = "https://api.example.com/orders/{{id}}"
		expect(filledUrlKeepsHost(template, "https://api.example.com/orders/42")).toBe(true)
		expect(filledUrlKeepsHost(template, "https://api.example.com/orders/..%2f@evil.test/")).toBe(true)
		expect(filledUrlKeepsHost(template, "https://evil.test/orders/42")).toBe(false)
		expect(filledUrlKeepsHost(template, "http://api.example.com/orders/42")).toBe(false)
		// A template saved before the save-time rule runs only while its value leaves the host alone.
		const legacy = "https://api.example.com{{path}}"
		expect(filledUrlKeepsHost(legacy, "https://api.example.com/orders/42")).toBe(true)
		expect(filledUrlKeepsHost(legacy, "https://api.example.com.evil.test/")).toBe(false)
		expect(filledUrlKeepsHost(legacy, "https://api.example.com@evil.test/")).toBe(false)
		// A host that is one variable was chosen as one: nothing to compare it to.
		expect(filledUrlKeepsHost("https://{{host}}/x", "https://other.example.com/x")).toBe(true)
	})
})
