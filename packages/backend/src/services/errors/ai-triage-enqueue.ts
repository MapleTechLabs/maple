import { randomUUID } from "node:crypto"
import {
	type AiTriageIncidentKind,
	type ErrorIssueId,
	IncidentTriagePriorDiagnosis,
	IncidentTriageRequest,
	type IncidentTriageVerdict,
	InvestigationIncidentSubject,
	InvestigationSnapshotFact,
	InvestigationSnapshotReference,
	InvestigationSubjectSnapshot,
	type IssueSeverity,
	type OrgId,
	PRIOR_DIAGNOSES_LIMIT,
} from "@maple/domain/http"
import { InvestigationId, IsoDateTimeString } from "@maple/primitives"
import * as PG from "@maple-dev/effect-orm/postgres"
import type { MapleDb } from "@maple/db/client"
import { AiTriageSettings, ErrorIssues, Investigations } from "@maple/db/tables"
import { Clock, Effect, Option, Schema, Array as Arr, String as Str } from "effect"

import { Database } from "@maple/backend/platform/DatabaseLive"

import { IncidentClassifier } from "@maple/backend/services/errors/IncidentClassifier"
import {
	evaluateIncidentGate,
	evaluateIssueGate,
	type LatestIssueInvestigation,
	REINVESTIGATE_AFTER_MS,
} from "@maple/backend/services/errors/investigation-gate"
import { applyClassifierSeverity } from "@maple/backend/services/errors/issue-severity"
import { InvestigationStarter } from "@maple/backend/services/errors/InvestigationStarter"
import {
	isInvestigationStale,
	storedProgressJson,
	sweepAbandonedInvestigations,
} from "@maple/backend/services/errors/investigation-stale"
import { summarizeCause } from "@maple/backend/platform/describe-cause"

const decodeInvestigationId = Schema.decodeUnknownSync(InvestigationId)
const decodeIso = Schema.decodeUnknownSync(IsoDateTimeString)

/**
 * What a producer knows about the incident it opened. Every field is optional because each
 * incident kind knows a different slice; the snapshot and the classifier read what is there.
 */
export interface TriageIncidentContext {
	/** Why the incident opened (`first_seen`, `regression`): a token, never a title. */
	readonly reason?: string
	readonly title?: string
	readonly ruleName?: string
	readonly severity?: IssueSeverity | null
	readonly serviceName?: string | null
	readonly deploymentEnv?: string | null
	readonly signalType?: string | null
	readonly exceptionType?: string | null
	readonly exceptionMessage?: string | null
	readonly errorLabel?: string | null
	readonly topFrame?: string | null
	readonly fingerprintHash?: string | null
	readonly occurrenceCount?: number | null
	readonly observedValue?: number | null
	readonly thresholdValue?: number | null
	/** Epoch ms the incident's window opened and last fired. */
	readonly startedAtMs?: number | null
	readonly endedAtMs?: number | null
}

/** Blank text reads as absent, so a fallback chain moves on past it. */
const text = (value: string | null | undefined): string | undefined =>
	value !== null && value !== undefined && Str.trim(value).length > 0 ? value : undefined

const finite = (value: number | null | undefined): number | null =>
	value !== null && value !== undefined && Number.isFinite(value) ? value : null

const instant = (ms: number | null | undefined): IsoDateTimeString | null => {
	const value = finite(ms)
	return value === null ? null : decodeIso(new Date(value).toISOString())
}

