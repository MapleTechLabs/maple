import * as PG from "@maple-dev/effect-orm/postgres"
import {
	ErrorGroupingConfigs,
	ErrorGroupingKeys,
	ErrorIssueFingerprints,
	ErrorIssues,
} from "@maple/db/tables"
import {
	type ErrorIssueId,
	ErrorIssueDocument,
	ErrorIssueFingerprintGrouping,
	ErrorIssueGroupingResponse,
	type ErrorIssueNotFoundError,
	ErrorIssueSimilarIssue,
	ErrorIssueSimilarResponse,
	type ErrorPersistenceError,
	ErrorValidationError,
	GroupingConfigDocument,
	type OrgId,
	UserId as UserIdSchema,
	type UserId,
	type WarehouseReadError,
} from "@maple/domain/http"
import { computeFingerprintInputs } from "@maple/domain/tinybird/fingerprint"
import { explainGrouping } from "@maple/domain/tinybird/grouping"
import { type GroupingConfig, groupingRuleProblem } from "@maple/domain/tinybird/grouping-rules"
import { Array as Arr, Clock, Context, DateTime, Effect, Layer, Order, Schema, String as Str } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { systemTenant } from "@maple/backend/services/auth/system-tenant"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { ACTIONABLE_WORKFLOW_STATES } from "./ErrorIssueReadModelsService"
import { ErrorIssueWorkflowService } from "./ErrorIssueWorkflowService"
import { makeErrorDatabaseExecute } from "./error-persistence"
import { computeSampleInputs, loadOrgGrouping, warehouseGroupingReads } from "./grouping-keys"

/** Fingerprints one "why grouped" response explains; the rest are counted, not read. */
const MAX_EXPLAINED_FINGERPRINTS = 50
/** Open issues a similar-issues read compares against, newest first. */
const SIMILAR_CANDIDATES = 500
const SIMILAR_LIMIT = 5
/** Measured on labelled pairs the key leaves apart: 81% of duplicates found, 57% right. */
const SIMILAR_MIN_OVERLAP = 0.5

const SYSTEM_USER_ID = Schema.decodeSync(UserIdSchema)("system-errors")
const decodeIso = Schema.decodeUnknownSync(ErrorIssueDocument.fields.firstSeenAt)
const isoOf = (ms: number) => decodeIso(new Date(ms).toISOString())

export interface ErrorGroupingServiceApi {
	readonly getRules: (orgId: OrgId) => Effect.Effect<GroupingConfigDocument, ErrorPersistenceError>
	readonly updateRules: (
		orgId: OrgId,
		userId: UserId,
		config: GroupingConfig,
	) => Effect.Effect<GroupingConfigDocument, ErrorPersistenceError | ErrorValidationError>
	/** Every fingerprint the issue owns, and which rule put it there. */
	readonly explainIssue: (
		orgId: OrgId,
		issueId: ErrorIssueId,
	) => Effect.Effect<
		ErrorIssueGroupingResponse,
		ErrorPersistenceError | ErrorIssueNotFoundError | WarehouseReadError
	>
	/** Open issues of the same service and type with a similar message. */
	readonly similarIssues: (
		orgId: OrgId,
		issueId: ErrorIssueId,
	) => Effect.Effect<ErrorIssueSimilarResponse, ErrorPersistenceError | ErrorIssueNotFoundError>
}

const messageWords = (message: string): ReadonlySet<string> =>
	new Set(
		Arr.filter(
			Str.split(/[^a-z]+/)(
				Str.toLowerCase(
					computeFingerprintInputs({
						exceptionType: "",
						exceptionStacktrace: "",
						statusMessage: message,
					}).msgSignature,
				),
			),
			(word) => word.length > 2,
		),
	)

/** Share of words two messages have in common (Jaccard); nothing shared is no overlap. */
const messageOverlap = (a: ReadonlySet<string>, b: ReadonlySet<string>): number => {
	const shared = Arr.filter([...a], (word) => b.has(word)).length
	return shared === 0 ? 0 : shared / (a.size + b.size - shared)
}

const make: Effect.Effect<
	ErrorGroupingServiceApi,
	never,
	Database | ErrorIssueWorkflowService | WarehouseQueryService
