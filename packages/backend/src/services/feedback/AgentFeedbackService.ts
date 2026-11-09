import { randomUUID } from "node:crypto"
import * as PG from "@maple-dev/effect-orm/postgres"
import { AgentFeedback as AgentFeedbackTable, type AgentFeedbackRow } from "@maple/db/tables"
import {
	AgentFeedbackImpact,
	AgentFeedbackKind,
	AgentFeedbackPersistenceError,
	AgentFeedbackSource,
	AgentFeedbackTriageForbiddenError,
	AgentType,
} from "@maple/domain/http"
import { AgentFeedbackId, type OrgId, type UserId } from "@maple/domain/primitives"
import { Array as Arr, Clock, Context, Effect, Layer, Option, Schema, String as Str } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { Env } from "@maple/backend/platform/Env"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"

export interface AgentFeedback {
	readonly id: AgentFeedbackId
	readonly orgId: OrgId
	readonly userId: UserId
	readonly kind: AgentFeedbackKind
	readonly impact: AgentFeedbackImpact | null
	readonly summary: string
	readonly reason: string
	readonly details: string | null
	readonly relatedTo: string | null
	readonly agent: {
		readonly type: AgentType
		readonly name: string | null
		readonly model: string | null
		readonly version: string | null
	}
	readonly source: AgentFeedbackSource
	readonly createdAtMs: number
}

export interface SubmitAgentFeedbackInput {
	readonly kind: AgentFeedbackKind
	readonly impact?: AgentFeedbackImpact | undefined
	readonly summary: string
	readonly reason: string
	readonly details?: string | undefined
	readonly relatedTo?: string | undefined
	readonly agent: {
		readonly type: AgentType
		readonly name?: string | undefined
		readonly model?: string | undefined
		readonly version?: string | undefined
	}
	readonly source: AgentFeedbackSource
}

/** The Maple team's cross-org read. Every filter narrows; none set reads the newest across all orgs. */
export interface AgentFeedbackTriageFilter {
	readonly kind?: AgentFeedbackKind | undefined
	readonly impact?: AgentFeedbackImpact | undefined
	readonly sinceMs?: number | undefined
	/** Case-insensitive substring of `related_to`. */
	readonly relatedTo?: string | undefined
	readonly orgId?: OrgId | undefined
	readonly limit: number
}

export interface AgentFeedbackServiceApi {
	readonly submit: (
		orgId: OrgId,
		userId: UserId,
		input: SubmitAgentFeedbackInput,
	) => Effect.Effect<AgentFeedback, AgentFeedbackPersistenceError>
	/** Newest first; `limit`/`offset` are the caller's page, lookahead included. */
	readonly list: (
		orgId: OrgId,
		page: { readonly limit: number; readonly offset: number },
	) => Effect.Effect<ReadonlyArray<AgentFeedback>, AgentFeedbackPersistenceError>
	/**
	 * Feedback from every org, newest first. Only `MAPLE_INTERNAL_ORG_ID` may call it; any other
	 * caller, or any caller while it is unset, is refused before the database is touched.
	 */
	readonly triage: (
		callerOrgId: OrgId,
		filter: AgentFeedbackTriageFilter,
	) => Effect.Effect<
		ReadonlyArray<AgentFeedback>,
		AgentFeedbackPersistenceError | AgentFeedbackTriageForbiddenError
	>
}

const makePersistenceError = makePersistenceErrorMapper(
	AgentFeedbackPersistenceError,
	"Agent feedback persistence failed",
)

const decodeId = Schema.decodeUnknownSync(AgentFeedbackId)
const decodeKind = Schema.decodeUnknownSync(AgentFeedbackKind)
const decodeImpact = Schema.decodeUnknownSync(Schema.NullOr(AgentFeedbackImpact))
const decodeAgentType = Schema.decodeUnknownSync(AgentType)
const decodeSource = Schema.decodeUnknownSync(AgentFeedbackSource)

/** Blank optional strings are stored as null, so "not said" has one spelling. */
const nonBlank = (value: string | undefined): string | null => {
	const trimmed = typeof value === "string" ? Str.trim(value) : undefined
	return trimmed === undefined || trimmed.length === 0 ? null : trimmed
}

