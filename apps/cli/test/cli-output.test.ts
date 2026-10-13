import { describe, it } from "@effect/vitest"
import { strict as assert } from "node:assert"
import { Cause } from "effect"
import { renderUnexpected } from "../src/core/outcomes"
import { ModeError } from "../src/core/mode"
import { TimeRangeError } from "../src/core/time"
import { CliNotFoundError } from "../src/lib/errors"
import { describeFailure, formatFailure } from "../src/lib/failure"
import { formatParseError } from "../src/lib/help"
import {
	argvFormat,
	autoTable,
	formatByKey,
	formatDuration,
	formatPercent,
	isEmptyResult,
	utcIso,
	utcTimestampReplacer,
} from "../src/lib/output"
import { logsLink, traceLink, uiRangeFor, withLogTraceLinks } from "../src/lib/local-links"
import { errorsView, servicesView } from "../src/lib/views"
import { WarehouseConfigError, WarehouseQueryError } from "@maple/domain/http/warehouse-errors"
import { LocalQueryFailed } from "@maple/query-engine/local"

describe("--format", () => {
	// `--format=table` used to print JSON: only the exact token `--format` was scanned.
	it("reads both spellings, last one wins", () => {
		assert.equal(argvFormat(["services", "--format=table"]), "table")
		assert.equal(argvFormat(["services", "--format", "table"]), "table")
		assert.equal(argvFormat(["--format", "table", "--format=json"]), "json")
		assert.equal(argvFormat(["services"]), undefined)
	})
})

describe("table cells", () => {
	it("rounds and adds units, by key", () => {
		assert.equal(formatByKey("errorRate", 0.007692307692307693), "0.77%")
		assert.equal(formatByKey("p99Ms", 1793.5669759999998), "1.79s")
		assert.equal(formatByKey("p50Ms", 160.178), "160.2ms")
		assert.equal(formatByKey("throughput", 12345), "12,345")
		assert.equal(formatByKey("isMonotonic", true), "yes")
		assert.equal(formatByKey("timestamp", "2026-09-25 23:36:29.481465000"), "2026-09-25 23:36:29Z")
		assert.equal(formatByKey("timestamp", "2026-09-26T01:36:29+02:00"), "2026-09-25 23:36:29Z")
	})

	it("keeps small and large durations readable", () => {
		assert.equal(formatDuration(0.25), "250µs")
		assert.equal(formatDuration(2.4971675), "2.5ms")
		assert.equal(formatDuration(125_000), "2m5s")
		assert.equal(formatPercent(0.15151515), "15.2%")
		assert.equal(formatPercent(0), "0%")
	})

	it("flattens one level of nesting instead of giving up on the table", () => {
		const table = autoTable([{ name: "a", stats: { p50Ms: 12.5 }, tags: ["x", "y"] }])
		assert.match(table, /STATS\.P50/)
		assert.match(table, /12\.5ms/)
		assert.match(table, /x, y/)
	})

	it("treats an empty list, or an object of empty lists, as empty", () => {
		assert.equal(isEmptyResult([]), true)
		assert.equal(isEmptyResult({ timeRange: {}, spans: [] }), true)
		assert.equal(isEmptyResult({ spans: [{}] }), false)
	})
})

describe("timestamps", () => {
	// Zoneless warehouse times read as local time to anyone who forgets they are UTC.
	it("spells warehouse datetimes as ISO-8601 UTC and leaves other strings alone", () => {
		assert.equal(utcIso("2026-09-25 23:36:29.481465000"), "2026-09-25T23:36:29.481465000Z")
		assert.equal(utcIso("2026-09-25 23:36:29"), "2026-09-25T23:36:29Z")
		assert.equal(utcIso("2026-09-25T23:36:29Z"), "2026-09-25T23:36:29Z")
		assert.equal(utcIso("2026-09-25 23:36:29 request failed"), "2026-09-25 23:36:29 request failed")
	})

	it("rewrites time fields only, never log text or attributes", () => {
		const at = "2026-09-25 23:36:29"
		const json = JSON.parse(
			JSON.stringify(
				{
					timeRange: { startTime: at },
					logs: [{ timestamp: at, body: at, attributes: { startTime: at } }],
				},
				utcTimestampReplacer(),
			),
		)
		assert.deepEqual(json, {
			timeRange: { startTime: "2026-09-25T23:36:29Z" },
			logs: [{ timestamp: "2026-09-25T23:36:29Z", body: at, attributes: { startTime: at } }],
		})
	})
})

