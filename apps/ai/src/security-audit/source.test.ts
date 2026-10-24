import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { auditToolHandlers, MAX_READ_LINES, SourceReadError, type SourceReaderApi } from "./source"

const calls: Array<{ readonly tool: string; readonly args: ReadonlyArray<unknown> }> = []
const fake: SourceReaderApi = {
	readFile: (path, start, end) =>
		Effect.sync(() => {
			calls.push({ tool: "read", args: [path, start, end] })
			return { text: "1\tline", truncated: false }
		}),
	grep: (pattern) =>
		pattern === "("
			? Effect.fail(new SourceReadError({ message: "grep failed: unbalanced (" }))
			: Effect.succeed({ text: "a.ts:1:x", truncated: true }),
	listFiles: (path) =>
		Effect.sync(() => {
			calls.push({ tool: "list", args: [path] })
			return { text: "", truncated: false }
		}),
	log: (path) =>
		Effect.sync(() => {
			calls.push({ tool: "log", args: [path] })
			return { text: "abc fix", truncated: false }
		}),
}
const { handlers } = auditToolHandlers(fake)
const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(Effect.result(effect))

describe("audit tool handlers", () => {
	it("caps one read at the line limit", async () => {
		calls.length = 0
		await run(handlers.read_file({ path: "src/a.ts", start_line: 10, end_line: 5_000 }))
		expect(calls[0]?.args).toEqual(["src/a.ts", 10, 10 + MAX_READ_LINES - 1])
	})

	it("reads the whole repository when the path is the root", async () => {
		calls.length = 0
		await run(handlers.list_files({ path: "." }))
		await run(handlers.git_log({ path: "." }))
		expect(calls.map((c) => c.args[0])).toEqual([undefined, undefined])
	})

	it("tells the model when output was cut and when a read found nothing", async () => {
		const grep = await run(handlers.grep({ pattern: "x" }))
		const list = await run(handlers.list_files({ path: "src" }))
		expect([grep, list].map((r) => (r._tag === "Success" ? r.success : undefined))).toEqual([
			"a.ts:1:x\n[output truncated: narrow the path or pattern]",
			"(no output)",
		])
	})

	it("returns a read failure to the model as a message", async () => {
		const result = await run(handlers.grep({ pattern: "(" }))
		expect(result._tag === "Failure" ? result.failure : undefined).toEqual({
			message: "grep failed: unbalanced (",
		})
	})
})
