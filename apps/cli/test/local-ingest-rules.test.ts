import { describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
	applyLocalIngestRules,
	makeLocalIngestRulesSource,
	parseLocalIngestRules,
} from "../src/server/ingest-rules"
import { encodeLogs, encodeTraces } from "../src/server/otlp/encode"

const rules = parseLocalIngestRules(
	JSON.stringify([
		{
			name: "Drop debug",
			signals: ["logs"],
			conditions: [{ field: "severity", op: "lt", value: "info" }],
			action: { _tag: "drop", keepPercent: 0 },
		},
		{
			name: "Mask emails",
			signals: ["logs", "traces"],
			conditions: [],
			action: {
				_tag: "redact",
				keys: ["*password*"],
				detectors: ["email"],
				patterns: [],
				scopes: ["attributes", "body"],
				method: "mask",
			},
		},
	]),
)

const str = (key: string, value: string) => ({ key, value: { stringValue: value } })

describe("local ingest rules", () => {
	it("drops and redacts logs before they are encoded, keeping untouched values as sent", () => {
		const request = {
			resourceLogs: [
				{
					resource: { attributes: [str("service.name", "api")] },
					scopeLogs: [
						{
							logRecords: [
								{ severityNumber: 5, body: { stringValue: "debug noise" }, attributes: [] },
								{
									severityNumber: 9,
									body: { stringValue: "login a@b.co" },
									attributes: [
										str("user.password", "hunter2"),
										{ key: "ratio", value: { doubleValue: 2 } },
									],
								},
							],
						},
					],
				},
			],
		}
		expect(applyLocalIngestRules("logs", request, rules.compiled)).toEqual({
			dropped: 1,
			redactedValues: 2,
		})
		const [batch] = encodeLogs(request)
		expect(batch?.rowCount).toBe(1)
		expect(batch?.ndjson).toContain("login [REDACTED:email]")
		expect(batch?.ndjson).not.toContain("hunter2")
		expect(request.resourceLogs[0]?.scopeLogs[0]?.logRecords[0]?.attributes[1]).toEqual({
			key: "ratio",
			value: { doubleValue: 2 },
		})
	})

	it("removes a resource whose every record was dropped", () => {
		const request = {
			resourceLogs: [
				{
					resource: { attributes: [str("service.name", "api")] },
					scopeLogs: [{ logRecords: [{ severityText: "DEBUG", body: { stringValue: "x" } }] }],
				},
			],
		}
		applyLocalIngestRules("logs", request, rules.compiled)
		expect(request.resourceLogs).toEqual([])
	})

	it("redacts span attributes and event attributes it is scoped to", () => {
		const request = {
			resourceSpans: [
				{
					resource: { attributes: [str("service.name", "api")] },
					scopeSpans: [
						{
							spans: [
								{
									traceId: "0af7651916cd43dd8448eb211c80319c",
									spanId: "b7ad6b7169203331",
									name: "GET /users",
									attributes: [str("enduser.email", "a@b.co")],
									events: [
										{
											name: "exception",
											attributes: [str("exception.message", "no a@b.co")],
										},
									],
								},
							],
						},
					],
				},
			],
		}
		applyLocalIngestRules("traces", request, rules.compiled)
		const ndjson = encodeTraces(request)[0]?.ndjson ?? ""
		expect(ndjson).toContain("[REDACTED:email]")
		// Events are not in this rule's scopes.
		expect(ndjson).toContain("no a@b.co")
	})

	it("names invalid rules and keeps the valid ones", () => {
		const parsed = parseLocalIngestRules(
			JSON.stringify([
				{ name: "Bad", signals: ["logs"], conditions: [], action: { _tag: "drop", keepPercent: 0 } },
				{
					signals: ["logs"],
					conditions: [],
					action: {
						_tag: "redact",
						keys: ["k"],
						detectors: [],
						patterns: [],
						scopes: ["attributes"],
						method: "remove",
					},
				},
			]),
		)
		expect(parsed.compiled.rules).toHaveLength(1)
		expect(parsed.problems).toEqual(["ingest rule Bad skipped: a drop rule needs at least one condition"])
		expect(parseLocalIngestRules("not json").problems[0]).toContain("ingest rules file is invalid")
		const oneMalformed = parseLocalIngestRules(
			JSON.stringify([
				{ signals: ["log"], conditions: [], action: { _tag: "drop", keepPercent: 0 } },
				{
					signals: ["logs"],
					conditions: [],
					action: {
						_tag: "redact",
						keys: ["k"],
						detectors: [],
						patterns: [],
						scopes: ["attributes"],
						method: "remove",
					},
				},
			]),
		)
		expect(oneMalformed.compiled.rules).toHaveLength(1)
		expect(oneMalformed.problems[0]).toContain("ingest rule 1 skipped")
	})

	it("merges resource redactions from rules matched by different records", () => {
		const byService = parseLocalIngestRules(
			JSON.stringify([
				{
					signals: ["logs"],
					conditions: [{ field: "body", op: "eq", value: "one" }],
					action: {
						_tag: "redact",
						keys: ["host.name"],
						detectors: [],
						patterns: [],
						scopes: ["resource"],
						method: "mask",
					},
				},
				{
					signals: ["logs"],
					conditions: [{ field: "body", op: "eq", value: "two" }],
					action: {
						_tag: "redact",
						keys: ["user.email"],
						detectors: [],
						patterns: [],
						scopes: ["resource"],
						method: "mask",
					},
				},
			]),
		)
		const request = {
			resourceLogs: [
				{
					resource: {
						attributes: [
							str("service.name", "api"),
							str("host.name", "h1"),
							str("user.email", "a@b.co"),
						],
					},
					scopeLogs: [
						{ logRecords: [{ body: { stringValue: "one" } }, { body: { stringValue: "two" } }] },
					],
				},
			],
		}
		applyLocalIngestRules("logs", request, byService.compiled)
		expect(request.resourceLogs[0]?.resource.attributes).toEqual([
			str("service.name", "api"),
			str("host.name", "[REDACTED]"),
			str("user.email", "[REDACTED]"),
		])
	})

	it("redacts metric exemplars and span status messages under the attributes scope", () => {
		const metrics = {
			resourceMetrics: [
				{
					resource: { attributes: [str("service.name", "api")] },
					scopeMetrics: [
						{
							metrics: [
								{
									name: "http.server.duration",
									gauge: {
										dataPoints: [
											{
												attributes: [],
												exemplars: [
													{ filteredAttributes: [str("enduser.email", "a@b.co")] },
												],
											},
										],
									},
								},
							],
						},
					],
				},
			],
		}
		const emailRules = parseLocalIngestRules(
			JSON.stringify([
				{
					signals: ["metrics", "traces"],
					conditions: [],
					action: {
						_tag: "redact",
						keys: [],
						detectors: ["email"],
						patterns: [],
						scopes: ["attributes"],
						method: "mask",
					},
				},
			]),
		)
		applyLocalIngestRules("metrics", metrics, emailRules.compiled)
		expect(
			metrics.resourceMetrics[0]?.scopeMetrics[0]?.metrics[0]?.gauge.dataPoints[0]?.exemplars[0]
				?.filteredAttributes,
		).toEqual([str("enduser.email", "[REDACTED:email]")])
		const traces = {
			resourceSpans: [
				{
					resource: { attributes: [] },
					scopeSpans: [{ spans: [{ name: "x", status: { code: 2, message: "no user a@b.co" } }] }],
				},
			],
		}
		applyLocalIngestRules("traces", traces, emailRules.compiled)
		expect(traces.resourceSpans[0]?.scopeSpans[0]?.spans[0]?.status.message).toBe(
			"no user [REDACTED:email]",
		)
	})

	it("re-reads the rules file only when it changes, and reports one it cannot read", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maple-rules-"))
		const file = path.join(dir, "ingest-rules.json")
		const source = makeLocalIngestRulesSource(file)
		expect(source()).toMatchObject({ reloaded: false })
		const write = (rules: ReadonlyArray<unknown>, at: number) => {
			fs.writeFileSync(file, JSON.stringify(rules))
			fs.utimesSync(file, at, at)
		}
		const rule = {
			signals: ["logs"],
			conditions: [],
			action: {
				_tag: "redact",
				keys: ["k"],
				detectors: [],
				patterns: [],
				scopes: ["attributes"],
				method: "remove",
			},
		}
		write([rule], 1_000)
		const first = source()
		expect([first.reloaded, first.rules.compiled.rules.length]).toEqual([true, 1])
		expect(source().reloaded).toBe(false)
		write([rule, rule], 2_000)
		expect(source().rules.compiled.rules.length).toBe(2)
		fs.rmSync(file)
		fs.mkdirSync(file)
		fs.utimesSync(file, 3_000, 3_000)
		const unreadable = source()
		expect(unreadable.rules.compiled.rules).toEqual([])
		expect(unreadable.rules.problems[0]).toContain("could not be read")
		fs.rmSync(dir, { recursive: true })
	})
})
