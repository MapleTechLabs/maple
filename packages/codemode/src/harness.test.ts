import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { buildSandboxModules, SANDBOX_MAIN_MODULE } from "./harness.ts"
import type { RpcCallResult } from "./types.ts"

const tmpDirs: string[] = []
afterEach(() => {
	for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * Write the real two-module set (main.js + user.js) to a temp dir and import
 * `main.js` so its relative `import ./user.js` resolves — exercising the actual
 * composition the sandbox loads, with a fake `env.MAPLE`.
 */
const runHarness = async (
	code: string,
	dispatch: (name: string, input: unknown) => Promise<RpcCallResult>,
	capBytes?: number,
): Promise<{ logs: string[]; returnValue: unknown; error: { name: string; message: string } | null }> => {
	const dir = mkdtempSync(join(tmpdir(), "codemode-harness-"))
	tmpDirs.push(dir)
	const modules = buildSandboxModules(code, capBytes)
	for (const [name, source] of Object.entries(modules)) writeFileSync(join(dir, name), source)
	let mod: { default: { fetch: (req: Request, env: unknown) => Promise<Response> } }
	try {
		// A snippet that fails to parse breaks user.js; Node surfaces it here at
		// import time. The real sandbox catches the equivalent failure at fetch and
		// reports a crashed run — model that with a crashed-shaped result.
		mod = await import(pathToFileURL(join(dir, SANDBOX_MAIN_MODULE)).href)
	} catch (e) {
		return { logs: [], returnValue: undefined, error: { name: "LoadError", message: String(e) } }
	}
	const env = { MAPLE: { call: (name: string, input: unknown) => dispatch(name, input) } }
	const res = await mod.default.fetch(new Request("https://codemode/run"), env)
	return res.json()
}

const ok = (value: string): RpcCallResult => ({ ok: true, value })

describe("buildSandboxModules", () => {
	it("captures console.log output", async () => {
		const out = await runHarness(`console.log("hello", { a: 1 })`, async () => ok("x"))
		expect(out.logs).toEqual(['hello {"a":1}'])
		expect(out.error).toBeNull()
	})

	it("captures the user function's return value", async () => {
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

	it("isolates a break-out attempt to the user module (can't reach the harness scope)", async () => {
		// `})();` would, in an inline splice, close the wrapper and run in the
		// harness scope. As its own module it just fails to parse -> crashed run.
		const out = await runHarness(`console.log("before"); })(); __logs.length = 0;`, async () => ok("x"))
		expect(out.error).not.toBeNull()
		expect(out.logs).toEqual([])
	})
})
