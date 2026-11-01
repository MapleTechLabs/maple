/**
 * Identifiers and states of the dependency scanner: a scan reads a repository's lockfiles at one
 * commit, matches the packages against OSV advisories, and follows each match as a finding.
 */
import { Schema } from "effect"
import { GitCommitSha, VcsRepositoryId } from "./http/vcs"
import { UserId } from "./primitives"
import { AdvisorySeverity, PackageEcosystem } from "./package-advisories"
import { SecurityAuditFindingStatus } from "./security-audit"

export const DependencyScanId = Schema.String.check(Schema.isUUID()).pipe(
	Schema.brand("@maple/DependencyScanId"),
	Schema.annotate({ identifier: "@maple/DependencyScanId", title: "Dependency Scan ID" }),
)
export type DependencyScanId = Schema.Schema.Type<typeof DependencyScanId>

/** Derived from the finding's key, so the same advisory on the same package keeps its id. */
export const DependencyFindingId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/u)).pipe(
	Schema.brand("@maple/DependencyFindingId"),
	Schema.annotate({ identifier: "@maple/DependencyFindingId", title: "Dependency Finding ID" }),
)
export type DependencyFindingId = Schema.Schema.Type<typeof DependencyFindingId>

/** What started a scan; only a default-branch head reconciles findings. */
export const DependencyScanTrigger = Schema.Literals(["push", "schedule", "manual", "production"])
export type DependencyScanTrigger = typeof DependencyScanTrigger.Type

export const DependencyScanStatus = Schema.Literals(["running", "completed", "failed"])
export type DependencyScanStatus = typeof DependencyScanStatus.Type

/** How the lockfile's root depends on the package; `unknown` where the format does not say. */
export const DependencyRelation = Schema.Literals(["direct", "dev", "transitive", "unknown"])
export type DependencyRelation = typeof DependencyRelation.Type

/** Lockfile formats, as `@maple/lockfiles` names them. */
export const DependencyLockfileKind = Schema.Literals([
	"package-lock",
	"pnpm-lock",
	"yarn-v1",
	"yarn-berry",
	"bun-lock",
	"bun-lockb",
	"go-mod",
	"go-sum",
	"cargo-lock",
])
export type DependencyLockfileKind = typeof DependencyLockfileKind.Type

/**
 * Only a `parsed` lockfile lets its findings be marked fixed when they are no longer matched.
 * `skipped` is past the lockfiles a scan reads.
 */
export const DependencyLockfileStatus = Schema.Literals([
	"parsed",
	"unsupported",
	"too_large",
	"failed",
	"skipped",
])
export type DependencyLockfileStatus = typeof DependencyLockfileStatus.Type

/** One lockfile a scan read, as stored on the scan row. */
export const DependencyScanLockfile = Schema.Struct({
	path: Schema.String,
	kind: DependencyLockfileKind,
	blobSha: Schema.String,
	packageCount: Schema.Int,
	status: DependencyLockfileStatus,
	message: Schema.NullOr(Schema.String),
})
export type DependencyScanLockfile = typeof DependencyScanLockfile.Type

/** The audit lifecycle: `fixed` reopens when the advisory comes back, a triaged one never does. */
export const DependencyFindingStatus = SecurityAuditFindingStatus
export type DependencyFindingStatus = SecurityAuditFindingStatus

/** What a person may set; `fixed` comes only from a scan that no longer matches it. */
export const DependencyFindingTriageStatus = Schema.Literals(["open", "dismissed", "accepted_risk"])
export type DependencyFindingTriageStatus = typeof DependencyFindingTriageStatus.Type

/** A finding on the wire; timestamps are epoch ms. */
export const DependencyFinding = Schema.Struct({
	id: DependencyFindingId,
	repositoryId: VcsRepositoryId,
	lockfilePath: Schema.String,
	ecosystem: PackageEcosystem,
	packageName: Schema.String,
	advisoryId: Schema.String,
	aliases: Schema.Array(Schema.String),
	severity: AdvisorySeverity,
	summary: Schema.optionalKey(Schema.String),
	/** The installed versions the advisory affects. */
	versions: Schema.Array(Schema.String),
	fixedIn: Schema.optionalKey(Schema.String),
	relation: DependencyRelation,
	status: DependencyFindingStatus,
	firstSeenScanId: DependencyScanId,
	lastSeenScanId: DependencyScanId,
	firstSeenSha: GitCommitSha,
	lastSeenSha: GitCommitSha,
	fixedScanId: Schema.optionalKey(DependencyScanId),
	fixedSha: Schema.optionalKey(GitCommitSha),
	statusReason: Schema.optionalKey(Schema.String),
	statusChangedBy: Schema.optionalKey(UserId),
	statusChangedAt: Schema.optionalKey(Schema.Finite),
	createdAt: Schema.Finite,
	updatedAt: Schema.Finite,
})
export type DependencyFinding = typeof DependencyFinding.Type
