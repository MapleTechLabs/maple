import * as Policy from "@maple/domain/policy"
import {
	DependencyFindingsResponse,
	DependencyFindingView,
	DependencyScanRepositoriesResponse,
	VcsRepositoryId,
} from "@maple/domain/http"
import {
	DependencyFindingId,
	DependencyFindingTriageStatus,
	DependencyScanId,
} from "@maple/domain/dependency-scan"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as Combobox from "@maple/views/ui/combobox"
import * as Dialog from "@maple/views/ui/dialog"
import * as Field from "@maple/views/ui/field"
import * as Select from "@maple/views/ui/select"

// `/security/dependencies`: the connected repositories' latest lockfile scans and the vulnerable
// packages they found. Every finding is read once; the filters narrow it on the client.

export const StatusFilter = Schema.Literals(["open", "dismissed", "accepted_risk", "fixed", "all"])
export type StatusFilter = typeof StatusFilter.Type

/** The scope's main view (the matrix, or a repository's upgrade plan), the repositories, or the advisories. */
export const Pane = Schema.Literals(["summary", "repositories", "advisories"])
export type Pane = typeof Pane.Type

/** A scan someone asked for: polled until the repository's latest scan is a newer, finished one. */
export const PendingScan = Schema.Struct({
	repositoryId: VcsRepositoryId,
	requestedAtMs: Schema.Finite,
	/** The latest scan when it was asked for; null before the first. */
	previousScanId: Schema.NullOr(DependencyScanId),
})
export type PendingScan = typeof PendingScan.Type

export const Model = Schema.Struct({
	nowMs: Schema.Finite,
	grants: Schema.Array(Policy.PermissionName),
	repositories: KeyedSchema(DependencyScanRepositoriesResponse, LoadFailure),
	findings: KeyedSchema(DependencyFindingsResponse, LoadFailure),
	statusSelect: Select.Model,
	/** The repository the URL scopes the page to; "all" for every one. */
	scope: Schema.String,
	/** The scope switcher: its items are "All repositories" and each repository's full name. */
	repositoryBox: Combobox.Model,
	pane: Pane,
	/** Matrix rows opened to list the repositories that have the package. */
	expandedPackages: Schema.Array(Schema.String),
	/** Opened rows past their first page of repositories, showing every one. */
	fullPackages: Schema.Array(Schema.String),
	/** How many rows the repositories and advisories tables render. */
	shownRows: Schema.Finite,
	/** Repositories whose Scan now request is in flight. */
	requestingScans: Schema.Array(VcsRepositoryId),
	pendingScans: Schema.Array(PendingScan),
	/** The finding the detail sheet shows. */
	selectedId: Schema.NullOr(DependencyFindingId),
	sheet: Dialog.Model,
	reason: Field.Model,
	isReasonSubmitted: Schema.Boolean,
	savingStatus: Schema.NullOr(DependencyFindingTriageStatus),
})
export type Model = typeof Model.Type

/** The viewer may change what this page edits (`security:manage`). */
export const canManage = (model: Pick<Model, "grants">): boolean =>
	Policy.has(model.grants, "security:manage")

const result = <S extends Schema.Top>(schema: S) => ({
	key: Schema.String,
	result: Schema.Result(schema, LoadFailure),
})

export const Message = defineMessageUnion({
	ReadClock: { nowMs: Schema.Finite },
	CompletedReadGrants: { grants: Schema.Array(Policy.PermissionName) },
	CompletedFetchRepositories: result(DependencyScanRepositoriesResponse),
	CompletedFetchFindings: result(DependencyFindingsResponse),
	ClickedRetry: {},
	ClickedScanNow: { repositoryId: VcsRepositoryId },
	CompletedScanRequest: {
		repositoryId: VcsRepositoryId,
		result: Schema.Result(Schema.Struct({ queued: Schema.Boolean }), LoadFailure),
	},
	TickedScanPoll: { nowMs: Schema.Finite },
	GotStatusSelectMessage: { message: Select.Message },
	GotRepositoryBoxMessage: { message: Combobox.Message },
	ClickedPackage: { key: Schema.String },
	ClickedShowAllRepositories: { key: Schema.String },
	ClickedShowMoreRows: {},
	ClickedFinding: { findingId: DependencyFindingId },
	/** An advisory link inside a row: it opens OSV, not the row's sheet. */
	ClickedAdvisoryLink: {},
	GotSheetMessage: { message: Dialog.Message },
	GotReasonMessage: { message: Field.Message },
	ClickedTriage: { status: DependencyFindingTriageStatus },
	CompletedTriage: { result: Schema.Result(DependencyFindingView, LoadFailure) },
})
export type Message = typeof Message.Type