const snapshotFor = (input: MaybeEnqueueTriageInput): InstanceType<typeof InvestigationSubjectSnapshot> => {
	const { context } = input
	const serviceName = text(context.serviceName)
	const kindWord = `${Str.toUpperCase(Str.slice(0, 1)(input.incidentKind))}${Str.slice(1)(input.incidentKind)}`
	// The last resort is what the investigations list renders as a title, so it
	// names the service when there is one. `exceptionType: message` beats either
	// alone, and `errorLabel` comes before `signalType`: a status-message-only error
	// has no exception type, and its label is the only human-readable thing about it.
	const exceptionType = text(context.exceptionType)
	const exceptionMessage = text(context.exceptionMessage)
	const exceptionHeadline =
		exceptionType && exceptionMessage
			? `${exceptionType}: ${exceptionMessage}`
			: (exceptionType ?? exceptionMessage)
	const title =
		text(context.title) ??
		text(context.ruleName) ??
		exceptionHeadline ??
		text(context.errorLabel) ??
		text(context.signalType) ??
		(serviceName ? `${kindWord} on ${serviceName}` : `${kindWord} incident`)
	const fingerprintHash = text(context.fingerprintHash) ?? null
	const topFrame = text(context.topFrame) ?? null
	const occurrenceCount = finite(context.occurrenceCount)

	// Display facts. The identifier fields below are the same values again, but the
	// two lists are for different readers (this one renders on the investigation
	// page, that one is what the agent calls tools with), so they share one source.
	const factKeys = [
		["Incident", input.incidentId],
		["Service", serviceName],
		["Signal", text(context.signalType)],
		["Reason", text(context.reason)],
		["Exception", exceptionType],
		["Top frame", topFrame],
		["Fingerprint", fingerprintHash],
		["Occurrences", occurrenceCount === null ? undefined : String(occurrenceCount)],
	] as const

	return new InvestigationSubjectSnapshot({
		title,
		scope: serviceName ?? null,
		status: "open",
		severity: context.severity ?? null,
		facts: Arr.flatMap(factKeys, ([label, value]) =>
			value ? [new InvestigationSnapshotFact({ label, value })] : [],
		),
		references: input.issueId
			? [
					new InvestigationSnapshotReference({
						label: "Issue",
						url: `/errors/issues/${input.issueId}`,
					}),
				]
			: [],
		incidentStartedAt: instant(context.startedAtMs),
		incidentEndedAt: instant(context.endedAtMs),
		fingerprintHash,
		exceptionType: exceptionType ?? null,
		exceptionMessage: exceptionMessage ?? null,
		topFrame,
		errorLabel: text(context.errorLabel) ?? null,
		occurrenceCount,
		serviceName: serviceName ?? null,
		deploymentEnv: text(context.deploymentEnv) ?? null,
		signalType: text(context.signalType) ?? null,
		observedValue: finite(context.observedValue),
		thresholdValue: finite(context.thresholdValue),
	})
}

export interface MaybeEnqueueTriageInput {
	readonly orgId: OrgId
	readonly incidentKind: AiTriageIncidentKind
	readonly incidentId: string
	readonly issueId?: ErrorIssueId
	readonly context: TriageIncidentContext
	/** Manual starts ignore the automation-enabled flag and the gates, but never the quota. */
	readonly force?: boolean
}

/**
 * The gates' refusals. Distinct from the operational reasons below because
 * each is a decision, not a failure: the incident was seen and judged not to
 * need a run, and a producer may want to record that (the anomaly path does).
 */
export type MaybeEnqueueTriageSkipReason =
	| "issue_handled"
	| "investigation_in_flight"
	| "recently_diagnosed"
	| "noise"
	| "covered_by_prior"

const SKIP_REASONS: ReadonlySet<string> = new Set<MaybeEnqueueTriageSkipReason>([
	"issue_handled",
	"investigation_in_flight",
	"recently_diagnosed",
	"noise",
	"covered_by_prior",
])

export const isTriageSkipReason = (reason: string | undefined): reason is MaybeEnqueueTriageSkipReason =>
	reason !== undefined && SKIP_REASONS.has(reason)

export interface MaybeEnqueueTriageResult {
	readonly enqueued: boolean
	readonly investigationId?: InvestigationId
	readonly reason?:
		| "disabled"
		| "daily_cap"
		| "duplicate"
		| "no_binding"
		| "rejected"
		| "error"
		| MaybeEnqueueTriageSkipReason
	/** For a skip that defers to an existing run: which one. */
	readonly priorInvestigationId?: InvestigationId
}

/** Only what the classifier is shown; a stored report that drifted elsewhere still counts. */
const decodePriorReport = Schema.decodeUnknownOption(
	Schema.Struct({ headline: Schema.optional(Schema.String), summary: Schema.optional(Schema.String) }),
)
const decodePriorSnapshot = Schema.decodeUnknownOption(
	Schema.Struct({ exceptionType: Schema.optional(Schema.NullOr(Schema.String)) }),
)

/**
 * Diagnoses on file for the same service, newest first, for the classifier to
 * recognise a flare-up of a known cause under a new fingerprint. The incident's
 * own issue is excluded: its history is the issue gate's business, judged
 * without a model.
 */
