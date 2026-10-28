import { randomUUID } from "node:crypto"
import {
	IngestRuleNotFoundError,
	IngestRulePersistenceError,
	IngestRuleValidationError,
	type OrgId,
} from "@maple/domain/http"
import {
	INGEST_RULE_LIMITS,
	ingestRuleProblems,
	type IngestRule,
	type IngestRuleSpec,
} from "@maple/domain/ingest-rules"
import { IngestRuleId } from "@maple/domain/primitives"
import * as PG from "@maple-dev/effect-orm/postgres"
import {
	OrgIngestRuleSettings,
	OrgIngestRuleStats,
	OrgIngestRules,
	type OrgIngestRuleRow,
} from "@maple/db/tables"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { Database, type DatabaseError } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"

export interface IngestRuleInput {
	readonly name: string
	readonly enabled?: boolean
	readonly position?: number
	readonly spec: IngestRuleSpec
}

/** Totals over a window; `dropped_bytes` is what the rules kept off the bill. */
export interface IngestRuleCounts {
	readonly matched: number
	readonly dropped: number
	readonly droppedBytes: number
	readonly redactedValues: number
}

export interface IngestRuleStatsWindow {
	readonly rules: ReadonlyArray<IngestRuleCounts & { readonly ruleId: IngestRuleId }>
	readonly signals: ReadonlyArray<IngestRuleCounts & { readonly signal: string }>
	/** Per rule and UTC hour; only for windows up to `HOURLY_MAX_MS`. */
	readonly hourly: ReadonlyArray<{
		readonly ruleId: IngestRuleId
		readonly bucket: number
		readonly matched: number
	}>
}

export const HOURLY_MAX_MS = 7 * 24 * 60 * 60 * 1000

export interface IngestRulePatch {
	readonly name?: string
	readonly enabled?: boolean
	readonly position?: number
	readonly spec?: IngestRuleSpec
}

const toPersistenceError = (error: DatabaseError) =>
	new IngestRulePersistenceError({ message: error.message })
const decodeRuleId = Schema.decodeUnknownSync(IngestRuleId)

const rowToRule = (row: OrgIngestRuleRow): IngestRule => ({
	id: row.id,
	name: row.name,
	enabled: row.enabled,
	position: row.position,
	spec: row.specJson,
	createdAt: row.createdAt,
	updatedAt: row.updatedAt,
})

const validateSpec = Effect.fnUntraced(function* (spec: IngestRuleSpec) {
	const problems = ingestRuleProblems(spec)
	if (problems.length > 0) {
		return yield* new IngestRuleValidationError({
			message: `Invalid ingest rule: ${problems.join("; ")}`,
			problems,
		})
	}
})

const randomSalt = () =>
	Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("")

