import { V2UptimeMonitorCreateParams, V2UptimeMonitorUpdateParams } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { formFromMonitor, formIssues, isPrivateHost, wirePayload } from "./derive"
import { heartbeatMonitor, httpMonitor } from "../shared/uptime-test-monitors"
import { emptyForm } from "./form"

const decodeCreate = Schema.decodeUnknownExit(V2UptimeMonitorCreateParams)

describe("wirePayload", () => {
	it("sends body and header contains values the create schema accepts when typed with spaces", () => {
		const form = emptyForm({
			kind: "http",
			name: "checkout",
			url: "https://example.com/health",
			assertions: [
				{ id: 1, type: "body", op: "contains", target: "", value: " 200 OK " },
				{ id: 2, type: "header", op: "contains", target: "content-type", value: " json" },
			],
		})
		const payload = wirePayload(form, false)
		expect(decodeCreate(payload)._tag).toBe("Success")
		expect(payload).toMatchObject({
			config: {
				assertions: [
					{ type: "body", op: "contains", value: "200 OK" },
					{ type: "header", name: "content-type", op: "contains", value: "json" },
				],
			},
		})
	})
})

describe("isPrivateHost", () => {
	it("refuses private literals and internal names, not public names that start with a digit label", () => {
		expect(
			["10.0.0.1", "127.0.0.1", "[::1]", "db.internal", "localhost"].filter(isPrivateHost),
		).toHaveLength(5)
		expect(
			["10.example.com", "0.pool.ntp.org", "127.example.com", "93.184.216.34"].some(isPrivateHost),
		).toBe(false)
	})
})

describe("formIssues", () => {
	it("flags an http URL the browser cannot parse", () => {
		const issues = (url: string) => formIssues(emptyForm({ kind: "http", name: "api", url }))
		expect(issues("https://:80")).not.toEqual([])
		expect(issues("https://api.acme.dev/health")).toEqual([])
	})

	it("names a header line without a colon instead of saving the monitor without it", () => {
		const issues = formIssues(
			emptyForm({
				kind: "http",
				name: "api",
				url: "https://api.acme.dev/health",
				headers: "Accept: application/json\nX-Api-Key secret\n",
			}),
		)
		expect(issues).toEqual([
			"Header line 'X-Api-Key secret' needs a name and a colon, like Authorization: Bearer token.",
		])
	})
})

describe("formFromMonitor and wirePayload", () => {
	it("an untouched edit saves back the monitor it opened", () => {
		const decodeUpdate = Schema.decodeUnknownExit(V2UptimeMonitorUpdateParams)
		const full = httpMonitor({
			config: {
				type: "http",
				url: "https://api.acme.dev/orders",
				method: "POST",
				headers: { "content-type": "application/json", "x-team": "checkout" },
				body: '{"ping":true}',
				assertions: [
					{ type: "status", op: "is", value: "201" },
					{ type: "latency", under_ms: 800 },
					{ type: "body", op: "contains", value: "ok" },
					{ type: "json_path", path: "$.status", op: "equals", value: "ok" },
					{ type: "header", name: "content-type", op: "contains", value: "json" },
				],
				timeout_ms: 5000,
			},
			service_name: null,
			destination_ids: [],
		})
		;[httpMonitor(), full, heartbeatMonitor()].forEach((monitor) => {
			const payload = wirePayload(formFromMonitor(monitor), true)
			expect(decodeUpdate(payload)._tag).toBe("Success")
			expect(payload).toMatchObject({
				name: monitor.name,
				config: monitor.config,
				service_name: monitor.service_name,
				destination_ids: monitor.destination_ids,
			})
		})
	})

	it("refuses a response time too large to send", () => {
		const form = emptyForm({
			kind: "http",
			name: "api",
			url: "https://api.acme.dev/health",
			assertions: [{ id: 1, type: "latency", op: "under", target: "", value: "9".repeat(20) }],
		})
		expect(formIssues(form)).toEqual(["A response time check needs a whole number of milliseconds."])
	})
})
