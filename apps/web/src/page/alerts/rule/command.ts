import { resolveWindowCommand } from "../../kit/time-frame"
import { reloadSpin, readClock } from "@maple/views/data/timing"
import { AlertRuleId, IsoDateTimeString } from "@maple/domain/http"
import { V2AlertRulePreviewParams, V2InvestigationCreateParams } from "@maple/domain/http/v2"
import { v2CheckToDocument } from "@maple/web-data/alerts/form-utils"
import { Effect, Schema, Array as Arr } from "effect"
import { Command } from "foldkit"
import { settleTo } from "@maple/views/data/load-failure"
import { MapleApiV2Client } from "../../../platform/api-clients"
import { listDeliveries, setRuleEnabled } from "../shared/commands"
import { listActiveSilences } from "../shared/silences"
import { readGrants } from "../../../data/session-tenant"
import { fetchCheckSummary } from "../shared/check-summary"
import { fetchPreview } from "../shared/preview"
import { CheckStatusFilter } from "./model"
import { Message } from "./message"

const PAGE_LIMIT = 100
/** `useEffectiveTimeRange(search…, "24h")`: snapped on entry, against the real clock on Reload. */
export const ResolveRuleWindow = resolveWindowCommand(
	"ResolveAlertRuleWindow",
	Message.CompletedResolveWindow,
)

export const ReadDiagnosisClock = readClock("ReadAlertRuleDiagnosisClock", Message.ReadDiagnosisClock)

export const CompleteRuleReloadSpin = reloadSpin("CompleteAlertRuleReloadSpin", Message.CompletedReloadSpin)

export const FetchRuleDeliveries = Command.define("FetchAlertRuleDeliveries", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchDeliveries],
	execute: ({ key }) =>
		listDeliveries().pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchDeliveries({ key, result })),
		),
})

/** `checksAtomFamily`: the newest page and the window summary, together. */
export const FetchRuleChecks = Command.define("FetchAlertRuleChecks", {
	args: { key: Schema.String, ruleId: AlertRuleId, since: IsoDateTimeString, until: IsoDateTimeString },
	messages: [Message.CompletedFetchChecks],
	execute: ({ key, ruleId, since, until }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const [response, summary] = yield* Effect.all(
				[
					client.alertRules.checks({
						params: { id: ruleId },
						query: { since, until, limit: PAGE_LIMIT },
					}),
					fetchCheckSummary(ruleId, since, until),
				],
				{ concurrency: "unbounded" },
			)
			return {
				checks: Arr.map(response.data, v2CheckToDocument),
				hasMore: response.has_more,
				nextCursor: response.next_cursor,
				summary,
			}
		}).pipe(settleTo((result) => Message.CompletedFetchChecks({ key, result }))),
})

/** `handleSelectBucket`: one bucket's checks, bounded; the request number drops stale answers. */
export const FetchBucketChecks = Command.define("FetchAlertRuleBucketChecks", {
	args: { request: Schema.Number, ruleId: AlertRuleId, since: IsoDateTimeString, until: IsoDateTimeString },
	messages: [Message.CompletedFetchBucketChecks],
	execute: ({ request, ruleId, since, until }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const page = yield* client.alertRules.checks({
				params: { id: ruleId },
				query: { since, until, limit: PAGE_LIMIT },
			})
			return Arr.map(page.data, v2CheckToDocument)
		}).pipe(settleTo((result) => Message.CompletedFetchBucketChecks({ request, result }))),
})

/** `ChecksPanel`'s "Load 100 more". */
export const LoadMoreChecks = Command.define("LoadMoreAlertRuleChecks", {
	args: {
		ruleId: AlertRuleId,
		since: IsoDateTimeString,
		until: IsoDateTimeString,
		cursor: Schema.String,
		status: CheckStatusFilter,
		generation: Schema.Number,
	},
	messages: [Message.CompletedLoadMoreChecks],
	execute: ({ ruleId, since, until, cursor, status, generation }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const query = { since, until, limit: PAGE_LIMIT, cursor }
			const page = yield* client.alertRules.checks({
				params: { id: ruleId },
				query: status === "all" ? query : { ...query, status },
			})
			return { checks: Arr.map(page.data, v2CheckToDocument), nextCursor: page.next_cursor }
		}).pipe(settleTo((result) => Message.CompletedLoadMoreChecks({ generation, result }))),
})

export const FetchRulePreview = Command.define("FetchAlertRulePreview", {
	args: { key: Schema.String, payload: V2AlertRulePreviewParams },
	messages: [Message.CompletedFetchPreview],
	execute: ({ key, payload }) =>
		fetchPreview(payload).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchPreview({ key, result })),
		),
})

export const ToggleRuleEnabled = Command.define("ToggleAlertRuleEnabled", {
	args: { ruleId: AlertRuleId, isEnabled: Schema.Boolean },
	messages: [Message.CompletedToggleEnabled],
	execute: ({ ruleId, isEnabled }) =>
		setRuleEnabled(ruleId, isEnabled).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedToggleEnabled({ result })),
		),
})

export const OpenRuleInvestigation = Command.define("OpenAlertRuleInvestigation", {
	args: { payload: V2InvestigationCreateParams },
	messages: [Message.CompletedOpenInvestigation],
	execute: ({ payload }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const investigation = yield* client.investigations.create({ payload })
			return String(investigation.id)
		}).pipe(settleTo((result) => Message.CompletedOpenInvestigation({ result }))),
})

export const FetchRuleSilences = Command.define("FetchAlertRuleSilences", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchSilences],
	execute: ({ key }) =>
		listActiveSilences.pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchSilences({ key, result })),
		),
})

export const FetchRuleSession = Command.define("FetchAlertRuleSession", {
	messages: [Message.CompletedFetchSession],
	execute: Effect.map(readGrants, (grants) => Message.CompletedFetchSession({ grants })),
})
