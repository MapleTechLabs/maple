import { describe, it } from "vitest"
import { Effect, Result } from "effect"
import { deepStrictEqual, ok, strictEqual, throws } from "node:assert"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { SignalProjectionSpec } from "@maple/eventing-core"
import { loadProjectorModules, resolveProjectorModulePaths } from "../src/server/eventing/projector-modules"
import { startServer } from "../src/server/serve"
import { makeRuntime, openStore, run } from "./eventing-test-support"

const fixture = resolve(import.meta.dir, "fixtures/projector-module.mjs")
const withRoot = async (use: (root: string) => Promise<void>) => {
	const root = mkdtempSync(join(tmpdir(), "maple-projector-module-"))
	try {
		await use(root)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
}

const projection: SignalProjectionSpec = {
	id: "example-projection",
	revision: 1,
	enabled: true,
	tenantId: "local",
	sourceKind: "otel.log",
	selector: { op: "exists", field: { namespace: "signal", key: "event.name", type: "string" } },
	projector: { id: "example.record.observed", version: 1, config: {} },
	activeFrom: "2000-01-01T00:00:00Z",
}

const request = {
	resourceLogs: [
		{
			scopeLogs: [
				{
					logRecords: [
						{
							timeUnixNano: "1791919973000000000",
							observedTimeUnixNano: "1791919973000000000",
							eventName: "example.record.observed",
							body: { stringValue: "example" },
							attributes: [{ key: "event.id", value: { stringValue: "delivery-42" } }],
						},
					],
				},
			],
		},
	],
}

describe("projector modules", () => {
	it("reloads the extension against saved projections with stable event identity", async () => {
		await withRoot(async (root) => {
			const path = join(root, "extension #1.mjs")
			copyFileSync(fixture, path)
			const data = join(root, "data")
			mkdirSync(data)
			const evaluate = async (activate: boolean) => {
				const registry = await Effect.runPromise(loadProjectorModules([path]))
				const store = await openStore(data)
				try {
					const runtime = makeRuntime(store, registry)
					if (activate) run(runtime.activate(projection))
					return run(runtime.evaluateOtlp("logs", request)).events
				} finally {
					await store.close()
				}
			}
			const first = await evaluate(true)
			strictEqual(first.length, 1)
			deepStrictEqual(first[0]!.data, { label: "external projector", occurrenceId: "delivery-42" })
			const restarted = await evaluate(false)
			strictEqual(restarted[0]!.id, first[0]!.id)
			// Saved specs cannot silently lose their implementation on the next start.
			const store = await openStore(data)
			try {
				const missing = Effect.runSync(Effect.result(Effect.try(() => makeRuntime(store))))
				ok(Result.isFailure(missing))
			} finally {
				await store.close()
			}
		})
	})

	it("awaits asynchronous registration and closes the callback after initialization", async () => {
		await withRoot(async (root) => {
			const path = join(root, "async.mjs")
			writeFileSync(
				path,
				`import fixture from ${JSON.stringify(new URL("./fixtures/projector-module.mjs", import.meta.url).href)};
let retained;
export const registerLate = () => fixture.register(projector => retained({ ...projector, id: "late.projector" }));
export default { apiVersion: 1, async register(add) {
 await Promise.resolve(); retained = add; fixture.register(add);
} };`,
			)
			const registry = await Effect.runPromise(loadProjectorModules([path]))
			const before = registry.get("example.record.observed", 1)
			ok(before)
			const module = await import(path)
			module.registerLate()
			strictEqual(registry.get("example.record.observed", 1), before)
			strictEqual(registry.get("late.projector", 1), undefined)
		})
	})

	it("rejects duplicate files and duplicate registrations across different modules", async () => {
		await withRoot(async (root) => {
			const first = join(root, "first.mjs"),
				second = join(root, "second.mjs")
			copyFileSync(fixture, first)
			copyFileSync(fixture, second)
			for (const paths of [
				[first, first],
				[first, second],
			]) {
				const result = await Effect.runPromise(Effect.result(loadProjectorModules(paths)))
				ok(Result.isFailure(result))
				ok(/more than once|duplicate projector/.test(result.failure.message))
			}
		})
	})

	it("rejects unsupported exports, missing functions, import failures and registration failures before opening a store", async () => {
		await withRoot(async (root) => {
			const cases = [
				"export default { apiVersion: 2, register() {} }",
				"export default { apiVersion: 1, register: 42 }",
				'export default { apiVersion: 1, register(add) { add({ id: "broken" }) } }',
				'export default { apiVersion: 1, register(add) { add({ id: "", version: 1, sourceKinds: ["otel.log"], outputType: "event", dataSchema: "urn:test", decodeConfig() {}, decodeOutput() {}, project() {} }) } }',
				'throw new Error("fixture import failed")',
				'export default { apiVersion: 1, register() { throw new Error("fixture registration failed") } }',
			]
			for (const [index, content] of cases.entries()) {
				const path = join(root, `invalid-${index}.mjs`)
				writeFileSync(path, content)
				const dataDir = join(root, `data-${index}`)
				const result = await Effect.runPromise(
					startServer({
						hostname: "127.0.0.1",
						browserHosts: ["127.0.0.1"],
						port: 0,
						dataDir,
						projectorModules: [path],
					}).pipe(Effect.scoped, Effect.result),
				)
				ok(Result.isFailure(result))
				strictEqual(result.failure._tag, "@maple/cli/ProjectorModuleError")
				strictEqual(existsSync(dataDir), false)
				strictEqual(existsSync(join(root, `data-${index}.maple-store-version.json`)), false)
			}
		})
	})

	it("canonicalizes local paths and refuses URLs, missing files and directories", async () => {
		await withRoot(async (root) => {
			const link = join(root, "alias.mjs")
			symlinkSync(fixture, link)
			const paths = await Effect.runPromise(resolveProjectorModulePaths([link]))
			deepStrictEqual(paths, [fixture])
			const dir = join(root, "directory.mjs")
			mkdirSync(dir)
			for (const path of [
				"https://example.test/plugin.mjs",
				"file:///tmp/plugin.mjs",
				"",
				dir,
				join(root, "missing.mjs"),
			]) {
				const result = await Effect.runPromise(Effect.result(resolveProjectorModulePaths([path])))
				ok(Result.isFailure(result))
			}
		})
	})
})
