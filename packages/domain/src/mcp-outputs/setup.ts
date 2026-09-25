/** Output schemas for the setup, source-code, repository sandbox and pull request MCP tools. */
import { Schema } from "effect"
import { OutputTimeRange } from "./shared"

// ---------------------------------------------------------------------------------------------
// audit_setup (mirrors AuditSetupData)

export const SetupAuditCheckRow = Schema.Struct({
	/** Stable check id, e.g. `CFG-ALERT-03`. */
	id: Schema.String,
	category: Schema.String,
	title: Schema.String,
	severity: Schema.Literals(["critical", "warn", "info"]),
	status: Schema.Literals(["pass", "fail", "skip"]),
	detail: Schema.NullOr(Schema.String),
	affected: Schema.Array(
		Schema.Struct({ kind: Schema.String, name: Schema.String, note: Schema.NullOr(Schema.String) }),
	),
	affectedCount: Schema.Number,
	fixHint: Schema.String,
})

export const AuditSetupOutput = Schema.Struct({
	generatedAt: Schema.String,
	/** `no_data` means the org has never received telemetry, so no check ran. */
	dataStatus: Schema.Literals(["ok", "no_data"]),
	telemetryChecksAvailable: Schema.Boolean,
	summary: Schema.Struct({
		critical: Schema.Number,
		warn: Schema.Number,
		info: Schema.Number,
		pass: Schema.Number,
		skip: Schema.Number,
	}),
	checks: Schema.Array(SetupAuditCheckRow),
	openRecommendationCount: Schema.Number,
	/** Whether passing and skipped checks were asked for, which decides what the text lists. */
	includePassing: Schema.optionalKey(Schema.Boolean),
})

// ---------------------------------------------------------------------------------------------
// get_instrumentation_recommendations (mirrors GetInstrumentationRecommendationsData)

export const InstrumentationRecommendationRow = Schema.Struct({
	id: Schema.String,
	number: Schema.Number,
	recommendationKey: Schema.String,
	kind: Schema.Literals(["rename", "double-emission", "naming"]),
	severity: Schema.Literals(["warn", "info"]),
	sourceKey: Schema.String,
	canonicalKey: Schema.NullOr(Schema.String),
	status: Schema.String,
	usageCount: Schema.Number,
	/** Only rename issues can be fixed by accepting an ingest attribute mapping. */
	applyableAsMapping: Schema.Boolean,
	openedAt: Schema.String,
	updatedAt: Schema.String,
})

export const InstrumentationCoverageGap = Schema.Struct({
	/** Check id from the maple-audit skill checklist (e.g. RES-03). */
	checkId: Schema.String,
	attribute: Schema.String,
	severity: Schema.Literal("warn"),
	reason: Schema.String,
})

export const GetInstrumentationRecommendationsOutput = Schema.Struct({
	issues: Schema.Array(InstrumentationRecommendationRow),
	coverage: Schema.Struct({
		available: Schema.Boolean,
		included: Schema.Boolean,
		timeRange: OutputTimeRange,
		gaps: Schema.Array(InstrumentationCoverageGap),
	}),
	total: Schema.Number,
	/** The status filter that applied: a recommendation status, or `all`. */
	statusFilter: Schema.optionalKey(Schema.String),
})

// ---------------------------------------------------------------------------------------------
// Source code (GitHub App reads)

export const ListSourceRepositoriesOutput = Schema.Struct({
	repositories: Schema.Array(
		Schema.Struct({
			provider: Schema.String,
			fullName: Schema.String,
			trackedBranch: Schema.String,
			defaultBranch: Schema.String,
			htmlUrl: Schema.String,
			isPrivate: Schema.Boolean,
			isArchived: Schema.Boolean,
		}),
	),
})

export const SearchSourceCodeOutput = Schema.Struct({
	repository: Schema.String,
	query: Schema.String,
	path: Schema.optionalKey(Schema.String),
	matches: Schema.Array(
		Schema.Struct({
			path: Schema.String,
			/** Blob SHA. */
			sha: Schema.String,
			htmlUrl: Schema.String,
			/** Up to two snippets, each clipped. */
			snippets: Schema.Array(Schema.String),
		}),
	),
})

export const ReadSourceFileOutput = Schema.Struct({
	repository: Schema.String,
	path: Schema.String,
	ref: Schema.String,
	/** Blob SHA. */
	sha: Schema.String,
	htmlUrl: Schema.String,
	startLine: Schema.Number,
	/** Last line returned; before `startLine` when the range starts past the end of the file. */
	endLine: Schema.Number,
	totalLines: Schema.Number,
	/** Lines exist past `endLine`. */
	truncated: Schema.Boolean,
	/** The source lines from `startLine`, unnumbered. */
	lines: Schema.Array(Schema.String),
})

// ---------------------------------------------------------------------------------------------
// Repository sandbox

