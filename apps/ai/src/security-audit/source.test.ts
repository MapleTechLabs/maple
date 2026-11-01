import { Effect, Ref } from "effect"
import { describe, expect, it } from "vitest"
import {
	auditToolHandlers,
	MAX_READ_LINES,
	normalizePath,
	SourceReadError,
	type SourceReaderApi,
} from "./source"

const TRACKED = ["src/a.ts", "src/b.ts", "lib/gone.ts", "tools/x/gone.ts"]

const calls: Array<{ readonly tool: string; readonly args: ReadonlyArray<unknown> }> = []
const fake: SourceReaderApi = {
	readFile: (path, start, end) =>
		Effect.suspend(() => {
			calls.push({ tool: "read", args: [path, start, end] })
			return TRACKED.includes(path)
				? Effect.succeed({ text: "1\tline", truncated: false })
				: Effect.fail(new SourceReadError({ message: `cannot read ${path}: not a tracked file` }))
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
	nearby: (path, basename) =>
		Effect.sync(() => {
			calls.push({ tool: "nearby", args: [path, basename] })
			const text = TRACKED.filter(
				(file) => file.startsWith(`${path}/`) || file.endsWith(`/${basename}`),
			).join("\n")
			return { text, truncated: false }
		}),
}
const { handlers } = auditToolHandlers(fake)
const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(Effect.result(effect))
const failureOf = <A, E extends { readonly message: string }>(
	result: Awaited<ReturnType<typeof run<A, E>>>,
) => (result._tag === "Failure" ? result.failure.message : undefined)

describe("audit tool handlers", () => {
	it("caps one read at the line limit", async () => {
		calls.length = 0
		await run(handlers.read_file({ path: "src/a.ts", start_line: 10, end_line: 5_000 }))
		expect(calls[0]?.args).toEqual(["src/a.ts", 10, 10 + MAX_READ_LINES - 1])
	})

	it("reads the whole repository when the path is the root", async () => {
		calls.length = 0
		await run(handlers.list_files({ path: "." }))
		await run(handlers.git_log({ path: "./" }))
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
		expect(failureOf(result)).toBe("grep failed: unbalanced (")
	})

	it("counts every tool call for the host", async () => {
		const counted = await Effect.runPromise(
			Effect.gen(function* () {
				const n = yield* Ref.make(0)
				const tools = auditToolHandlers(
					fake,
					Ref.update(n, (x) => x + 1),
				).handlers
				yield* Effect.result(tools.read_file({ path: "src/a.ts" }))
				yield* Effect.result(tools.grep({ pattern: "x" }))
				yield* Effect.result(tools.list_files({ path: "." }))
				yield* Effect.result(tools.git_log({ path: "." }))
				return yield* Ref.get(n)
			}),
		)
		expect(counted).toBe(4)
	})
})

describe("normalizePath", () => {
	it("reads ./, leading slashes, backslashes and inner .. as the same repository path", () => {
		expect(
			["./src/a.ts", "/src/a.ts", "src\\a.ts", "src/x/../a.ts", "src//./a.ts"].map(normalizePath),
		).toEqual(["src/a.ts", "src/a.ts", "src/a.ts", "src/a.ts", "src/a.ts"])
		expect(["../etc/passwd", "src/../../x", "./", "/"].map(normalizePath)).toEqual([
			undefined,
			undefined,
			"",
			"",
		])
	})
})

describe("read_file on a path that missed", () => {
	it("reads a path the model spelled with ./ or backslashes", async () => {
		const result = await run(handlers.read_file({ path: ".\\src\\a.ts" }))
		expect(result._tag === "Success" ? result.success : undefined).toBe("1\tline")
	})

	it("refuses a path that climbs out of the repository without reading it", async () => {
		calls.length = 0
		const result = await run(handlers.read_file({ path: "src/../../etc/passwd" }))
		expect(failureOf(result)).toContain("leaves the repository")
		expect(calls).toEqual([])
	})

	it("answers a missing file with tracked files of the same name", async () => {
		const result = await run(handlers.read_file({ path: "packages/api/gone.ts" }))
		const message = failureOf(result) ?? ""
		expect(message).toContain("lib/gone.ts")
		expect(message).toContain("tools/x/gone.ts")
	})

	it("answers a directory with its listing", async () => {
		const result = await run(handlers.read_file({ path: "src/" }))
		const listing = result._tag === "Success" ? result.success : ""
		expect(listing).toContain("src is a directory")
		expect(listing.split("\n").slice(1)).toEqual(["src/a.ts", "src/b.ts"])
	})

	it("answers a skill reference file as method text, without listing the repository", async () => {
		calls.length = 0
		const result = await run(handlers.read_file({ path: "packages/ai/../skill/RECURSION.md" }))
		expect(failureOf(result)).toContain("RECURSION.md is the audit's own method text")
		expect(calls.map((c) => c.tool)).toEqual(["read"])
	})
})
