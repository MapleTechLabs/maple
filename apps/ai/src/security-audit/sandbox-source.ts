/**
 * `SourceReader` over the repository sandbox: the same git reads the local runner makes, run in the
 * org's checkout of the pinned commit, unprivileged and without network.
 */
import type { OrgId } from "@maple/domain/http"
import type {
	RepoSandboxServiceApi,
	RepositoryTarget,
} from "@maple/backend/services/sandbox/RepoSandboxService"
import { Effect } from "effect"
import { SourceReadError, type SourceReaderApi } from "./source"

const failure = (what: string) => (error: { readonly message: string }) =>
	new SourceReadError({ message: `${what}: ${error.message}` })

export const sandboxSource = (
	sandbox: RepoSandboxServiceApi,
	orgId: OrgId,
	/** `ref` is the full commit sha the run is pinned to. */
	target: RepositoryTarget & { readonly ref: string },
): SourceReaderApi => ({
	readFile: (path, startLine, endLine) =>
		sandbox.readFile(orgId, target, { path, startLine, endLine }).pipe(
			Effect.map((result) => ({ text: result.stdout, truncated: result.truncated })),
			Effect.mapError(failure(`cannot read ${path}`)),
		),
	grep: (pattern, path) =>
		sandbox.grep(orgId, target, { pattern, path, contextLines: 0 }).pipe(
			Effect.map((result) => ({ text: result.stdout, truncated: result.truncated })),
			Effect.mapError(failure("grep failed")),
		),
	listFiles: (path) =>
		sandbox.listFiles(orgId, target, { path }).pipe(
			Effect.map((result) => ({ text: result.stdout, truncated: result.truncated })),
			Effect.mapError(failure("cannot list files")),
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
			.pipe(
				Effect.map((result) => ({ text: result.stdout, truncated: result.truncated })),
				Effect.mapError(failure("git log failed")),
			),
})
