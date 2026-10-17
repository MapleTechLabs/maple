import type { AuditActorType, AuditOutcome } from "@maple/domain/http"
import { Effect } from "effect"
import { Atom } from "@/lib/effect-atom"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"

export const AUDIT_LOG_PAGE_LIMIT = 50

export interface AuditLogPageInput {
	readonly cursor?: string
	readonly actorType?: AuditActorType
	readonly actorId?: string
	readonly outcome?: AuditOutcome
	/** Lower bound on `occurred_at`, from the date range filter. */
	readonly since?: string
	/**
	 * Upper bound on `occurred_at`: the date range's end, or the ceiling the caller pins when it
	 * takes the first page. Pagination here is offset-based over a newest-first, append-only
	 * table, so an entry written mid-scroll would otherwise repeat a row and skip another.
	 */
	readonly until?: string
}

// Keyed by a plain struct (Effect's structural equality), so no value can bleed into another field.
interface AuditLogPageKey {
	readonly cursor: string | undefined
	readonly actorType: AuditActorType | undefined
	readonly actorId: string | undefined
	readonly outcome: AuditOutcome | undefined
	readonly since: string | undefined
	readonly until: string | undefined
}

const family = Atom.family(({ cursor, actorType, actorId, outcome, since, until }: AuditLogPageKey) =>
	MapleApiV2AtomClient.runtime.atom(
		Effect.gen(function* () {
			const client = yield* MapleApiV2AtomClient
			return yield* client.auditLog.list({
				query: {
					limit: AUDIT_LOG_PAGE_LIMIT,
					...(cursor !== undefined ? { cursor } : undefined),
					...(actorType !== undefined ? { actor_type: actorType } : undefined),
					...(actorId !== undefined ? { actor_id: actorId } : undefined),
					...(outcome !== undefined ? { outcome } : undefined),
					...(since !== undefined ? { since } : undefined),
					...(until !== undefined ? { until } : undefined),
				},
			})
		}),
	),
)

/** One page of the org's audit log, keyed by cursor + filters + the pinned ceiling. */
export const auditLogPageAtom = (input: AuditLogPageInput) =>
	family({
		cursor: input.cursor,
		actorType: input.actorType,
		actorId: input.actorId,
		outcome: input.outcome,
		since: input.since,
		until: input.until,
	})