const SandboxRun = {
	repository: Schema.String,
	/** The ref asked for; absent means the repository's tracked branch. */
	ref: Schema.optionalKey(Schema.String),
	exitCode: Schema.Number,
	wallTimeMs: Schema.Number,
}

export const SandboxGrepOutput = Schema.Struct({
	...SandboxRun,
	pattern: Schema.String,
	path: Schema.optionalKey(Schema.String),
	glob: Schema.optionalKey(Schema.String),
	caseSensitive: Schema.Boolean,
	contextLines: Schema.Number,
	/** `path:line:text` match lines (and `path-line-text` context lines), as git grep printed them. */
	lines: Schema.Array(Schema.String),
	/** Lines git grep printed, before the cap. */
	totalLines: Schema.Number,
})

export const SandboxListFilesOutput = Schema.Struct({
	...SandboxRun,
	path: Schema.optionalKey(Schema.String),
	glob: Schema.optionalKey(Schema.String),
	files: Schema.Array(Schema.String),
	/** Paths git listed, before the cap. */
	totalFiles: Schema.Number,
})

export const SandboxReadFileOutput = Schema.Struct({
	...SandboxRun,
	path: Schema.String,
	startLine: Schema.Number,
	endLine: Schema.Number,
	/** The file's length in lines, when the sandbox reported it. */
	totalLines: Schema.optionalKey(Schema.Number),
	/** `<line>: <text>` rows. */
	lines: Schema.Array(Schema.String),
})

export const SandboxExecOutput = Schema.Struct({
	...SandboxRun,
	command: Schema.String,
	args: Schema.Array(Schema.String),
	cwd: Schema.optionalKey(Schema.String),
	stdout: Schema.String,
	stderr: Schema.String,
	/** The container cut the output at its byte cap. */
	truncated: Schema.Boolean,
	maxOutputBytes: Schema.Number,
})

// ---------------------------------------------------------------------------------------------
// Pull requests (the review agent's reads)

export const ChangedFileKind = Schema.Literals([
	"source",
	"test",
	"generated",
	"docs",
	"config",
	"infra",
	"tooling",
	"lockfile",
])

const PullRequestFileStatus = Schema.Literals([
	"added",
	"modified",
	"removed",
	"renamed",
	"copied",
	"changed",
	"unchanged",
])

export const PrChangedFilesOutput = Schema.Struct({
	repository: Schema.String,
	number: Schema.Number,
	/** Every changed file, before the listing cap. */
	total: Schema.Number,
	byKind: Schema.Array(Schema.Struct({ kind: ChangedFileKind, count: Schema.Number })),
	/** Source, infra, config and test files: the ones a review reads. */
	reviewedCount: Schema.Number,
	files: Schema.Array(
		Schema.Struct({
			path: Schema.String,
			previousPath: Schema.NullOr(Schema.String),
			status: PullRequestFileStatus,
			additions: Schema.Number,
			deletions: Schema.Number,
			kind: ChangedFileKind,
			/** False when the provider withheld the patch (binary, or too large). */
			hasPatch: Schema.Boolean,
		}),
	),
})

export const PrContextOutput = Schema.Struct({
	repository: Schema.String,
	number: Schema.Number,
	commits: Schema.Array(Schema.Struct({ sha: Schema.String, message: Schema.String })),
	/** Every comment on the pull request, before the listing cap. */
	totalComments: Schema.Number,
	comments: Schema.Array(
		Schema.Struct({
			author: Schema.String,
			path: Schema.NullOr(Schema.String),
			line: Schema.NullOr(Schema.Number),
			/** Flattened to one line and clipped. */
			body: Schema.String,
		}),
	),
	/** Failing checks first. */
	checks: Schema.Array(
		Schema.Struct({
			name: Schema.String,
			status: Schema.String,
			conclusion: Schema.NullOr(Schema.String),
			title: Schema.NullOr(Schema.String),
		}),
	),
})

export const PrFileDiffOutput = Schema.Struct({
	repository: Schema.String,
	number: Schema.Number,
	files: Schema.Array(
		Schema.Struct({
			path: Schema.String,
			previousPath: Schema.NullOr(Schema.String),
			status: PullRequestFileStatus,
			additions: Schema.Number,
			deletions: Schema.Number,
			/** `<new-side line> <marker> <code>` rows; null when the provider gave no patch. */
			lines: Schema.NullOr(Schema.Array(Schema.String)),
			/** The diff was cut at the line or character cap. */
			truncated: Schema.Boolean,
		}),
	),
	/** Requested paths this pull request does not change. */
	notChanged: Schema.Array(Schema.String),
	/** Requested paths left out to keep the answer readable; ask for them in another call. */
	deferred: Schema.Array(Schema.String),
	/** The line cap a truncated diff was cut at. */
	maxDiffLines: Schema.Number,
})
