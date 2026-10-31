import { assert, describe, it } from "@effect/vitest"
import type { RepoSandboxServiceApi } from "@maple/backend/services/sandbox/RepoSandboxService"
import { OrgId } from "@maple/domain/http"
import { EVERYTHING_CHANGED } from "@maple/security-audit"
import { Effect, Schema } from "effect"
import { changedPaths, MAX_CHANGED_PATHS } from "./changed-paths"

const orgId = Schema.decodeUnknownSync(OrgId)("org_a")
const target = { repository: "acme/api", ref: "b".repeat(40) }

const parent = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")))

/**
 * Git over a fixed change, cutting any answer longer than `maxBytes` as the container does.
 * Only the pathspec forms the walk uses are understood.
 */
const fakeGit = (changed: ReadonlyArray<string>, maxBytes: number) => {
	const calls: Array<string> = []
	const dirs = new Set(
		changed.flatMap((path) =>
			path
				.split("/")
				.slice(0, -1)
				.map((_, i, parts) => parts.slice(0, i + 1).join("/")),
		),
	)
	const answer = (paths: ReadonlyArray<string>) => {
		const stdout = paths.map((p) => `${p}\n`).join("")
		return Effect.succeed({
			exitCode: 0,
			stdout: stdout.slice(0, maxBytes),
			stderr: "",
			wallTimeMs: 1,
			truncated: stdout.length > maxBytes,
		})
	}
	const sandbox: RepoSandboxServiceApi = {
		prepare: () => Effect.void,
		grep: () => answer([]),
		listFiles: () => answer([]),
		readFile: () => answer([]),
		exec: (_org, _target, options) =>
			Effect.suspend(() => {
				const args = options.args.slice(3)
				calls.push(args.join(" "))
				const spec = args.at(-1) ?? ""
				if (args.includes("ls-tree")) {
					const dir = args.includes("--") ? spec.replace(/\/$/, "") : ""
					return answer([...dirs].filter((d) => parent(d) === dir))
				}
				if (spec === "--") return answer(changed)
				if (spec.startsWith(":(literal)"))
					return answer(changed.filter((p) => p.startsWith(`${spec.slice(10)}/`)))
				const dir = spec === ":(glob)*" ? "" : spec.slice(7, -2)
				return answer(changed.filter((p) => parent(p) === dir))
			}),
	}
	return { sandbox, calls }
}

describe("changedPaths", () => {
	it.effect("reads a change past the output bound in full by splitting it by directory", () =>
		Effect.gen(function* () {
			const changed = [
				"README.md",
				...Array.from({ length: 10 }, (_, i) => `src/a/file${i}.ts`),
				...Array.from({ length: 10 }, (_, i) => `src/b/file${i}.ts`),
				"src/index.ts",
			]
			const { sandbox } = fakeGit(changed, 200)
			const paths = yield* changedPaths(sandbox, orgId, target, "a".repeat(40))
			assert.deepStrictEqual([...paths].sort(), [...changed].sort())
		}),
	)

	it.effect("answers with one diff when the change fits", () =>
		Effect.gen(function* () {
			const { sandbox, calls } = fakeGit(["src/a.ts"], 48 * 1024)
			const paths = yield* changedPaths(sandbox, orgId, target, "a".repeat(40))
			assert.deepStrictEqual([paths, calls.length], [["src/a.ts"], 1])
		}),
	)

	it.effect("counts everything changed when one directory alone is past the bound", () =>
		Effect.gen(function* () {
			const changed = Array.from({ length: 50 }, (_, i) => `src/file${i}.ts`)
			const { sandbox } = fakeGit(changed, 200)
			assert.deepStrictEqual(yield* changedPaths(sandbox, orgId, target, "a".repeat(40)), [
				EVERYTHING_CHANGED,
			])
		}),
	)

	it.effect("counts everything changed past the path cap", () =>
		Effect.gen(function* () {
			const changed = Array.from({ length: MAX_CHANGED_PATHS + 1 }, (_, i) => `pkg${i % 40}/f${i}.ts`)
			const { sandbox } = fakeGit(changed, 48 * 1024)
			assert.deepStrictEqual(yield* changedPaths(sandbox, orgId, target, "a".repeat(40)), [
				EVERYTHING_CHANGED,
			])
		}),
	)
})
