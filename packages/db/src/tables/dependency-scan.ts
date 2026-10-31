import * as PG from "@maple-dev/effect-orm/postgres"
import {
	DependencyFindingId,
	DependencyFindingStatus,
	DependencyRelation,
	DependencyScanId,
	DependencyScanLockfile,
	DependencyScanStatus,
	DependencyScanTrigger,
} from "@maple/domain/dependency-scan"
import { GitCommitSha, VcsRepositoryId } from "@maple/domain/http/vcs"
import { AdvisorySeverity, PackageEcosystem } from "@maple/domain/package-advisories"
import { OrgId, UserId } from "@maple/domain/primitives"
import { Schema } from "effect"

// Dependency vulnerability scans. No FKs (house style): the store enforces the links and always
// filters by org.

const Strings = Schema.Array(Schema.String)

/** One scan of a repository's lockfiles at one commit. Only a default-branch head reconciles findings. */
export const DependencyScans = PG.table("dependency_scans", {
	columns: {
		id: PG.brand(PG.text, DependencyScanId),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		repositoryId: PG.column(PG.brand(PG.text, VcsRepositoryId), { name: "repository_id" }),
		commitSha: PG.column(PG.brand(PG.text, GitCommitSha), { name: "commit_sha" }),
		/** The branch the commit was scanned on; null for a bare commit. */
		ref: PG.nullable(PG.text),
		trigger: PG.brand(PG.text, DependencyScanTrigger),
		defaultBranchHead: PG.column(PG.bool, { name: "default_branch_head" }),
		status: PG.column(PG.brand(PG.text, DependencyScanStatus), { default: "running" }),
		lockfiles: PG.jsonb(Schema.Array(DependencyScanLockfile)),
		packageCount: PG.column(PG.int4, { name: "package_count", default: 0 }),
		vulnerableCount: PG.column(PG.int4, { name: "vulnerable_count", default: 0 }),
		error: PG.nullable(PG.text),
		startedAt: PG.column(PG.timestamptzMillis, { name: "started_at" }),
		finishedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "finished_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.index("dependency_scans_org_started_idx", ["orgId", "startedAt"]),
		PG.index("dependency_scans_repo_started_idx", ["repositoryId", "startedAt"]),
		PG.index("dependency_scans_repo_commit_idx", ["repositoryId", "commitSha"]),
	],
	tenantColumn: "orgId",
})

/** The vulnerable packages one scan found, kept per scan so an older commit's exposure stays readable. */
export const DependencyScanMatches = PG.table("dependency_scan_matches", {
	columns: {
		scanId: PG.column(PG.brand(PG.text, DependencyScanId), { name: "scan_id" }),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		lockfilePath: PG.column(PG.text, { name: "lockfile_path" }),
		ecosystem: PG.brand(PG.text, PackageEcosystem),
		packageName: PG.column(PG.text, { name: "package_name" }),
		version: PG.text,
		relation: PG.brand(PG.text, DependencyRelation),
		/** The OSV id. */
		advisoryId: PG.column(PG.text, { name: "advisory_id" }),
		aliases: PG.jsonb(Strings),
		severity: PG.brand(PG.text, AdvisorySeverity),
		summary: PG.nullable(PG.text),
		fixedIn: PG.column(PG.nullable(PG.text), { name: "fixed_in" }),
	},
	primaryKey: ["scanId", "lockfilePath", "ecosystem", "packageName", "version", "advisoryId"],
	indexes: [PG.index("dependency_scan_matches_org_scan_idx", ["orgId", "scanId"])],
	tenantColumn: "orgId",
})

/**
 * An advisory on a package in one lockfile of a repository, followed across default-branch scans.
 * A `fixed` finding that comes back reopens; a dismissed or accepted one never does.
 */
export const DependencyFindings = PG.table("dependency_findings", {
	columns: {
		id: PG.brand(PG.text, DependencyFindingId),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		repositoryId: PG.column(PG.brand(PG.text, VcsRepositoryId), { name: "repository_id" }),
		lockfilePath: PG.column(PG.text, { name: "lockfile_path" }),
		ecosystem: PG.brand(PG.text, PackageEcosystem),
		packageName: PG.column(PG.text, { name: "package_name" }),
		advisoryId: PG.column(PG.text, { name: "advisory_id" }),
		aliases: PG.jsonb(Strings),
		severity: PG.brand(PG.text, AdvisorySeverity),
		summary: PG.nullable(PG.text),
		/** The installed versions the advisory affects, as the latest scan saw them. */
		versions: PG.jsonb(Strings),
		fixedIn: PG.column(PG.nullable(PG.text), { name: "fixed_in" }),
		/** The strongest relation across `versions`. */
		relation: PG.brand(PG.text, DependencyRelation),
		status: PG.column(PG.brand(PG.text, DependencyFindingStatus), { default: "open" }),
		firstSeenScanId: PG.column(PG.brand(PG.text, DependencyScanId), { name: "first_seen_scan_id" }),
		lastSeenScanId: PG.column(PG.brand(PG.text, DependencyScanId), { name: "last_seen_scan_id" }),
		firstSeenSha: PG.column(PG.brand(PG.text, GitCommitSha), { name: "first_seen_sha" }),
		lastSeenSha: PG.column(PG.brand(PG.text, GitCommitSha), { name: "last_seen_sha" }),
		/** The scan that no longer matched it; cleared when it comes back. */
		fixedScanId: PG.column(PG.nullable(PG.brand(PG.text, DependencyScanId)), { name: "fixed_scan_id" }),
		fixedSha: PG.column(PG.nullable(PG.brand(PG.text, GitCommitSha)), { name: "fixed_sha" }),
		statusReason: PG.column(PG.nullable(PG.text), { name: "status_reason" }),
		statusChangedBy: PG.column(PG.nullable(PG.brand(PG.text, UserId)), { name: "status_changed_by" }),
		statusChangedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "status_changed_at" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.uniqueIndex("dependency_findings_key_idx", [
			"repositoryId",
			"lockfilePath",
			"ecosystem",
			"packageName",
			"advisoryId",
		]),
		PG.index("dependency_findings_org_status_idx", ["orgId", "status"]),
		PG.index("dependency_findings_org_updated_idx", ["orgId", "updatedAt"]),
	],
	tenantColumn: "orgId",
})

export type DependencyScanRow = PG.SelectRowOf<typeof DependencyScans>
export type DependencyScanMatchRow = PG.SelectRowOf<typeof DependencyScanMatches>
export type DependencyFindingRow = PG.SelectRowOf<typeof DependencyFindings>
