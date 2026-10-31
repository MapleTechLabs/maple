import type { RepoSandboxServiceApi } from "@maple/backend/services/sandbox/RepoSandboxService"
import { OrgId } from "@maple/domain/http"
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { sandboxSource } from "./sandbox-source"

const result = (exitCode: number, stdout: string, stderr = "") =>
	Effect.succeed({ exitCode, stdout, stderr, wallTimeMs: 1, truncated: false })

const source = (exitCode: number) =>
	sandboxSource(
		{
			prepare: () => Effect.void,
			exec: () => result(exitCode, "", "fatal: bad revision"),
			grep: () => result(exitCode, "", "fatal: command line, '(': Unmatched ( or \\("),
			listFiles: () => result(exitCode, "a.ts\n"),
			readFile: () => result(exitCode, "1\tx", "fatal: path 'b.ts' does not exist"),
		} satisfies RepoSandboxServiceApi,
		Schema.decodeUnknownSync(OrgId)("org_a"),
		{ repository: "acme/api", ref: "a".repeat(40) },
	)

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.result(effect))

describe("sandboxSource", () => {
	it("reports a failed read to the model instead of an empty answer", async () => {
		const read = await run(source(128).readFile("b.ts", 1, 10))
		const grep = await run(source(128).grep("(", undefined))
		expect([read, grep].map((r) => (r._tag === "Failure" ? r.failure.message : "ok"))).toEqual([
			"cannot read b.ts (exit 128): fatal: path 'b.ts' does not exist",
			"grep failed (exit 128): fatal: command line, '(': Unmatched ( or \\(",
		])
	})

	it("answers grep's no-match exit as an empty result", async () => {
		const grep = await run(source(1).grep("nothing", undefined))
		expect(grep._tag === "Success" ? grep.success : undefined).toEqual({ text: "", truncated: false })
	})
})
