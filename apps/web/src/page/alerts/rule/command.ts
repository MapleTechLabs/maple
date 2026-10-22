import { AlertRuleId, IsoDateTimeString } from "@maple/domain/http"
import { V2AlertRulePreviewParams, V2InvestigationCreateParams } from "@maple/domain/http/v2"
import { v2CheckToDocument } from "@maple/web-data/alerts/form-utils"
import { Clock, Duration, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { toLoadFailure } from "../../../data/load-failure"
import { resolveWindow } from "../../../data/time-range"
import { MapleApiV2Client } from "../../../platform/api-clients"
import { listDeliveries, setRuleEnabled } from "../shared/commands"
import { fetchPreview } from "../shared/preview"
import { CheckStatusFilter } from "./model"
import { Message, RequestMode } from "./message"

const PAGE_LIMIT = 100
const RELOAD_SPIN = Duration.millis(600)

/** `useEffectiveTimeRange(search…, "24h")`: snapped on entry, against the real clock on Reload. */
export const ResolveRuleWindow = Command.define("ResolveAlertRuleWindow", {
	args: {
		mode: RequestMode,
		startTime: Schema.optional(Schema.String),
		endTime: Schema.optional(Schema.String),
		preset: Schema.String,
		timeZone: Schema.String,
	},
	messages: [Message.CompletedResolveWindow],
	execute: ({ mode, startTime, endTime, preset, timeZone }) =>
		Effect.map(Clock.currentTimeMillis, (nowMs) =>
			Message.CompletedResolveWindow({
				window: resolveWindow({ startTime, endTime, preset, snap: mode === "Load", timeZone }, nowMs),
				nowMs,
				mode,
			}),
		),
})

export const ReadDiagnosisClock = Command.define("ReadAlertRuleDiagnosisClock", {
	messages: [Message.ReadDiagnosisClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.ReadDiagnosisClock({ nowMs })),
})

export const CompleteRuleReloadSpin = Command.define("CompleteAlertRuleReloadSpin", {
	args: { version: Schema.Number },
	messages: [Message.CompletedReloadSpin],
	execute: ({ version }) => Effect.as(Effect.sleep(RELOAD_SPIN), Message.CompletedReloadSpin({ version })),
})

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
					client.alertRules.checks({ params: { id: ruleId }, query: { since, until, limit: PAGE_LIMIT } }),
					client.alertRules.checksSummary({ params: { id: ruleId }, query: { since, until } }),
				],
				{ concurrency: "unbounded" },
			)
			return {
				checks: response.data.map(v2CheckToDocument),
				hasMore: response.has_more,
				nextCursor: response.next_cursor,
				summary: {
					bucketSeconds: summary.bucket_seconds,
					totals: summary.totals,
					points: summary.points.map((point) => ({
						bucket: point.bucket,
						groupKey: point.group_key,
						totalCount: point.total_count,
						breachedCount: point.breached_count,
						healthyCount: point.healthy_count,
						skippedCount: point.skipped_count,
						errorCount: point.error_count,
						transitionCount: point.transition_count,
						observedValue: point.observed_value,
						threshold: point.threshold,
					})),
				},
			}
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchChecks({ key, result })),
		),
})

/** `handleSelectBucket`: one bucket's checks, bounded; the request number drops stale answers. */
export const FetchBucketChecks = Command.define("FetchAlertRuleBucketChecks", {
	args: { request: Schema.Number, ruleId: AlertRuleId, since: IsoDateTimeString, until: IsoDateTimeString },
	messages: [Message.CompletedFetchBucketChecks],
	execute: ({ request, ruleId, since, until }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const page = yield* client.alertRules.checks({ params: { id: ruleId }, query: { since, until, limit: PAGE_LIMIT } })
			return page.data.map(v2CheckToDocument)
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchBucketChecks({ request, result })),
		),
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
			return { checks: page.data.map(v2CheckToDocument), nextCursor: page.next_cursor }
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedLoadMoreChecks({ generation, result })),
		),
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
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedOpenInvestigation({ result })),
		),
})