const toFeedback = (row: AgentFeedbackRow): AgentFeedback => ({
	id: decodeId(row.id),
	orgId: row.orgId,
	userId: row.userId,
	kind: decodeKind(row.kind),
	impact: decodeImpact(row.impact),
	summary: row.summary,
	reason: row.reason,
	details: row.details,
	relatedTo: row.relatedTo,
	agent: {
		type: decodeAgentType(row.agentType),
		name: row.agentName,
		model: row.agentModel,
		version: row.agentVersion,
	},
	source: decodeSource(row.source),
	createdAtMs: row.createdAt,
})

export class AgentFeedbackService extends Context.Service<AgentFeedbackService, AgentFeedbackServiceApi>()(
	"@maple/backend/services/feedback/AgentFeedbackService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const env = yield* Env
			const internalOrgId = Option.getOrUndefined(env.MAPLE_INTERNAL_ORG_ID)
			const dbExecute = makeDbExecute(database, "AgentFeedbackService", makePersistenceError)

			const submit = Effect.fn("AgentFeedbackService.submit")(function* (
				orgId: OrgId,
				userId: UserId,
				input: SubmitAgentFeedbackInput,
			) {
				const agentName = nonBlank(input.agent.name)
				yield* Effect.annotateCurrentSpan({
					orgId,
					"tenant.userId": userId,
					"maple.feedback.kind": input.kind,
					"maple.feedback.source": input.source,
					"maple.feedback.agent_type": input.agent.type,
					...(agentName !== null ? { "maple.feedback.agent_name": agentName } : undefined),
				})
				const now = yield* Clock.currentTimeMillis
				const rows = yield* dbExecute((db) =>
					db.run(
						PG.insertInto(AgentFeedbackTable)
							.values({
								id: randomUUID(),
								orgId,
								userId,
								kind: input.kind,
								impact: input.impact ?? null,
								summary: Str.trim(input.summary),
								reason: Str.trim(input.reason),
								details: nonBlank(input.details),
								relatedTo: nonBlank(input.relatedTo),
								agentType: input.agent.type,
								agentName,
								agentModel: nonBlank(input.agent.model),
								agentVersion: nonBlank(input.agent.version),
								source: input.source,
								createdAt: now,
							})
							.returning(),
					),
				)
				const row = rows[0]
				if (row === undefined) {
					return yield* new AgentFeedbackPersistenceError({ message: "Insert returned no row" })
				}
				return toFeedback(row)
			})

			const list = Effect.fn("AgentFeedbackService.list")(function* (
				orgId: OrgId,
				page: { readonly limit: number; readonly offset: number },
			) {
				yield* Effect.annotateCurrentSpan({ orgId })
				const rows = yield* dbExecute((db) =>
					db.run(
						PG.from(AgentFeedbackTable)
							.select()
							.where(($) => [$.orgId.eq(orgId)])
							.orderBy(["createdAt", "desc"], ["id", "desc"])
							.limit(page.limit)
							.offset(page.offset),
					),
				)
				return Arr.map(rows, toFeedback)
			})

			const triage = Effect.fn("AgentFeedbackService.triage")(function* (
				callerOrgId: OrgId,
				filter: AgentFeedbackTriageFilter,
			) {
				yield* Effect.annotateCurrentSpan({
					orgId: callerOrgId,
					"maple.feedback.limit": filter.limit,
				})
				if (internalOrgId === undefined || callerOrgId !== internalOrgId) {
					return yield* new AgentFeedbackTriageForbiddenError({
						message: "Reading agent feedback across organizations is limited to the Maple team.",
					})
				}
				const related = nonBlank(filter.relatedTo)
				const pattern = related === null ? undefined : `%${Str.replace(/[\\%_]/g, "\\$&")(related)}%`
				const rows = yield* dbExecute((db) =>
					db.run(
						PG.from(AgentFeedbackTable)
							.select()
							.where(($) => [
								filter.orgId === undefined ? undefined : $.orgId.eq(filter.orgId),
								filter.kind === undefined ? undefined : $.kind.eq(filter.kind),
								filter.impact === undefined ? undefined : $.impact.eq(filter.impact),
								filter.sinceMs === undefined ? undefined : $.createdAt.gte(filter.sinceMs),
								pattern === undefined ? undefined : $.relatedTo.ilike(pattern),
							])
							.orderBy(["createdAt", "desc"], ["id", "desc"])
							.limit(filter.limit)
							.crossTenant(),
					),
				)
				yield* Effect.annotateCurrentSpan("result.rowCount", rows.length)
				return Arr.map(rows, toFeedback)
			})

			return { submit, list, triage } satisfies AgentFeedbackServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