export class IngestRuleService extends Context.Service<IngestRuleService>()(
	"@maple/backend/services/IngestRuleService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const dbExecute = makeDbExecute(database, "IngestRuleService", toPersistenceError)

			const list = Effect.fn("IngestRuleService.list")(function* (orgId: OrgId) {
				yield* Effect.annotateCurrentSpan("orgId", orgId)
				const rows = yield* dbExecute((db) =>
					db.run(
						PG.from(OrgIngestRules)
							.select()
							.where(($) => [$.orgId.eq(orgId)])
							.orderBy(($) => [
								[$.position, "asc"],
								[$.createdAt, "asc"],
								[$.id, "asc"],
							]),
					),
				)
				return rows.map(rowToRule)
			})

			const get = Effect.fn("IngestRuleService.get")(function* (orgId: OrgId, ruleId: IngestRuleId) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.ingest_rule.id": ruleId })
				const rows = yield* dbExecute((db) =>
					db.run(
						PG.from(OrgIngestRules)
							.select()
							.where(($) => [$.orgId.eq(orgId), $.id.eq(ruleId)])
							.limit(1),
					),
				)
				const row = Option.fromNullishOr(rows[0])
				if (Option.isNone(row)) {
					return yield* new IngestRuleNotFoundError({ ruleId, message: "No such ingest rule." })
				}
				return rowToRule(row.value)
			})

			const create = Effect.fn("IngestRuleService.create")(function* (
				orgId: OrgId,
				input: IngestRuleInput,
			) {
				yield* Effect.annotateCurrentSpan("orgId", orgId)
				yield* validateSpec(input.spec)
				const existing = yield* list(orgId)
				if (existing.length >= INGEST_RULE_LIMITS.rulesPerOrg) {
					const message = `An organization can have at most ${INGEST_RULE_LIMITS.rulesPerOrg} ingest rules`
					return yield* new IngestRuleValidationError({ message, problems: [message] })
				}
				const now = yield* Clock.currentTimeMillis
				const id = decodeRuleId(randomUUID())
				yield* Effect.annotateCurrentSpan("maple.ingest_rule.id", id)
				const lastPosition = existing.reduce((max, rule) => Math.max(max, rule.position), -1)
				yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							yield* db.run(
								PG.insertInto(OrgIngestRuleSettings)
									.values({ orgId, hashSalt: randomSalt(), createdAt: now })
									.onConflictDoNothing(),
							)
							yield* db.run(
								PG.insertInto(OrgIngestRules).values({
									id,
									orgId,
									name: input.name.trim(),
									enabled: input.enabled ?? true,
									position: input.position ?? lastPosition + 1,
									specJson: input.spec,
									createdAt: now,
									updatedAt: now,
								}),
							)
						}),
					),
				)
				return yield* get(orgId, id).pipe(
					Effect.catchTag("@maple/http/errors/IngestRuleNotFoundError", () =>
						Effect.fail(
							new IngestRulePersistenceError({ message: "Failed to create ingest rule" }),
						),
					),
				)
			})

			const update = Effect.fn("IngestRuleService.update")(function* (
				orgId: OrgId,
				ruleId: IngestRuleId,
				patch: IngestRulePatch,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.ingest_rule.id": ruleId })
				yield* get(orgId, ruleId)
				if (patch.spec !== undefined) yield* validateSpec(patch.spec)
				const now = yield* Clock.currentTimeMillis
				yield* dbExecute((db) =>
					db.run(
						PG.update(OrgIngestRules)
							.set({
								updatedAt: now,
								name: patch.name?.trim(),
								enabled: patch.enabled,
								position: patch.position,
								specJson: patch.spec,
							})
							.where(($) => [$.orgId.eq(orgId), $.id.eq(ruleId)]),
					),
				)
				return yield* get(orgId, ruleId)
			})

			const remove = Effect.fn("IngestRuleService.delete")(function* (
				orgId: OrgId,
				ruleId: IngestRuleId,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.ingest_rule.id": ruleId })
				const rows = yield* dbExecute((db) =>
					db.run(
						PG.deleteFrom(OrgIngestRules)
							.where(($) => [$.orgId.eq(orgId), $.id.eq(ruleId)])
							.returning("id"),
					),
				)
				if (rows.length === 0) {
					return yield* new IngestRuleNotFoundError({ ruleId, message: "No such ingest rule." })
				}
				return ruleId
			})

			// Postgres sums int8 as numeric, which drivers may hand back as a string.
			const counts = (row: {
				readonly matched: number | string | null
				readonly dropped: number | string | null
				readonly droppedBytes: number | string | null
				readonly redactedValues: number | string | null
			}): IngestRuleCounts => ({
				matched: Number(row.matched ?? 0),
				dropped: Number(row.dropped ?? 0),
				droppedBytes: Number(row.droppedBytes ?? 0),
				redactedValues: Number(row.redactedValues ?? 0),
			})

			const stats = Effect.fn("IngestRuleService.stats")(function* (
				orgId: OrgId,
				startMs: number,
				endMs: number,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.ingest_rule.window_ms": endMs - startMs })
				const [byRule, bySignal, hourly] = yield* Effect.all(
					[
						dbExecute((db) =>
							db.run(
								PG.from(OrgIngestRuleStats)
									.select(($) => ({
										ruleId: $.ruleId,
										matched: PG.sum($.matched),
										dropped: PG.sum($.dropped),
										droppedBytes: PG.sum($.droppedBytes),
										redactedValues: PG.sum($.redactedValues),
									}))
									.where(($) => [
										$.orgId.eq(orgId),
										$.bucket.gte(startMs),
										$.bucket.lt(endMs),
									])
									.groupBy("ruleId"),
							),
						),
						dbExecute((db) =>
							db.run(
								PG.from(OrgIngestRuleStats)
									.select(($) => ({
										signal: $.signal,
										matched: PG.sum($.matched),
										dropped: PG.sum($.dropped),
										droppedBytes: PG.sum($.droppedBytes),
										redactedValues: PG.sum($.redactedValues),
									}))
									.where(($) => [
										$.orgId.eq(orgId),
										$.bucket.gte(startMs),
										$.bucket.lt(endMs),
									])
									.groupBy("signal"),
							),
						),
						endMs - startMs > HOURLY_MAX_MS
							? Effect.succeed([])
							: dbExecute((db) =>
									db.run(
										PG.from(OrgIngestRuleStats)
											.select(($) => ({
												ruleId: $.ruleId,
												bucket: $.bucket,
												matched: PG.sum($.matched),
											}))
											.where(($) => [
												$.orgId.eq(orgId),
												$.bucket.gte(startMs),
												$.bucket.lt(endMs),
											])
											.groupBy("ruleId", "bucket")
											.orderBy(($) => [[$.bucket, "asc"]]),
									),
								),
					],
					{ concurrency: "unbounded" },
				)
				return {
					rules: byRule.map((row) => ({ ruleId: row.ruleId, ...counts(row) })),
					signals: bySignal.map((row) => ({ signal: row.signal, ...counts(row) })),
					hourly: hourly.map((row) => ({
						ruleId: row.ruleId,
						bucket: row.bucket,
						matched: Number(row.matched ?? 0),
					})),
				} satisfies IngestRuleStatsWindow
			})

			return { list, get, create, update, delete: remove, stats }
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
