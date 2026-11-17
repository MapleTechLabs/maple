import { Array as Arr, Record as Rec, Schema, String as Str } from "effect"
import { describe, expect, it } from "vitest"
import { UPTIME_MAX_BODY_LENGTH, UPTIME_MAX_HEADERS, UPTIME_MAX_URL_LENGTH } from "../../uptime"
import {
	uptimeConfigFromWire,
	uptimeConfigToWire,
	V2UptimeMonitorConfig,
	V2UptimeMonitorConfigInput,
} from "./uptime-monitors"

const repeat = (text: string, count: number) => Str.repeat(count)(text)

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

describe("wire config size limits", () => {
	const decodeInput = Schema.decodeUnknownExit(V2UptimeMonitorConfigInput)
	const decodeResponse = Schema.decodeUnknownExit(V2UptimeMonitorConfig)
	const oversized = [
		{ type: "http", url: "https://api.example.com/", body: repeat("b", UPTIME_MAX_BODY_LENGTH + 1) },
		{ type: "http", url: `https://api.example.com/${repeat("p", UPTIME_MAX_URL_LENGTH)}` },
		{
			type: "multistep",
			steps: [
				{
					name: "Log in",
					url: "https://api.example.com/login",
					headers: Rec.fromEntries(
						Arr.makeBy(UPTIME_MAX_HEADERS + 1, (index): [string, string] => [`x-${index}`, "v"]),
					),
				},
			],
		},
	]

	it("refuses an oversized config in a request body", () => {
		expect(Arr.map(oversized, (config) => decodeInput(config)._tag)).toEqual([
			"Failure",
			"Failure",
			"Failure",
		])
		expect(decodeInput({ type: "http", url: "https://api.example.com/", body: "{}" })._tag).toBe(
			"Success",
		)
	})

	it("still carries a monitor saved before the limits in a response", () => {
		expect(Arr.map(oversized, (config) => decodeResponse(config)._tag)).toEqual([
			"Success",
			"Success",
			"Success",
		])
	})
})
