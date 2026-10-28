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
import { OrgIngestRuleSettings, OrgIngestRules, type OrgIngestRuleRow } from "@maple/db/tables"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { Database, type DatabaseError } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"

export interface IngestRuleInput {
	readonly name: string
	readonly enabled?: boolean
	readonly position?: number
	readonly spec: IngestRuleSpec
}

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

const MAX_POSITION = 10_000

/** What the HTTP schema checks, again here so MCP and other callers cannot skip it. */
const fieldProblems = (fields: {
	readonly name?: string
	readonly position?: number
}): ReadonlyArray<string> => [
	...(fields.name !== undefined &&
	(fields.name.trim().length === 0 || fields.name.trim().length > INGEST_RULE_LIMITS.nameLength)
		? [`the name must be 1 to ${INGEST_RULE_LIMITS.nameLength} characters`]
		: []),
	...(fields.position !== undefined &&
	(!Number.isInteger(fields.position) || fields.position < 0 || fields.position > MAX_POSITION)
		? [`position is a whole number from 0 to ${MAX_POSITION}`]
		: []),
]

const validateFields = Effect.fnUntraced(function* (fields: {
	readonly name?: string
	readonly position?: number
}) {
	const problems = fieldProblems(fields)
	if (problems.length > 0) {
		return yield* new IngestRuleValidationError({
			message: `Invalid ingest rule: ${problems.join("; ")}`,
			problems,
		})
	}
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
				yield* validateFields(input)
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
				yield* validateFields(patch)
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

			return { list, get, create, update, delete: remove }
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
