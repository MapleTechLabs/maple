import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { uptimeConfigFromWire, uptimeConfigToWire, V2UptimeMonitorConfig } from "./uptime-monitors"

const decodeWire = Schema.decodeUnknownSync(V2UptimeMonitorConfig)

describe("multi-step wire config", () => {
	it("fills a step's defaults on the way in and spells them out on the way back", () => {
		const sent = decodeWire({
			type: "multistep",
			steps: [
				{
					name: "Log in",
					method: "POST",
					url: "https://api.example.com/login",
					body: "{}",
					extract: [{ name: "token", from: { type: "json_path", path: "token" } }],
				},
				{
					name: "Orders",
					url: "https://api.example.com/orders",
					headers: { authorization: "Bearer {{token}}" },
				},
			],
		})
		expect(uptimeConfigToWire(uptimeConfigFromWire(sent))).toEqual({
			type: "multistep",
			timeout_ms: 30_000,
			steps: [
				{
					name: "Log in",
					method: "POST",
					url: "https://api.example.com/login",
					headers: {},
					body: "{}",
					assertions: [{ type: "status", op: "is", value: "2xx" }],
					extract: [{ name: "token", from: { type: "json_path", path: "token" } }],
				},
				{
					name: "Orders",
					method: "GET",
					url: "https://api.example.com/orders",
					headers: { authorization: "Bearer {{token}}" },
					assertions: [{ type: "status", op: "is", value: "2xx" }],
					extract: [],
				},
			],
		})
	})

	it("refuses more than ten steps", () => {
		const step = { name: "Ping", url: "https://api.example.com/" }
		expect(() =>
			decodeWire({ type: "multistep", steps: Array.from({ length: 11 }, () => step) }),
		).toThrow()
	})
})
