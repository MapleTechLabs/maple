import { assert, describe, it } from "@effect/vitest"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { OrgId } from "@maple/domain/http"
import { Sandbox, SandboxExited, SandboxOutput, SandboxStarted } from "@effect-agent/sandbox/Sandbox"
import { Duration, Effect, Layer, Schema, Stream } from "effect"
import { gitPathspec, RepoSandboxService } from "./RepoSandboxService"
import { IMPLEMENTATION } from "./CloudflareRepoSandbox"

const ORG = Schema.decodeUnknownSync(OrgId)("org_git_test")

/**
 * A repository the tests run the real argument vectors against.
 *
 * This is the point of the file. Every other sandbox test stubs the container,
 * so a flag git does not have, or a pathspec that widens instead of narrows,
 * looks exactly like a passing test. Here git itself answers.
 */
const makeRepo = () => {
	const dir = mkdtempSync(`${tmpdir()}/maple-git-`)
	const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" })
	execFileSync("git", ["init", "--quiet", "-b", "main", dir])
	git("config", "user.email", "t@example.com")
	git("config", "user.name", "Test")
	mkdirSync(`${dir}/src/deep`, { recursive: true })
	writeFileSync(`${dir}/src/checkout.ts`, "export const checkout = 1\nthrow new Error('card declined')\n")
	writeFileSync(`${dir}/src/deep/nested.ts`, "// card declined lives here too\n")
	writeFileSync(`${dir}/other.txt`, "card declined outside src\n")
	writeFileSync(`${dir}/README.md`, "# shop\n")
	git("add", "-A")
	git("commit", "--quiet", "-m", "first")
	return dir
}

/**
 * The `Sandbox` port, backed by real `git` in a real checkout instead of a
 * container. The command and arguments are exactly what the service built.
 */
const localSandbox = (repo: string, seen: string[][] = []): Layer.Layer<Sandbox> =>
	Layer.succeed(Sandbox, {
		execute: (request) =>
			Stream.unwrap(
				Effect.sync(() => {
					seen.push([request.command, ...request.args])
					const cwd = request.cwd === "/workspace" ? repo : `${repo}/${request.cwd.slice(11)}`
					let stdout = ""
					let exitCode = 0
					try {
						stdout = execFileSync(request.command, [...request.args], { cwd, encoding: "utf8" })
					} catch (error) {
						const failure = error as { status?: number; stdout?: string }
						exitCode = failure.status ?? 1
						stdout = failure.stdout ?? ""
					}
					return Stream.fromIterable([
						new SandboxStarted({
							eventVersion: 1,
							implementation: IMPLEMENTATION,
							runtime: request.runtime,
						}),
						...(stdout.length > 0
							? [
									new SandboxOutput({
										eventVersion: 1,
										implementation: IMPLEMENTATION,
										stream: "stdout" as const,
										text: stdout,
										bytes: Buffer.byteLength(stdout),
									}),
								]
							: []),
						new SandboxExited({
							eventVersion: 1,
							implementation: IMPLEMENTATION,
							exitCode,
							resourceUse: {
								wallTime: Duration.millis(1),
								stdoutBytes: Buffer.byteLength(stdout),
								stderrBytes: 0,
							} as ConstructorParameters<typeof SandboxExited>[0]["resourceUse"],
							artifacts: [],
						}),
					])
				}),
			),
	})

/** The service over a real checkout, as one layer. */
const overRepo = () => RepoSandboxService.layer.pipe(Layer.provide(localSandbox(makeRepo())))

describe("gitPathspec", () => {
	it("combines a directory and a glob into one pattern, because git ORs separate pathspecs", () => {
		assert.deepStrictEqual(gitPathspec("src", "**/*.ts"), [":(glob)src/**/*.ts"])
		assert.deepStrictEqual(gitPathspec("src/", "*.ts"), [":(glob)src/*.ts"])
		assert.deepStrictEqual(gitPathspec("src", undefined), ["src"])
		assert.deepStrictEqual(gitPathspec(undefined, "**/*.ts"), [":(glob)**/*.ts"])
		assert.deepStrictEqual(gitPathspec(undefined, undefined), [])
	})
})

describe("the git commands the tools build, against a real repository", () => {
	it.effect("greps with flags this git actually has", () =>
		Effect.gen(function* () {
			const service = yield* RepoSandboxService
			const result = yield* service.grep(ORG, { repository: "octo/shop" }, { pattern: "card declined" })
			// Anything above 1 is git rejecting the command itself — an unknown option
			// is 129, which is how `--max-count` shipped broken.
			assert.isAtMost(result.exitCode, 1, result.stderr)
			assert.include(result.stdout, "src/checkout.ts:2:")
		}).pipe(Effect.provide(overRepo())),
	)

	it.effect("narrows with a path and a glob together, rather than widening", () =>
		Effect.gen(function* () {
			const service = yield* RepoSandboxService
			const result = yield* service.grep(
				ORG,
				{ repository: "octo/shop" },
				{ pattern: "card declined", path: "src", glob: "**/*.ts" },
			)
			assert.isAtMost(result.exitCode, 1, result.stderr)
			assert.include(result.stdout, "src/checkout.ts")
			assert.include(result.stdout, "src/deep/nested.ts")
			// Matches the glob but sits outside the path: including it would mean the
			// two filters were ORed.
			assert.notInclude(result.stdout, "other.txt")
		}).pipe(Effect.provide(overRepo())),
	)

	it.effect("exits 1 with no output when nothing matches, which is not an error", () =>
		Effect.gen(function* () {
			const service = yield* RepoSandboxService
			const result = yield* service.grep(ORG, { repository: "octo/shop" }, { pattern: "nothing here" })
			assert.strictEqual(result.exitCode, 1)
			assert.strictEqual(result.stdout, "")
		}).pipe(Effect.provide(overRepo())),
	)

	it.effect("lists tracked files, and narrows them the same way", () =>
		Effect.gen(function* () {
			const service = yield* RepoSandboxService
			const all = yield* service.listFiles(ORG, { repository: "octo/shop" }, {})
			assert.strictEqual(all.exitCode, 0, all.stderr)
			assert.include(all.stdout, "README.md")
			const scoped = yield* service.listFiles(
				ORG,
				{ repository: "octo/shop" },
				{ path: "src", glob: "**/*.ts" },
			)
			assert.include(scoped.stdout, "src/deep/nested.ts")
			assert.notInclude(scoped.stdout, "README.md")
		}).pipe(Effect.provide(overRepo())),
	)

	it.effect("reads a line range and reports the file's length", () =>
		Effect.gen(function* () {
			const service = yield* RepoSandboxService
			const result = yield* service.readFile(
				ORG,
				{ repository: "octo/shop" },
				{ path: "src/checkout.ts", startLine: 2, endLine: 2 },
			)
			assert.strictEqual(result.exitCode, 0, result.stderr)
			assert.include(result.stdout, "2: throw new Error('card declined')")
			assert.include(result.stdout, "__MAPLE_TOTAL_LINES__ 2")
		}).pipe(Effect.provide(overRepo())),
	)

	it.effect("refuses a path git does not track, so a symlink cannot leave the checkout", () =>
		Effect.gen(function* () {
			const service = yield* RepoSandboxService
			const result = yield* service.readFile(
				ORG,
				{ repository: "octo/shop" },
				{ path: "untracked-link", startLine: 1, endLine: 10 },
			)
			assert.notStrictEqual(result.exitCode, 0)
		}).pipe(Effect.provide(overRepo())),
	)
})