> = Effect.gen(function* () {
	const database = yield* Database
	const workflow = yield* ErrorIssueWorkflowService
	const warehouse = yield* WarehouseQueryService
	const dbExecute = makeErrorDatabaseExecute(database, "ErrorGroupingService")

	const document = (rules: GroupingConfig["rules"], updatedAt: number | null) =>
		new GroupingConfigDocument({ rules, updatedAt: updatedAt === null ? null : isoOf(updatedAt) })

	const getRules: ErrorGroupingServiceApi["getRules"] = Effect.fn("ErrorGroupingService.getRules")(
		function* (orgId) {
			const grouping = yield* dbExecute((db) => loadOrgGrouping(db, orgId))
			return document(grouping.config.rules, grouping.updatedAt)
		},
	)

	const updateRules: ErrorGroupingServiceApi["updateRules"] = Effect.fn("ErrorGroupingService.updateRules")(
		function* (orgId, userId, config) {
			const ids = Arr.map(config.rules, (rule) => rule.id)
			const duplicates = Arr.dedupe(Arr.filter(ids, (id, index) => ids.indexOf(id) !== index))
			const problems = [
				...Arr.flatMap(config.rules, (rule) => {
					const problem = groupingRuleProblem(rule)
					return problem === undefined ? [] : [problem]
				}),
				...Arr.map(duplicates, (id) => `${id}: two rules share this id`),
			]
			if (problems.length > 0) {
				return yield* new ErrorValidationError({
					message: "These grouping rules cannot be saved.",
					details: problems,
				})
			}
			const timestamp = yield* Clock.currentTimeMillis
			yield* Effect.annotateCurrentSpan({ orgId, "maple.grouping.rules": config.rules.length })
			yield* dbExecute((db) =>
				db.run(
					PG.insertInto(ErrorGroupingConfigs)
						.values({ orgId, rulesJson: config.rules, updatedAt: timestamp, updatedBy: userId })
						.onConflictDoUpdate({
							target: ["orgId"],
							set: { rulesJson: config.rules, updatedAt: timestamp, updatedBy: userId },
						}),
				),
			)
			return document(config.rules, timestamp)
		},
	)

	const explainIssue: ErrorGroupingServiceApi["explainIssue"] = Effect.fn(
		"ErrorGroupingService.explainIssue",
	)(function* (orgId, issueId) {
		yield* Effect.annotateCurrentSpan({ orgId, "maple.issue.id": issueId })
		const issue = yield* workflow.requireIssue(orgId, issueId)
		if (issue.kind !== "error")
			return new ErrorIssueGroupingResponse({ fingerprints: [], truncated: false })
		const { aliases, grouping } = yield* dbExecute((db) =>
			Effect.all({
				aliases: db.run(
					PG.from(ErrorIssueFingerprints)
						.select("fingerprintHash", "source", "createdAt")
						.where(($) => [$.orgId.eq(orgId), $.issueId.eq(issueId)])
						.orderBy(["createdAt", "asc"], ["fingerprintHash", "asc"]),
				),
				grouping: loadOrgGrouping(db, orgId),
			}),
		)
		const owned = [
			{ fingerprintHash: issue.fingerprintHash, source: "primary" as const },
			...Arr.map(aliases, (alias) => ({
				fingerprintHash: alias.fingerprintHash,
				source: alias.source,
			})),
		]
		const explained = owned.slice(0, MAX_EXPLAINED_FINGERPRINTS)
		const hashes = Arr.map(explained, (entry) => entry.fingerprintHash)
		const stored = yield* dbExecute((db) =>
			db.run(
				PG.from(ErrorGroupingKeys)
					.select("fingerprintHash", "groupingKey", "rule", "pinned")
					.where(($) => [$.orgId.eq(orgId), $.fingerprintHash.in_(...hashes)]),
			),
		)
		const storedOf = new Map(Arr.map(stored, (row) => [row.fingerprintHash, row] as const))
		const reads = warehouseGroupingReads(
			warehouse,
			systemTenant(orgId, SYSTEM_USER_ID),
			orgId,
			{ startMs: issue.firstSeenAt, endMs: issue.lastSeenAt + 60_000 },
			"errorGroupingExplain",
		)
		const samples = yield* reads.samples(hashes)
		const spans = samples.length === 0 ? [] : yield* reads.spans(samples)
		const inputs = new Map(
			Arr.map(computeSampleInputs(samples, spans), (entry) => [entry.fingerprintHash, entry] as const),
		)
		const sampleOf = new Map(Arr.map(samples, (sample) => [sample.fingerprintHash, sample] as const))
		const fingerprints = Arr.map(explained, ({ fingerprintHash, source }) => {
			const entry = inputs.get(fingerprintHash)
			const sample = sampleOf.get(fingerprintHash)
			const key = storedOf.get(fingerprintHash)
			const why = entry === undefined ? undefined : explainGrouping(entry.input, grouping.rules)
			// The stored rule is the one that grouped the hash; a pin-only row keyed nothing.
			const keyed = key !== undefined && !Str.startsWith("pinned:")(key.groupingKey)
			return new ErrorIssueFingerprintGrouping({
				fingerprintHash,
				source,
				rule: keyed ? key.rule : (why?.rule ?? null),
				orgRule: why?.orgRule === undefined ? null : (why.orgRule.title ?? why.orgRule.id),
				pinned: key?.pinned ?? false,
				exceptionType: sample?.exceptionType ?? issue.exceptionType,
				messageSignature: why?.messageSignature ?? "",
				frames: why?.frames ?? [],
				skippedFrames: why?.skippedFrames ?? [],
				customKey: why?.customKey ?? null,
				sampledAt: sample === undefined ? null : isoOf(DateTime.toEpochMillis(sample.timestamp)),
			})
		})
		yield* Effect.annotateCurrentSpan({
			"maple.issue.fingerprints": owned.length,
			"maple.grouping.explained": fingerprints.length,
		})
		return new ErrorIssueGroupingResponse({ fingerprints, truncated: owned.length > explained.length })
	})

	const similarIssues: ErrorGroupingServiceApi["similarIssues"] = Effect.fn(
		"ErrorGroupingService.similarIssues",
	)(function* (orgId, issueId) {
		yield* Effect.annotateCurrentSpan({ orgId, "maple.issue.id": issueId })
		const issue = yield* workflow.requireIssue(orgId, issueId)
		if (issue.kind !== "error") return new ErrorIssueSimilarResponse({ issues: [] })
		const candidates = yield* dbExecute((db) =>
			db.run(
				PG.from(ErrorIssues)
					.select(
						"id",
						"serviceName",
						"exceptionType",
						"exceptionMessage",
						"errorLabel",
						"workflowState",
						"occurrenceCount",
						"lastSeenAt",
					)
					.where(($) => [
						$.orgId.eq(orgId),
						$.kind.eq("error"),
						$.serviceName.eq(issue.serviceName),
						$.exceptionType.eq(issue.exceptionType),
						$.id.neq(issueId),
						$.archivedAt.isNull(),
						$.mergedIntoIssueId.isNull(),
						$.workflowState.in_(...ACTIONABLE_WORKFLOW_STATES),
					])
					.orderBy(["lastSeenAt", "desc"])
					.limit(SIMILAR_CANDIDATES),
			),
		)
		const words = messageWords(issue.exceptionMessage)
		const scored = Arr.filter(
			Arr.map(candidates, (row) => ({
				row,
				similarity: messageOverlap(words, messageWords(row.exceptionMessage)),
			})),
			({ similarity }) => similarity >= SIMILAR_MIN_OVERLAP,
		)
		const ranked = Arr.sort(
			scored,
			Order.combine(
				Order.mapInput(
					Order.flip(Order.Number),
					(entry: (typeof scored)[number]) => entry.similarity,
				),
				Order.mapInput(
					Order.flip(Order.Number),
					(entry: (typeof scored)[number]) => entry.row.occurrenceCount,
				),
			),
		).slice(0, SIMILAR_LIMIT)
		yield* Effect.annotateCurrentSpan({
			"maple.grouping.similar_candidates": candidates.length,
			"maple.grouping.similar": ranked.length,
		})
		return new ErrorIssueSimilarResponse({
			issues: Arr.map(
				ranked,
				({ row, similarity }) =>
					new ErrorIssueSimilarIssue({
						id: row.id,
						serviceName: row.serviceName,
						exceptionType: row.exceptionType,
						exceptionMessage: row.exceptionMessage,
						errorLabel: row.errorLabel,
						workflowState: row.workflowState,
						occurrenceCount: row.occurrenceCount,
						lastSeenAt: isoOf(row.lastSeenAt),
						similarity: Math.round(similarity * 100) / 100,
					}),
			),
		})
	})

	return { getRules, updateRules, explainIssue, similarIssues }
})

export class ErrorGroupingService extends Context.Service<ErrorGroupingService, ErrorGroupingServiceApi>()(
	"@maple/backend/services/errors/ErrorGroupingService",
	{ make },
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(Layer.mergeAll(WarehouseQueryService.layer, ErrorIssueWorkflowService.layer)),
	)
}
