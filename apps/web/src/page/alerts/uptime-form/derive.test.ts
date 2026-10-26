import { V2UptimeMonitorCreateParams } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { wirePayload } from "./derive"
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
