/**
 * The run's execution label, read at prepare: the manifests the pinned commit tracks and the few
 * config files that can name a private registry, submodule or local module. Labelling only, so a
 * failed read never fails the run; it says so in the label instead.
 */
import type { OrgId } from "@maple/domain/http"
import type {
	RepoSandboxServiceApi,
	RepositoryTarget,
} from "@maple/backend/services/sandbox/RepoSandboxService"
import {
	configFilesToRead,
	DEPENDENCY_PATHSPECS,
	type ExecutionProfile,
	executionProfile,
	scanDependencies,
} from "@maple/security-audit"
import { Effect } from "effect"

const GIT = ["--no-optional-locks", "-c", "core.quotePath=false"]

/** A label for a repository whose dependencies could not be read: still source-only, and why. */
const uninspected = (why: string): ExecutionProfile => ({
	mode: "source_only",
	ecosystems: [],
	privateDependencies: [],
	reasons: [
		"no execution sandbox for this repository's languages yet",
		`its dependencies could not be inspected (${why.slice(0, 300)})`,
	],
})

export const inspectDependencies = (
	sandbox: RepoSandboxServiceApi,
	orgId: OrgId,
	/** `ref` is the full commit sha the run is pinned to. */
	target: RepositoryTarget & { readonly ref: string },
): Effect.Effect<ExecutionProfile> =>
	Effect.gen(function* () {
		const listed = yield* sandbox.exec(orgId, target, {
			command: "git",
			args: [...GIT, "ls-files", "--cached", "--", ...DEPENDENCY_PATHSPECS],
		})
		if (listed.exitCode !== 0) return uninspected(`exit ${listed.exitCode}: ${listed.stderr.trim()}`)
		const lines = listed.stdout.split("\n").filter((line) => line.length > 0)
		// A cut listing's last line may be a partial path.
		const paths = listed.truncated ? lines.slice(0, -1) : lines
		const configs = yield* Effect.forEach(
			configFilesToRead(paths),
			(path) =>
				sandbox.exec(orgId, target, { command: "git", args: [...GIT, "show", `HEAD:${path}`] }).pipe(
					Effect.map((read) =>
						read.exitCode !== 0
							? { path, text: undefined, cut: false }
							: { path, text: read.truncated ? undefined : read.stdout, cut: read.truncated },
					),
					// One unreadable config file costs its own signals, not the label.
					Effect.orElseSucceed(() => ({ path, text: undefined, cut: false })),
				),
			{ concurrency: 4 },
		)
		const texts = new Map(
			configs.flatMap((config): ReadonlyArray<readonly [string, string]> =>
				config.text === undefined ? [] : [[config.path, config.text]],
			),
		)
		// A cut read is a prefix, so its file is uninspected rather than scanned as whole.
		const cut = configs.filter((config) => config.cut).map((config) => config.path)
		const profile = executionProfile(scanDependencies(paths, texts))
		return cut.length === 0
			? profile
			: {
					...profile,
					mode: "source_only" as const,
					reasons: [
						...profile.reasons,
						`config files too large to inspect in full (${cut.join(", ").slice(0, 300)})`,
					],
				}
	}).pipe(Effect.catch((error) => Effect.succeed(uninspected(error.message))))
