/**
 * `SourceReader` over the repository sandbox: the same git reads the local runner makes, run in the
 * org's checkout of the pinned commit, unprivileged and without network.
 */
import type { OrgId } from "@maple/domain/http"
import type {
	RepoSandboxServiceApi,
	RepositoryTarget,
	SandboxCommandResult,
} from "@maple/backend/services/sandbox/RepoSandboxService"
import { Effect } from "effect"
import { SourceReadError, type SourceOutput, type SourceReaderApi } from "./source"

const failure = (what: string) => (error: { readonly message: string }) =>
	new SourceReadError({ message: `${what}: ${error.message}` })

/**
 * A command's output, or its failure as a read error the model sees: an invalid pattern or an
 * untracked path must never read as "(no output)", which a hunter could take as evidence.
 */
const output =
	(what: string, okExit: (code: number) => boolean) =>
	(result: SandboxCommandResult): Effect.Effect<SourceOutput, SourceReadError> =>
		okExit(result.exitCode)
			? Effect.succeed({ text: result.stdout, truncated: result.truncated })
			: Effect.fail(
					new SourceReadError({
						message: `${what} (exit ${result.exitCode}): ${result.stderr.trim().slice(0, 300)}`,
					}),
				)

const zero = (code: number) => code === 0

export const sandboxSource = (
	sandbox: RepoSandboxServiceApi,
	orgId: OrgId,
	/** `ref` is the full commit sha the run is pinned to. */
	target: RepositoryTarget & { readonly ref: string },
): SourceReaderApi => ({
	readFile: (path, startLine, endLine) =>
		sandbox
			.readFile(orgId, target, { path, startLine, endLine })
			.pipe(
				Effect.mapError(failure(`cannot read ${path}`)),
				Effect.flatMap(output(`cannot read ${path}`, zero)),
			),
	grep: (pattern, path) =>
		sandbox.grep(orgId, target, { pattern, path, contextLines: 0 }).pipe(
			Effect.mapError(failure("grep failed")),
			// git grep exits 1 for no matches, which is an answer, not a failure.
			Effect.flatMap(output("grep failed", (code) => code <= 1)),
		),
	listFiles: (path) =>
		sandbox
			.listFiles(orgId, target, { path })
			.pipe(
				Effect.mapError(failure("cannot list files")),
				Effect.flatMap(output("cannot list files", zero)),
			),
	log: (path) =>
		sandbox
			.exec(orgId, target, {
				command: "git",
				args: [
					"log",
					"--format=%h %ad %s",
					"--date=short",
					"-n",
					"40",
					"HEAD",
					"--",
					...(path === undefined ? [] : [path]),
				],
			})
			.pipe(Effect.mapError(failure("git log failed")), Effect.flatMap(output("git log failed", zero))),
})
