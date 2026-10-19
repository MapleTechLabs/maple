import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

// chDB needs `bun:ffi`, so the scenario runs in a Bun child and prints the follow-up query's output.
const chdbModule = fileURLToPath(new URL("./chdb.ts", import.meta.url))
const script = `
import { Effect } from "effect"
import { sharedChdb } from ${JSON.stringify(chdbModule)}
const program = Effect.gen(function* () {
	const chdb = yield* sharedChdb
	yield* Effect.ignore(chdb.run("SELECT number, throwIf(number = 90000) FROM numbers(100000)", "JSONEachRow"))
	const next = yield* chdb.run("SELECT 1 AS x", "JSONEachRow")
	yield* chdb.close
	process.stdout.write(JSON.stringify(next))
})
await Effect.runPromise(program)
`

describe("parity chDB", () => {
	it("answers the next query cleanly after one fails mid-stream", () => {
		const child = spawnSync("bun", ["-e", script], {
			cwd: fileURLToPath(new URL("../..", import.meta.url)),
			encoding: "utf8",
			timeout: 60_000,
		})
		expect(child.stderr).toBe("")
		expect(JSON.parse(child.stdout)).toBe('{"x":1}\n')
	})
})
