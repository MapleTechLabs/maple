import { describe, expect, it } from "vitest"

import { parseAnnotations } from "./parse-annotations"

const service = (name: string) => `{"name":"${name}","throughput":11,"errorRate":45.45,"p99Ms":14425}`

describe("parseAnnotations", () => {
	it("parses the documented form on its own line", () => {
		const segments = parseAnnotations(`Top offender:\n<<maple:service:${service("maple-chat")}>>\nrest`)
		expect(segments.map((s) => s.type)).toEqual(["text", "service", "text"])
	})

	it("parses a single-bracket form", () => {
		const segments = parseAnnotations(`<maple:service:${service("openrouter")}>`)
		expect(segments).toEqual([
			{
				type: "service",
				data: { name: "openrouter", throughput: 11, errorRate: 45.45, p99Ms: 14425 },
			},
		])
	})

	it("parses several cards run together on one line", () => {
		const segments = parseAnnotations(
			`<maple:service:${service("a")}><maple:service:${service("b")}><maple:service:${service("c")}>`,
		)
		expect(segments.map((s) => s.type)).toEqual(["service", "service", "service"])
	})

	it("keeps surrounding prose", () => {
		const segments = parseAnnotations(`before <maple:service:${service("a")}> after`)
		expect(segments[0]).toEqual({ type: "text", content: "before " })
		expect(segments[2]).toEqual({ type: "text", content: " after" })
	})

	it("handles nested braces and escaped quotes in the payload", () => {
		const segments = parseAnnotations(
			'<<maple:log:{"severity":"WARN","body":"got {\\"a\\":1} back","serviceName":"api"}>>',
		)
		expect(segments).toEqual([
			{ type: "log", data: { severity: "WARN", body: 'got {"a":1} back', serviceName: "api" } },
		])
	})

	it("holds back a half-streamed annotation", () => {
		const segments = parseAnnotations('Findings:\n<<maple:service:{"name":"ma')
		expect(segments).toEqual([{ type: "text", content: "Findings:\n" }])
	})

	it("leaves a payload that does not match its card as text", () => {
		const raw = '<<maple:service:{"nome":"typo"}>>'
		expect(parseAnnotations(raw)).toEqual([{ type: "text", content: raw }])
	})

	it("returns plain text untouched", () => {
		expect(parseAnnotations("no cards here")).toEqual([{ type: "text", content: "no cards here" }])
	})
})
