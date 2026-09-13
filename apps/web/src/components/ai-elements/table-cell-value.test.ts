import { describe, expect, it } from "vitest"

import { classifyCell, columnRole, durationScale } from "./table-cell-value"

const services = new Set(["dashboard", "editor"])
const opts = (header: string) => ({
	role: columnRole(header),
	header,
	knownServices: services,
})

describe("columnRole", () => {
	it("reads the roles the model actually writes", () => {
		expect(columnRole("Trace ID")).toBe("trace")
		expect(columnRole("Service")).toBe("service")
		expect(columnRole("p99 Latency")).toBe("duration")
		expect(columnRole("Error")).toBe("error")
		expect(columnRole("Status")).toBe("status")
		expect(columnRole("Root Span")).toBeNull()
	})
})

describe("durationScale", () => {
	it("takes the percentile from the header, and p99 when there is none", () => {
		expect(durationScale("p50 latency")).toBe("p50")
		expect(durationScale("Avg duration")).toBe("avg")
		expect(durationScale("p95")).toBe("p95")
		expect(durationScale("Duration")).toBe("p99")
	})
})

describe("classifyCell", () => {
	it("recognizes a trace id by shape, whatever the column says", () => {
		expect(classifyCell("b02eadc6551920cb1bae8554b498a7c2", opts("Notes"))).toEqual({
			kind: "trace",
			traceId: "b02eadc6551920cb1bae8554b498a7c2",
		})
	})

	it("leaves a hex string of the wrong length alone", () => {
		expect(classifyCell("b02eadc6551920cb", opts("Trace ID")).kind).toBe("plain")
	})

	it("splits a duration from the gloss the model wrote after it", () => {
		expect(classifyCell("4672.46s (~78 min)", opts("Duration"))).toEqual({
			kind: "duration",
			ms: 4_672_460,
			scale: "p99",
			value: "4672.46s",
			note: "(~78 min)",
		})
	})

	it("needs a unit before it calls a number a duration", () => {
		expect(classifyCell("1327", opts("Duration")).kind).toBe("plain")
		expect(classifyCell("1327ms", opts("Duration"))).toMatchObject({ kind: "duration", ms: 1327 })
	})

	it("links a service the org reports and nothing else", () => {
		expect(classifyCell("dashboard", opts("Service"))).toEqual({ kind: "service", name: "dashboard" })
		expect(classifyCell("checkout", opts("Service")).kind).toBe("plain")
	})

	it("does not link a service name outside a service column", () => {
		expect(classifyCell("dashboard", opts("Owner")).kind).toBe("plain")
	})

	it("reads yes/no only under a column about failure", () => {
		expect(classifyCell("no", opts("Error"))).toEqual({ kind: "flag", severe: false, text: "no" })
		expect(classifyCell("yes", opts("Error"))).toEqual({ kind: "flag", severe: true, text: "yes" })
		expect(classifyCell("yes", opts("Sampled")).kind).toBe("plain")
	})

	it("treats an error count as a flag", () => {
		expect(classifyCell("0", opts("Errors"))).toMatchObject({ severe: false })
		expect(classifyCell("1,204", opts("Errors"))).toMatchObject({ severe: true })
	})

	it("reads a status code only under a status column", () => {
		expect(classifyCell("503", opts("Status"))).toEqual({ kind: "status", code: 503, text: "503" })
		expect(classifyCell("503", opts("Count")).kind).toBe("plain")
	})

	it("recognizes severity words anywhere", () => {
		expect(classifyCell("warn", opts("Level"))).toEqual({ kind: "severity", label: "WARN" })
	})

	it("leaves an empty cell alone", () => {
		expect(classifyCell("   ", opts("Duration")).kind).toBe("plain")
	})
})