describe("local UI links", () => {
	const base = "http://127.0.0.1:4318/"
	const now = Date.parse("2026-10-13T12:00:00Z")

	it("links a trace through the UI's hash route", () => {
		assert.equal(traceLink(base, "abc123"), "http://127.0.0.1:4318/#/traces/abc123")
	})

	it("picks the narrowest UI range that reaches the window start", () => {
		assert.equal(uiRangeFor("2026-10-13 11:45:00", now), "1h")
		assert.equal(uiRangeFor("2026-10-13 06:00:00", now), "6h")
		assert.equal(uiRangeFor("2026-10-10 12:00:00", now), "7d")
		assert.equal(uiRangeFor("2025-01-01 00:00:00", now), "30d")
		// `--since 1h` run at a fractional second still links the 1h range.
		assert.equal(uiRangeFor("2026-10-13 11:00:00", now + 750), "1h")
	})

	it("carries the CLI's log filters into the logs page", () => {
		const url = logsLink(
			base,
			{
				startTime: "2026-10-13 11:45:00",
				service: "api",
				severity: "error",
				search: "Missing required",
			},
			now,
		)
		assert.equal(
			url,
			"http://127.0.0.1:4318/#/logs?range=1h&service=api&severity=error&q=Missing+required",
		)
		assert.equal(
			logsLink(base, { startTime: "2026-10-13 11:45:00" }, now),
			"http://127.0.0.1:4318/#/logs?range=1h",
		)
	})

	it("links only the logs that belong to a trace", () => {
		const [withTrace, without] = withLogTraceLinks(base, [{ traceId: "t1" }, { traceId: "" }])
		assert.equal(withTrace?.traceUrl, "http://127.0.0.1:4318/#/traces/t1")
		assert.equal(without?.traceUrl, undefined)
	})
})

describe("views", () => {
	it("renders services with units and a header row", () => {
		const rows = [
			{
				name: "api",
				throughput: 423,
				errorCount: 19,
				errorRate: 0.0449,
				p50Ms: 130.9,
				p95Ms: 209.3,
				p99Ms: 2178.9,
			},
		]
		const sections = servicesView("none").table?.(rows) ?? []
		const text = sections.map((s) => s.body).join("\n")
		assert.match(text, /SERVICE\s+THROUGHPUT/)
		assert.match(text, /4\.49%/)
		assert.match(text, /2\.18s/)
	})

	// Two fingerprints with the same label and message were indistinguishable.
	it("names the service on each error row", () => {
		const row = {
			fingerprintHash: "1",
			label: "PaymentGatewayTimeoutError",
			sampleMessage: "Timed out after 5000ms",
			count: 10,
			affectedServicesCount: 2,
			lastSeen: "2026-09-25 23:00:00",
			serviceName: "checkout-service",
		}
		const text = (errorsView("none").table?.([row]) ?? []).map((s) => s.body).join("\n")
		assert.match(text, /checkout-service \+1/)
	})
})

describe("failure rendering", () => {
	it("prints one error line and a hint, never a stack", () => {
		const text = formatFailure(
			describeFailure(
				new CliNotFoundError({
					message: "trace abc not found in the last 6h",
					hint: "try --since 7d",
				}),
			),
		)
		assert.equal(text, "error: trace abc not found in the last 6h\nhint: try --since 7d\n")
	})

	it("unwraps a mode failure riding in the executor's error type", () => {
		const mode = new ModeError({ message: "no Maple backend found", hint: "run maple start" })
		const report = describeFailure(
			new WarehouseConfigError({ message: mode.message, pipeName: "mode", cause: mode }),
		)
		assert.equal(report.expected, true)
		assert.equal(report.hint, "run maple start")
	})

	it("maps the server's read-only refusal to a maple query message", () => {
		const refused = new LocalQueryFailed({
			status: 400,
			detail: "read-only query endpoint: CREATE is not allowed",
			message: "Local query failed (400)",
		})
		const report = describeFailure(
			new WarehouseQueryError({ message: "x", pipeName: "rawQuery", cause: { cause: refused } }),
		)
		assert.equal(report.message, "maple query is read-only: CREATE is not allowed")
	})

	it("keeps query failures to their first line with a --debug pointer", () => {
		const report = describeFailure(
			new WarehouseQueryError({
				message: "Code: 62. Syntax error\n  at stack frame",
				pipeName: "rawQuery",
			}),
		)
		assert.equal(report.message, "Code: 62. Syntax error")
		assert.equal(report.expected, false)
		assert.match(report.hint ?? "", /--debug/)
	})

	it("hides Effect's cause rendering unless --debug", () => {
		const cause = Cause.fail(new TimeRangeError({ message: 'invalid --since "1w"' }))
		assert.equal(
			renderUnexpected(cause, false),
			"error: invalid --since \"1w\"\nhint: use --since 30m, 6h or 7d, or --start/--end as 'YYYY-MM-DD HH:mm:ss' (UTC) or ISO-8601\n",
		)
		assert.ok(
			renderUnexpected(Cause.die(new Error("boom")), false).startsWith(
				"error: unexpected failure: boom",
			),
		)
	})

	it("folds the parser's suggestions into a hint", () => {
		assert.equal(
			formatParseError(
				"Unrecognized flag: --env in command maple traces\n\n  Did you mean this?\n    --end",
			),
			"error: Unrecognized flag: --env in command maple traces\nhint: did you mean --end?",
		)
	})
})
