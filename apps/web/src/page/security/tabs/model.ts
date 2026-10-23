import {
	GithubIntegrationStatus,
	SecurityAuditFindingsResponse,
	SecurityAuditRun,
	SecurityAuditRunDetail,
	SecurityAuditRunsResponse,
	SecurityAuditTargetsResponse,
} from "@maple/domain/http"
import { SecurityAuditRunId, SecurityAuditTargetId } from "@maple/domain/security-audit"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import { SecurityFindingsSearch, SecurityRunsSearch } from "../../../route/search"
import * as Select from "../../../ui/select"
import * as AddTarget from "../kit/add-target"

// `/security`, `/security/findings` and `/security/runs` as one page instance: the three tabs read
// the same targets, runs and findings, so a tab change reuses what the last one read.

export const Tab = Schema.Literals(["overview", "findings", "runs"])
export type Tab = typeof Tab.Type

export const FindingGroup = Schema.Literals(["confirmed", "needs_validation", "rejected"])
export type FindingGroup = typeof FindingGroup.Type

export const Model = Schema.Struct({
	tab: Tab,
	findingsSearch: SecurityFindingsSearch,
	runsSearch: SecurityRunsSearch,
	nowMs: Schema.Finite,
	/** `useIsOrgAdmin`: hides writes a member would be refused. The server still decides. */
	isAdmin: Schema.Boolean,
	targets: KeyedSchema(SecurityAuditTargetsResponse, LoadFailure),
	runs: KeyedSchema(SecurityAuditRunsResponse, LoadFailure),
	/** One read per target; findings are listed per target. */
	findings: Schema.Record(Schema.String, KeyedSchema(SecurityAuditFindingsResponse, LoadFailure)),
	/** Each target's latest run with its coverage counts. */
	latestRuns: Schema.Record(Schema.String, KeyedSchema(SecurityAuditRunDetail, LoadFailure)),
	githubStatus: KeyedSchema(GithubIntegrationStatus, LoadFailure),
	addTarget: AddTarget.Model,
	startingTargetId: Schema.NullOr(SecurityAuditTargetId),
	searchDraft: Schema.String,
	severitySelect: Select.Model,
	verdictSelect: Select.Model,
	targetSelect: Select.Model,
	runsTargetSelect: Select.Model,
	/** Groups showing every row instead of the first page. */
	expanded: Schema.Array(FindingGroup),
})
export type Model = typeof Model.Type

const result = <S extends Schema.Top>(schema: S) => ({
	key: Schema.String,
	result: Schema.Result(schema, LoadFailure),
})

export const Message = defineMessageUnion({
	ReadClock: { nowMs: Schema.Finite },
	CompletedReadIsAdmin: { isAdmin: Schema.Boolean },
	CompletedFetchTargets: result(SecurityAuditTargetsResponse),
	CompletedFetchRuns: result(SecurityAuditRunsResponse),
	CompletedFetchFindings: { targetId: SecurityAuditTargetId, ...result(SecurityAuditFindingsResponse) },
	CompletedFetchLatestRun: { runId: SecurityAuditRunId, ...result(SecurityAuditRunDetail) },
	CompletedFetchGithubStatus: result(GithubIntegrationStatus),
	TickedPoll: { nowMs: Schema.Finite },
	ClickedRetry: {},
	ClickedAddTarget: {},
	GotAddTargetMessage: { message: AddTarget.Message },
	ClickedStartRun: { targetId: SecurityAuditTargetId },
	CompletedStartRun: {
		targetId: SecurityAuditTargetId,
		result: Schema.Result(SecurityAuditRun, LoadFailure),
	},
	ChangedSearchDraft: { value: Schema.String },
	GotSeveritySelectMessage: { message: Select.Message },
	GotVerdictSelectMessage: { message: Select.Message },
	GotTargetSelectMessage: { message: Select.Message },
	GotRunsTargetSelectMessage: { message: Select.Message },
	ToggledShowRejected: {},
	ClickedClearFilters: {},
	ClickedShowAll: { group: FindingGroup },
})
export type Message = typeof Message.Type
