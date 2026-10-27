import {
	GithubIntegrationStatus,
	SecurityAuditFindingsResponse,
	SecurityAuditRun,
	SecurityAuditRunDetail,
	SecurityAuditRunsResponse,
	SecurityAuditSettings,
	SecurityAuditTargetsResponse,
} from "@maple/domain/http"
import { SecurityAuditRunId, SecurityAuditTargetId } from "@maple/domain/security-audit"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import { SeverityBucket } from "../kit/findings"
import { SecurityFindingsSearch, SecurityRunsSearch } from "../../../route/search"
import * as Select from "../../../ui/select"
import * as AddTarget from "../kit/add-target"
import * as SpendSettings from "../kit/spend-settings"

// `/security`, `/security/findings` and `/security/runs` as one page instance: the three tabs read
// the same targets, runs and findings, so a tab change reuses what the last one read.

export const Tab = Schema.Literals(["overview", "findings", "runs"])
export type Tab = typeof Tab.Type

export const Model = Schema.Struct({
	tab: Tab,
	findingsSearch: SecurityFindingsSearch,
	runsSearch: SecurityRunsSearch,
	nowMs: Schema.Finite,
	/** `useIsOrgAdmin`: hides writes a member would be refused. The server still decides. */
	isAdmin: Schema.Boolean,
	targets: KeyedSchema(SecurityAuditTargetsResponse, LoadFailure),
	runs: KeyedSchema(SecurityAuditRunsResponse, LoadFailure),
	/** Each target's own runs: its latest run and this month's spend, past the global list's cap. */
	targetRuns: Schema.Record(Schema.String, KeyedSchema(SecurityAuditRunsResponse, LoadFailure)),
	/** One read per target; findings are listed per target. */
	findings: Schema.Record(Schema.String, KeyedSchema(SecurityAuditFindingsResponse, LoadFailure)),
	/** Each target's latest run with its coverage counts. */
	latestRuns: Schema.Record(Schema.String, KeyedSchema(SecurityAuditRunDetail, LoadFailure)),
	githubStatus: KeyedSchema(GithubIntegrationStatus, LoadFailure),
	/** The org's monthly spend limit, this month's spend and its default models. */
	settings: KeyedSchema(SecurityAuditSettings, LoadFailure),
	addTarget: AddTarget.Model,
	spendSettings: SpendSettings.Model,
	startingTargetId: Schema.NullOr(SecurityAuditTargetId),
	searchDraft: Schema.String,
	/** Bumped per keystroke; only the last one's debounce commits the search to the URL. */
	searchGeneration: Schema.Finite,
	targetSelect: Select.Model,
	runsTargetSelect: Select.Model,
	/** Severity sections folded to their header. */
	collapsed: Schema.Array(SeverityBucket),
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
	CompletedFetchTargetRuns: { targetId: SecurityAuditTargetId, ...result(SecurityAuditRunsResponse) },
	CompletedFetchFindings: { targetId: SecurityAuditTargetId, ...result(SecurityAuditFindingsResponse) },
	CompletedFetchLatestRun: { runId: SecurityAuditRunId, ...result(SecurityAuditRunDetail) },
	CompletedFetchGithubStatus: result(GithubIntegrationStatus),
	CompletedFetchSettings: result(SecurityAuditSettings),
	TickedPoll: { nowMs: Schema.Finite },
	ClickedRetry: {},
	ClickedAddTarget: {},
	GotAddTargetMessage: { message: AddTarget.Message },
	ClickedSpendAndModels: {},
	GotSpendSettingsMessage: { message: SpendSettings.Message },
	ClickedStartRun: { targetId: SecurityAuditTargetId },
	CompletedStartRun: {
		targetId: SecurityAuditTargetId,
		result: Schema.Result(SecurityAuditRun, LoadFailure),
	},
	ChangedSearchDraft: { value: Schema.String },
	ElapsedSearchDebounce: { generation: Schema.Finite },
	GotTargetSelectMessage: { message: Select.Message },
	GotRunsTargetSelectMessage: { message: Select.Message },
	ToggledShowRejected: {},
	ClickedClearFilters: {},
	PickedSeverity: { bucket: SeverityBucket },
	ToggledSection: { bucket: SeverityBucket },
})
export type Message = typeof Message.Type
