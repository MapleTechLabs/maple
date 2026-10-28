import { describe, expect, it } from "vitest"
import { applyLocalIngestRules, parseLocalIngestRules } from "../src/server/ingest-rules"
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
	})
})
