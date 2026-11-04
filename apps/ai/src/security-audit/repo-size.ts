/**
 * The size check at prepare: a repository over any limit is refused whole, never partially scanned
 * and reported as covered. One bounded command measures the pinned commit in the sandbox.
 */
import type { SecurityAuditLimits } from "@maple/backend/services/security-audit/limits"
import { Option, Schema, Array as Arr, String as Str } from "effect"

export interface RepoSize {
	/** Commits reachable from the pinned commit. */
	readonly commits: number
	/** Tracked files (blobs) at the pinned commit. */
	readonly files: number
	/** Their total size in bytes. */
	readonly bytes: number
	/** Files `.gitattributes` routes through Git LFS: pointers in the checkout, not content. */
	readonly lfsFiles: number
	/** Those of them that look like source or config, which an audit would need to read. */
	readonly lfsSourceFiles: number
	/** A few of their paths, for the refusal to name. */
	readonly lfsSourceExamples: ReadonlyArray<string>
}

/** Code and config an audit reads; any other LFS file (media, models, archives) is skipped. */
const SOURCE_EXTENSIONS =
	"ts tsx js jsx mjs cjs py rb go rs java kt kts scala swift m mm c cc cpp cxx h hh hpp cs php " +
	"sh bash zsh ps1 sql lua dart ex exs erl clj vue svelte yaml yml toml tf hcl gradle properties ini conf cfg env"
const SOURCE_NAMES = "dockerfile makefile gemfile jenkinsfile"
const SOURCE_PATH = `(^|\\/)(${Str.replaceAll(" ", "|")(SOURCE_NAMES)})$|\\.(${Str.replaceAll(" ", "|")(SOURCE_EXTENSIONS)})$`
const MAX_LFS_SOURCE_EXAMPLES = 3

/** The run refused its repository before any agent started; `message` is the reason it is marked failed with. */
export class AuditRepositoryRefusedError extends Schema.TaggedError<AuditRepositoryRefusedError>()(
	"@maple/ai/security-audit/RepositoryRefusedError",
	{ message: Schema.String, violations: Schema.Array(Schema.String) },
) {}

/**
 * The probe's command: prints `<commits> <files> <bytes> <lfs files> <lfs source files>` on one
 * line, then up to three of those source paths, one per line.
 */
export const REPO_SIZE_COMMAND = {
	command: "bash",
	args: [
		"-c",
		Arr.join(
			[
				// The sandbox runs this with bash: pipefail makes a failing git fail the probe, not read as 0.
				"set -euo pipefail",
				"commits=$(git --no-optional-locks rev-list --count HEAD)",
				`tree=$(git --no-optional-locks ls-tree -r -l HEAD | awk '$2 == "blob" { n++; s += $4 } END { printf "%d %.0f", n, s }')`,
				`lfs=$(git --no-optional-locks -c core.quotePath=false ls-files -- ':(attr:filter=lfs)' | awk '{ n++; if (tolower($0) ~ /${SOURCE_PATH}/) { s++; if (s <= ${MAX_LFS_SOURCE_EXAMPLES}) ex[s] = $0 } } END { printf "%d %d", n, s; for (i = 1; i <= s && i <= ${MAX_LFS_SOURCE_EXAMPLES}; i++) printf "\\n%s", ex[i] }')`,
				'echo "$commits $tree $lfs"',
			],
			"\n",
		),
	],
} as const

const COUNT = /^\d+$/

/** The probe's output as a size; None for anything else (a failed or cut probe proves nothing). */
export const parseRepoSize = (stdout: string): Option.Option<RepoSize> => {
	const [line, ...examples] = Str.split("\n")(Str.trim(stdout))
	const parts = Str.split(/\s+/)(Str.trim(line))
	if (parts.length !== 5 || !Arr.every(parts, (part) => COUNT.test(part))) return Option.none()
	const [commits, files, bytes, lfsFiles, lfsSourceFiles] = Arr.map(parts, Number)
	return commits === undefined ||
		files === undefined ||
		bytes === undefined ||
		lfsFiles === undefined ||
		lfsSourceFiles === undefined
		? Option.none()
		: Option.some({
				commits,
				files,
				bytes,
				lfsFiles,
				lfsSourceFiles,
				lfsSourceExamples: Arr.filter(examples, (path) => path !== ""),
			})
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
	...(size.lfsSourceFiles > limits.maxLfsSourceFiles
		? [
				`it stores ${size.lfsSourceFiles} source files in Git LFS, whose content the checkout does not hold (limit ${limits.maxLfsSourceFiles}; for example ${Arr.join(size.lfsSourceExamples, ", ")})`,
			]
		: []),
]

/** The run's note for LFS files it skips: media and other binaries, read as pointers only. */
export const lfsSkippedNote = (lfsFiles: number): Option.Option<string> =>
	lfsFiles > 0
		? Option.some(
				`${lfsFiles} files stored in Git LFS were not audited: they are not source code, and the checkout holds their pointers, not their content.`,
			)
		: Option.none()

/** The pre-clone check: the size GitHub reports, before the sandbox fetches any history. */
export const hostedSizeViolations = (bytes: number, limits: SecurityAuditLimits): ReadonlyArray<string> =>
	bytes > limits.maxRepositoryBytes
		? [`GitHub reports it at ${mib(bytes)}, over the ${mib(limits.maxRepositoryBytes)} limit`]
		: []

/** The failure reason a refused run is marked with. */
export const refusalReason = (violations: ReadonlyArray<string>): string =>
	`repository_refused: the repository was not audited because ${Arr.join(violations, "; ")}.`
