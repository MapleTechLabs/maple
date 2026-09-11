import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Miniflare } from "miniflare"
import { build } from "rolldown"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/** Two actual isolates: callback functions and domain outputs cross native RPC serialization. */
describe("AI service over native Worker RPC", () => {
	let mf: Miniflare
	let directory: string
	beforeAll(async () => {
		directory = await mkdtemp(join(tmpdir(), "maple-ai-rpc-"))
		for (const entry of ["rpc-worker", "rpc-caller"]) {
			await build({
				input: fileURLToPath(new URL(`../test/${entry}.ts`, import.meta.url)),
				external: ["cloudflare:workers"],
				platform: "browser",
				output: { file: join(directory, `${entry}.js`), format: "esm" },
			})
		}
		const worker = async (name: string, entry: string) => ({
			name,
			type: "worker" as const,
			compatibilityDate: "2026-04-08",
			manifest: {
				mainModule: "worker.js",
				modulesRoot: directory,
				modules: {
					"worker.js": {
						type: "esm" as const,
						contents: await readFile(join(directory, `${entry}.js`), "utf8"),
					},
				},
			},
		})
		mf = new Miniflare({
			workers: [
				{
					config: {
						...(await worker("caller", "rpc-caller")),
						env: { AI_SERVICE: { type: "worker", worker: "ai" } },
					},
				},
				{ config: await worker("ai", "rpc-worker") },
			],
		})
		await mf.ready
	}, 60_000)
	afterAll(async () => {
		await mf?.dispose()
		if (directory) await rm(directory, { recursive: true, force: true })
	})

	it("executes API callbacks, streams events in order and returns metering", async () => {
		const response = await mf.dispatchFetch("http://test/chat")
		expect(response.status).toBe(200)
		const result = (await response.json()) as {
			calls: string[]
			events: Array<{ type: string; delta?: string }>
			usage: { input: number; output: number }
		}
		expect(result.calls).toEqual(["list_services"])
		expect(result.events.some((event) => event.type === "turn-end")).toBe(true)
		expect(result.usage.input).toBeGreaterThan(0)
		expect(result.usage.output).toBeGreaterThan(0)
	})

	it("returns a submitted plan as a serializable value", async () => {
		const response = await mf.dispatchFetch("http://test/plan")
		expect(response.status).toBe(200)
		expect(await response.json()).toMatchObject({
			plan: { scopeSummary: "Check the deploy" },
			inputTokens: 10,
		})
	})

	it("returns a validator result across the same boundary", async () => {
		const response = await mf.dispatchFetch("http://test/validate")
		expect(response.status).toBe(200)
		expect(await response.json()).toMatchObject({
			promotedLensId: null,
			report: null,
			note: "No supported finding",
		})
	})

	it("serializes a hypothesis candidate and a solo diagnosis", async () => {
		for (const path of ["hypothesis", "solo"]) {
			const response = await mf.dispatchFetch(`http://test/${path}`)
			expect(response.status).toBe(200)
			const result = await response.json()
			expect(result).toMatchObject(
				path === "solo"
					? { report: { suspectedCause: "Pool capacity" } }
					: { claim: "Pool exhausted", report: null },
			)
		}
	})

	it("rejects invalid tenancy before a model or tool is run", async () => {
		const response = await mf.dispatchFetch("http://test/invalid")
		expect(response.status).toBe(500)
		expect(await response.json()).toMatchObject({ failed: true, calls: [] })
	})
})
