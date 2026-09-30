import { randomUUID } from "node:crypto"
import { agentFeedback, type AgentFeedbackRow } from "@maple/db"
import {
	AgentFeedbackImpact,
	AgentFeedbackKind,
	AgentFeedbackPersistenceError,
	AgentFeedbackSource,
	AgentType,
} from "@maple/domain/http"
import { AgentFeedbackId, type OrgId, type UserId } from "@maple/domain/primitives"
import { desc, eq } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { dateToMs, msToDate } from "@maple/backend/platform/time"

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
	const trimmed = value?.trim()
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
	createdAtMs: dateToMs(row.createdAt),
})

export class AgentFeedbackService extends Context.Service<AgentFeedbackService, AgentFeedbackServiceApi>()(
	"@maple/api/services/feedback/AgentFeedbackService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
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
				const now = msToDate(yield* Clock.currentTimeMillis)
				const rows = yield* dbExecute((db) =>
					db
						.insert(agentFeedback)
						.values({
							id: randomUUID(),
							orgId,
							userId,
							kind: input.kind,
							impact: input.impact ?? null,
							summary: input.summary.trim(),
							reason: input.reason.trim(),
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
					db
						.select()
						.from(agentFeedback)
						.where(eq(agentFeedback.orgId, orgId))
						.orderBy(desc(agentFeedback.createdAt), desc(agentFeedback.id))
						.limit(page.limit)
						.offset(page.offset),
				)
				return rows.map(toFeedback)
			})

			return { submit, list } satisfies AgentFeedbackServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
