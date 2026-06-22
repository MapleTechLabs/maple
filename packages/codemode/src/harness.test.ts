import { describe, expect, it } from "vitest"
import { buildHarnessModule } from "./harness.ts"
import type { RpcCallResult } from "./types.ts"

/**
 * Load the generated harness module as an ESM data URL and run its `fetch`
 * handler in-process with a fake `env.MAPLE` — exercises log/return/error
 * capture without the Workers runtime.
 */
const runHarness = async (
	code: string,
	dispatch: (name: string, input: unknown) => Promise<RpcCallResult>,
	capBytes?: number,
): Promise<{ logs: string[]; returnValue: unknown; error: { name: string; message: string } | null }> => {
	const src = buildHarnessModule(code, capBytes)
	const mod = await import(`data:text/javascript,${encodeURIComponent(src)}`)
	const env = { MAPLE: { call: (name: string, input: unknown) => dispatch(name, input) } }
	const res = await mod.default.fetch(new Request("https://codemode/run"), env)
	return res.json()
}

const ok = (value: string): RpcCallResult => ({ ok: true, value })

describe("buildHarnessModule", () => {
	it("captures console.log output", async () => {
		const out = await runHarness(`console.log("hello", { a: 1 })`, async () => ok("x"))
		expect(out.logs).toEqual(['hello {"a":1}'])
		expect(out.error).toBeNull()
	})

	it("captures the IIFE return value", async () => {
		const out = await runHarness(`return { count: 2 }`, async () => ok("x"))
		expect(out.returnValue).toEqual({ count: 2 })
	})

	it("routes maple.<tool>(input) through env.MAPLE.call and returns its value", async () => {
		const calls: Array<[string, unknown]> = []
		const out = await runHarness(
			`const r = await maple.find_errors({ service: "api" }); console.log(r)`,
			async (name, input) => {
				calls.push([name, input])
				return ok(`called ${name}`)
			},
		)
		expect(calls).toEqual([["find_errors", { service: "api" }]])
		expect(out.logs).toEqual(["called find_errors"])
	})

	it("throws inside user code when a call returns ok:false", async () => {
		const out = await runHarness(
			`try { await maple.boom({}) } catch (e) { console.log("caught", e.message) }`,
			async () => ({ ok: false, error: { name: "BadTool", message: "nope" } }),
		)
		expect(out.logs).toEqual(["caught nope"])
		expect(out.error).toBeNull()
	})

	it("captures an uncaught error as a value", async () => {
		const out = await runHarness(`throw new Error("kaboom")`, async () => ok("x"))
		expect(out.error?.message).toBe("kaboom")
	})

	it("truncates output past the byte cap", async () => {
		const out = await runHarness(`for (let i = 0; i < 100; i++) console.log("x".repeat(50))`, async () => ok("x"), 1000)
		expect(out.logs.at(-1)).toBe("[output truncated]")
		const total = out.logs.join("").length
		expect(total).toBeLessThan(1300)
	})
})
