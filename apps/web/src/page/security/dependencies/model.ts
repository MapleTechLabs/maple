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
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import * as Dialog from "../../../ui/dialog"
import * as Field from "../../../ui/field"
import * as Select from "../../../ui/select"

// `/security/dependencies`: the connected repositories' latest lockfile scans and the vulnerable
// packages they found. Every finding is read once; the filters narrow it on the client.

export const StatusFilter = Schema.Literals(["open", "dismissed", "accepted_risk", "fixed", "all"])
export type StatusFilter = typeof StatusFilter.Type

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
	isAdmin: Schema.Boolean,
	repositories: KeyedSchema(DependencyScanRepositoriesResponse, LoadFailure),
	findings: KeyedSchema(DependencyFindingsResponse, LoadFailure),
	statusSelect: Select.Model,
	repositorySelect: Select.Model,
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

const result = <S extends Schema.Top>(schema: S) => ({
	key: Schema.String,
	result: Schema.Result(schema, LoadFailure),
})

export const Message = defineMessageUnion({
	ReadClock: { nowMs: Schema.Finite },
	CompletedReadIsAdmin: { isAdmin: Schema.Boolean },
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
	GotRepositorySelectMessage: { message: Select.Message },
	ClickedFinding: { findingId: DependencyFindingId },
	/** An advisory link inside a row: it opens OSV, not the row's sheet. */
	ClickedAdvisoryLink: {},
	GotSheetMessage: { message: Dialog.Message },
	GotReasonMessage: { message: Field.Message },
	ClickedTriage: { status: DependencyFindingTriageStatus },
	CompletedTriage: { result: Schema.Result(DependencyFindingView, LoadFailure) },
})
export type Message = typeof Message.Type
