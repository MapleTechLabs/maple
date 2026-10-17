import type { AuditActorType, AuditOutcome } from "@maple/domain/http"
import { Effect } from "effect"
import { Atom } from "@/lib/effect-atom"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"

export const AUDIT_LOG_PAGE_LIMIT = 50

const ACTOR_TYPES: ReadonlyArray<AuditActorType> = ["user", "api_key", "agent", "system"]
const OUTCOMES: ReadonlyArray<AuditOutcome> = ["allowed", "denied"]

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

// None of the filter values contain "|" (actor types, outcomes, `user_…`/`key_…` ids, ISO
// timestamps), and the cursor is the trailing segment, so splitting on the first five
// separators stays unambiguous even for exotic cursors.
const family = Atom.family((key: string) => {
	const parts = key.split("|", 5)
	const [actorRaw = "", outcomeRaw = "", actorId = "", since = "", until = ""] = parts
	const cursor = key.slice(parts.reduce((length, part) => length + part.length + 1, 0))
	const actorType = ACTOR_TYPES.find((type) => type === actorRaw)
	const outcome = OUTCOMES.find((value) => value === outcomeRaw)

	return MapleApiV2AtomClient.runtime.atom(
		Effect.gen(function* () {
			const client = yield* MapleApiV2AtomClient
			return yield* client.auditLog.list({
				query: {
					limit: AUDIT_LOG_PAGE_LIMIT,
					...(cursor !== "" ? { cursor } : undefined),
					...(actorType !== undefined ? { actor_type: actorType } : undefined),
					...(actorId !== "" ? { actor_id: actorId } : undefined),
					...(outcome !== undefined ? { outcome } : undefined),
					...(since !== "" ? { since } : undefined),
					...(until !== "" ? { until } : undefined),
				},
			})
		}),
	)
})

/** One page of the org's audit log, keyed by cursor + filters + the pinned ceiling. */
export const auditLogPageAtom = (input: AuditLogPageInput) =>
	family(
		[
			input.actorType ?? "",
			input.outcome ?? "",
			input.actorId ?? "",
			input.since ?? "",
			input.until ?? "",
			input.cursor ?? "",
		].join("|"),
	)