const selectPriorDiagnoses = (
	orm: MapleDb,
	orgId: OrgId,
	serviceName: string,
	issueId: ErrorIssueId | null,
	sinceMs: number,
) =>
	Effect.map(
		orm.run(
			PG.from(Investigations)
				.select(($) => ({
					id: $.id,
					reportJson: PG.undecoded($.reportJson),
					snapshotJson: PG.undecoded($.snapshotJson),
				}))
				.where(($) => [
					$.orgId.eq(orgId),
					$.status.eq("diagnosed"),
					$.createdAt.gte(sinceMs),
					PG.jsonText($.snapshotJson, "serviceName").eq(serviceName),
					issueId === null ? undefined : PG.or($.issueId.isNull(), $.issueId.neq(issueId)),
				])
				.orderBy(($) => [[$.createdAt, "desc"]])
				.limit(PRIOR_DIAGNOSES_LIMIT),
		),
		(rows) =>
			Arr.flatMap(rows, (row) => {
				const report = Option.getOrUndefined(decodePriorReport(row.reportJson))
				const headline = report?.headline ?? report?.summary
				if (headline === undefined || Str.trim(headline).length === 0) return []
				const snapshot = Option.getOrUndefined(decodePriorSnapshot(row.snapshotJson))
				return [
					new IncidentTriagePriorDiagnosis({
						investigationId: row.id,
						headline,
						exceptionType: snapshot?.exceptionType ?? null,
					}),
				]
			}),
	)

const triageRequestFor = (
	input: MaybeEnqueueTriageInput,
	snapshot: InvestigationSubjectSnapshot,
	reason: string | null,
	priorDiagnoses: ReadonlyArray<IncidentTriagePriorDiagnosis>,
): IncidentTriageRequest =>
	new IncidentTriageRequest({
		title: snapshot.title,
		incidentKind: input.incidentKind,
		reason,
		detectorSeverity: snapshot.severity,
		serviceName: snapshot.serviceName ?? null,
		deploymentEnv: snapshot.deploymentEnv ?? null,
		exceptionType: snapshot.exceptionType ?? null,
		exceptionMessage: snapshot.exceptionMessage ?? null,
		topFrame: snapshot.topFrame ?? null,
		occurrenceCount: snapshot.occurrenceCount ?? null,
		signalType: snapshot.signalType ?? null,
		observedValue: snapshot.observedValue ?? null,
		thresholdValue: snapshot.thresholdValue ?? null,
		priorDiagnoses,
	})

/** The verdict as span attributes, on every start and skip, so the gate can be measured in prod. */
const verdictAttributes = (verdict: IncidentTriageVerdict | null): Record<string, string | number> =>
	verdict === null
		? {}
		: {
				"maple.triage.disposition": verdict.disposition,
				"maple.triage.disposition_confidence": verdict.dispositionConfidence,
				"maple.triage.severity": verdict.severity,
				"maple.triage.user_impact": verdict.userImpact,
				"maple.triage.model": verdict.model,
				...(verdict.matchedPrior
					? { "maple.triage.prior_match_probability": verdict.matchedPrior.probability }
					: undefined),
			}

/**
 * A refused start has to be visible as a refusal, the same way a quota
 * refusal is: on the span, under `start_result`, so a gate that skips too much
 * reads as a gate rather than as an org with nothing to investigate.
 */
const recordSkip = (
	input: MaybeEnqueueTriageInput,
	reason: MaybeEnqueueTriageSkipReason,
	details: {
		readonly priorInvestigationId: InvestigationId | null
		readonly severity: IssueSeverity | null
		readonly verdict: IncidentTriageVerdict | null
	},
) =>
	Effect.logInfo("Investigation skipped by the gate").pipe(
		Effect.annotateLogs({
			orgId: input.orgId,
			incidentKind: input.incidentKind,
			incidentId: input.incidentId,
			issueId: input.issueId ?? "(none)",
			skipReason: reason,
			priorInvestigationId: details.priorInvestigationId ?? "(none)",
			severity: details.severity ?? "unclassified",
		}),
		Effect.andThen(
			Effect.annotateCurrentSpan({
				orgId: input.orgId,
				"maple.investigation.start_result": reason,
				"maple.investigation.severity": details.severity ?? "unclassified",
				...(details.priorInvestigationId
					? { "maple.investigation.prior_id": details.priorInvestigationId }
					: undefined),
				...verdictAttributes(details.verdict),
			}),
		),
	)

