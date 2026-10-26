import { V2UptimeMonitorCreateParams } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { formIssues, isPrivateHost, wirePayload } from "./derive"
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
