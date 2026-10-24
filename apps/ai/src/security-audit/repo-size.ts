/**
 * The size check at prepare: a repository over any limit is refused whole, never partially scanned
 * and reported as covered. One bounded command measures the pinned commit in the sandbox.
 */
import type { SecurityAuditLimits } from "@maple/backend/services/security-audit/limits"
import { Option, Schema } from "effect"

export interface RepoSize {
	/** Commits reachable from the pinned commit. */
	readonly commits: number
	/** Tracked files (blobs) at the pinned commit. */
	readonly files: number
	/** Their total size in bytes. */
	readonly bytes: number
	/** Files `.gitattributes` routes through Git LFS: pointers in the checkout, not content. */
	readonly lfsFiles: number
}

/** The run refused its repository before any agent started; `message` is the reason it is marked failed with. */
export class AuditRepositoryRefusedError extends Schema.TaggedError<AuditRepositoryRefusedError>()(
	"@maple/ai/security-audit/RepositoryRefusedError",
	{ message: Schema.String, violations: Schema.Array(Schema.String) },
) {}

/** The probe's command: prints `<commits> <files> <bytes> <lfs files>` on one line. */
export const REPO_SIZE_COMMAND = {
	command: "bash",
	args: [
		"-c",
		[
			// The sandbox runs this with bash: pipefail makes a failing git fail the probe, not read as 0.
			"set -euo pipefail",
			"commits=$(git --no-optional-locks rev-list --count HEAD)",
			`tree=$(git --no-optional-locks ls-tree -r -l HEAD | awk '$2 == "blob" { n++; s += $4 } END { printf "%d %.0f", n, s }')`,
			"lfs=$(git --no-optional-locks ls-files -- ':(attr:filter=lfs)' | wc -l)",
			'echo "$commits $tree $lfs"',
		].join("\n"),
	],
} as const

const COUNT = /^\d+$/

/** The probe's line as a size; None for anything else (a failed or cut probe proves nothing). */
export const parseRepoSize = (stdout: string): Option.Option<RepoSize> => {
	const parts = stdout.trim().split(/\s+/)
	if (parts.length !== 4 || !parts.every((part) => COUNT.test(part))) return Option.none()
	const [commits, files, bytes, lfsFiles] = parts.map(Number)
	return commits === undefined || files === undefined || bytes === undefined || lfsFiles === undefined
		? Option.none()
		: Option.some({ commits, files, bytes, lfsFiles })
}

const mib = (bytes: number) => `${Math.ceil(bytes / (1024 * 1024))} MiB`

/** Each limit the repository is over, as a sentence the run's failure reason carries. */
export const repoLimitViolations = (size: RepoSize, limits: SecurityAuditLimits): ReadonlyArray<string> => [
	// History but no files is a probe that read nothing, never an empty repository to pass.
	...(size.commits > 0 && size.files === 0
		? ["its pinned commit listed no files although it has history, so its size could not be trusted"]
		: []),
	...(size.bytes > limits.maxCheckoutBytes
		? [`its tracked files are ${mib(size.bytes)}, over the ${mib(limits.maxCheckoutBytes)} limit`]
		: []),
	...(size.files > limits.maxFiles
		? [`it tracks ${size.files} files, over the ${limits.maxFiles} limit`]
		: []),
	...(size.commits > limits.maxHistoryCommits
		? [`its history has ${size.commits} commits, over the ${limits.maxHistoryCommits} limit`]
		: []),
	...(size.lfsFiles > limits.maxLfsFiles
		? [
				`it stores ${size.lfsFiles} files in Git LFS, whose content the checkout does not hold (limit ${limits.maxLfsFiles})`,
			]
		: []),
]

/** The pre-clone check: the size GitHub reports, before the sandbox fetches any history. */
export const hostedSizeViolations = (bytes: number, limits: SecurityAuditLimits): ReadonlyArray<string> =>
	bytes > limits.maxRepositoryBytes
		? [`GitHub reports it at ${mib(bytes)}, over the ${mib(limits.maxRepositoryBytes)} limit`]
		: []

/** The failure reason a refused run is marked with. */
export const refusalReason = (violations: ReadonlyArray<string>): string =>
	`repository_refused: the repository was not audited because ${violations.join("; ")}.`