/**
 * Create and seed one durable investigation for a newly opened incident.
 *
 * Producers retain a non-failing "maybe enqueue" contract: investigation
 * failures must never take down the detector or alert tick that discovered the
 * incident.
 *
 * Three gates stand between an open incident and a model pass, cheapest first:
 * the issue's own history (no model), the decision model's verdict on the
 * incident, and the daily quota. The order matters twice over — the classifier
 * is not asked about an issue somebody already owns, and the quota is judged
 * by the severity the classifier settled on.
 */
export const maybeEnqueueTriage: (
	input: MaybeEnqueueTriageInput,
) => Effect.Effect<MaybeEnqueueTriageResult, never, Database | InvestigationStarter> = Effect.fn(
	"AiTriageEnqueue.maybeStartInvestigation",
)(
	function* (input) {
		const database = yield* Database
		const starter = yield* InvestigationStarter
		const nowMs = yield* Clock.currentTimeMillis

		const existingRows = yield* database.execute((db) =>
			db.run(
				PG.from(Investigations)
					.select(($) => ({
						id: $.id,
						status: $.status,
						startedAt: $.startedAt,
						progressJson: storedProgressJson($),
					}))
					.where(($) => [
						$.orgId.eq(input.orgId),
						$.incidentKind.eq(input.incidentKind),
						$.incidentId.eq(input.incidentId),
					])
					.limit(1),
			),
		)
		const existing = existingRows[0]
		if (existing !== undefined) {
			if (isInvestigationStale(existing, nowMs)) {
				yield* database.execute((db) => sweepAbandonedInvestigations(db, nowMs, input.orgId))
			}
			return { enqueued: false, investigationId: existing.id, reason: "duplicate" as const }
		}

		const settingsRows = yield* database.execute((db) =>
			db.run(
				PG.from(AiTriageSettings)
					.select()
					.where(($) => [$.orgId.eq(input.orgId)])
					.limit(1),
			),
		)
		const settings = settingsRows[0]
		if (!input.force && (settings === undefined || !settings.enabled)) {
			return { enqueued: false, reason: "disabled" as const }
		}

		const detected = snapshotFor(input)
		const reason = text(input.context.reason) ?? null

		// Gate 1: what Maple already knows about the issue. An error incident
		// auto-resolves after thirty quiet minutes and the next occurrence opens a
		// fresh one, so without this an issue firing on a retry cadence was
		// diagnosed again on every flare-up (fifteen times in five days, prod
		// 2026-09-20), and one a person had already taken to review kept getting
		// fresh reports nobody had asked for.
		if (input.issueId !== undefined) {
			const issueId = input.issueId
			const issueRows = yield* database.execute((db) =>
				db.run(
					PG.from(ErrorIssues)
						.select("workflowState")
						.where(($) => [$.orgId.eq(input.orgId), $.id.eq(issueId)])
						.limit(1),
				),
			)
			const latestRows = yield* database.execute((db) =>
				db.run(
					PG.from(Investigations)
						.select(($) => ({
							id: $.id,
							status: $.status,
							createdAt: $.createdAt,
							startedAt: $.startedAt,
							progressJson: storedProgressJson($),
						}))
						.where(($) => [$.orgId.eq(input.orgId), $.issueId.eq(issueId)])
						.orderBy(["createdAt", "desc"])
						.limit(1),
				),
			)
			const latestRow = latestRows[0]
			const latest: LatestIssueInvestigation | null =
				latestRow === undefined
					? null
					: {
							id: latestRow.id,
							status: latestRow.status,
							createdAtMs: latestRow.createdAt,
							startedAtMs: latestRow.startedAt,
							progressJson: latestRow.progressJson,
						}
			const issueGate = evaluateIssueGate({
				workflowState: issueRows[0]?.workflowState ?? null,
				reason,
				latest,
				incidentKind: input.incidentKind,
				nowMs,
				force: input.force,
			})
			if (issueGate.kind === "skip") {
				yield* recordSkip(input, issueGate.reason, {
					priorInvestigationId: issueGate.priorInvestigationId,
					severity: detected.severity,
					verdict: null,
				})
				return {
					enqueued: false,
					reason: issueGate.reason,
					...(issueGate.priorInvestigationId
						? { priorInvestigationId: issueGate.priorInvestigationId }
						: undefined),
				}
			}
		}

		// Gates 2 and 3: the decision model, where this deployment has one. Read
		// optionally on purpose — the Workers that open incidents bind it, tests
		// and the CLI do not, and its absence is "investigate unclassified", the
		// behaviour every incident had before the gate existed.
		const classifier = yield* Effect.serviceOption(IncidentClassifier)
		const priorsFor = (serviceName: string) =>
			database.execute((db) =>
				selectPriorDiagnoses(
					db,
					input.orgId,
					serviceName,
					input.issueId ?? null,
					nowMs - REINVESTIGATE_AFTER_MS.error,
				),
			)
		const serviceName = detected.serviceName ?? null
		const priors = Option.isNone(classifier) || serviceName === null ? [] : yield* priorsFor(serviceName)
		const verdict = Option.isNone(classifier)
			? null
			: yield* classifier.value.classify(triageRequestFor(input, detected, reason, priors))
		const gate = evaluateIncidentGate({
			verdict,
			detectorSeverity: detected.severity,
			force: input.force,
		})
		if (gate.kind === "skip") {
			// The one write a skip makes: an untriaged issue the model called noise
			// is labelled with its severity, so the hub can sort it below the rest.
			// Never an escalation — see `applyClassifierSeverity`.
			if (input.issueId !== undefined && gate.reason === "noise") {
				const issueId = input.issueId
				yield* database.execute((db) =>
					applyClassifierSeverity(db, {
						orgId: input.orgId,
						issueId,
						incidentId: input.incidentId,
						severity: gate.classification.severity,
						confidence: gate.classification.severityConfidence,
						timestamp: nowMs,
					}),
				)
			}
			yield* recordSkip(input, gate.reason, {
				priorInvestigationId: gate.priorInvestigationId,
				severity: gate.classification.severity,
				verdict: gate.classification,
			})
			return {
				enqueued: false,
				reason: gate.reason,
				...(gate.priorInvestigationId
					? { priorInvestigationId: gate.priorInvestigationId }
					: undefined),
			}
		}
		yield* Effect.annotateCurrentSpan(verdictAttributes(gate.classification))

		// The snapshot the run is seeded with carries the settled severity: the
		// detector's, raised by the model where it saw more urgency.
		const snapshot =
			gate.severity === detected.severity
				? detected
				: new InvestigationSubjectSnapshot({ ...detected, severity: gate.severity })

		// Quota read and insert under the org's admission lock, judged by the settled severity.
		const investigationId = decodeInvestigationId(randomUUID())
		const subject = new InvestigationIncidentSubject({
			type: "incident",
			incidentKind: input.incidentKind,
			incidentId: input.incidentId,
			...(input.issueId ? { issueId: input.issueId } : undefined),
		})
		const admission = yield* starter.admit({
			orgId: input.orgId,
			nowMs,
			severity: snapshot.severity,
			annotations: { incidentId: input.incidentId },
			spend: (db) =>
				db.run(
					PG.insertInto(Investigations)
						.values({
							id: investigationId,
							orgId: input.orgId,
							status: "investigating",
							seededBy: "system",
							subjectJson: subject,
							snapshotJson: snapshot,
							incidentKind: input.incidentKind,
							incidentId: input.incidentId,
							issueId: input.issueId ?? null,
							startedAt: nowMs,
							autonomousTurns: 1,
							createdAt: nowMs,
							updatedAt: nowMs,
						})
						.onConflictDoNothing()
						.returning("id"),
				),
		})
		if (!admission.admitted) return { enqueued: false, reason: "daily_cap" as const }
		if (admission.value.length === 0) return { enqueued: false, reason: "duplicate" as const }

		const started = yield* starter.startTurn({
			orgId: input.orgId,
			investigationId,
			subject,
			snapshot,
			nowMs,
		})
		if (!started.started) {
			return {
				enqueued: false,
				investigationId,
				reason: started.reason === "no_binding" ? ("no_binding" as const) : ("error" as const),
			}
		}
		return { enqueued: true, investigationId }
	},
	(effect, input) =>
		Effect.catchCause(effect, (cause) =>
			Effect.logError("Investigation enqueue failed").pipe(
				Effect.annotateLogs({
					orgId: input.orgId,
					incidentKind: input.incidentKind,
					incidentId: input.incidentId,
					error: summarizeCause(cause),
				}),
				Effect.as({ enqueued: false, reason: "error" as const }),
			),
		),
)
