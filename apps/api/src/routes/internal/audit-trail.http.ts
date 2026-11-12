import { HttpApiBuilder } from "effect/http-api"
import { AuditTrailForbiddenError, CurrentTenant, MapleInternalApi } from "@maple/domain/http"
import type { AuditTrailEntry } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { AuditTrailService } from "@maple/backend/services/audit-trail/AuditTrailService"
import type { OrgMember } from "@maple/backend/services/org/OrgMembersService"
import { OrgMembersService } from "@maple/backend/services/org/OrgMembersService"
import { Effect, Array as Arr, Option, String as Str } from "effect"
import { orgMemberDirectory } from "@/routes/org-member-directory"

const DEFAULT_PAGE_LIMIT = 50

/** `<occurredAt ms>:<event id>`; the query schema has already checked the shape. */
const parseCursor = (cursor: string) => {
	const [occurredAtMs, id = ""] = Str.split(":")(cursor)
	return { occurredAtMs: Number(occurredAtMs), id }
}

/**
 * The user id of a Maple dashboard event stored without a name, else null. An event that froze
 * a label when it was written (a device credential) keeps it.
 */
const unnamedMapleUserId = (event: AuditTrailEntry): string | null =>
	event.provider === "maple" && event.actor.type === "user" && event.actor.name === null
		? event.actor.id
		: null

/** Put the member's current name and email on Maple's own user events; a departed id stays an id. */
const nameMapleUsers = (
	events: ReadonlyArray<AuditTrailEntry>,
	directory: ReadonlyMap<string, OrgMember>,
): ReadonlyArray<AuditTrailEntry> =>
	Arr.map(events, (event) => {
		const userId = unnamedMapleUserId(event)
		const member = userId === null ? undefined : directory.get(userId)
		return member === undefined
			? event
			: { ...event, actor: { ...event.actor, name: member.name, email: member.email } }
	})

/** The member an email belongs to. Maple's own events store the user id, never the email. */
const memberByEmail = (directory: ReadonlyMap<string, OrgMember>, email: string) =>
	Arr.findFirst(
		[...directory.values()],
		(member) => Str.toLowerCase(member.email) === Str.toLowerCase(email),
	)

export const HttpAuditTrailLive = HttpApiBuilder.group(MapleInternalApi, "auditTrail", (handlers) =>
	Effect.gen(function* () {
		const trail = yield* AuditTrailService
		const members = yield* OrgMembersService

		return handlers.handle("list", ({ query }) =>
			Effect.gen(function* () {
				const tenant = yield* CurrentTenant.Context
				// Every platform's actor emails and origin IPs: the same gate as Maple's own audit log.
				yield* Policy.check(
					tenant.roles,
					"audit_log:read",
					(denial) => new AuditTrailForbiddenError({ message: denial.message }),
				)
				// Read at most once a request: to resolve an email filter, or to name the page.
				const readDirectory = yield* Effect.cached(orgMemberDirectory(members, tenant.orgId))
				// Only Maple's own events store a user id where the page shows an email.
				const emailActor =
					query.actor !== undefined &&
					Str.includes("@")(query.actor) &&
					(query.provider === undefined || query.provider === "maple")
						? query.actor
						: undefined
				const actorAlias =
					emailActor === undefined
						? Option.none()
						: yield* Effect.map(readDirectory, (directory) =>
								memberByEmail(directory, emailActor),
							)
				const page = yield* trail.list(tenant.orgId, {
					...(query.provider !== undefined ? { provider: query.provider } : undefined),
					...(query.account !== undefined ? { account: query.account } : undefined),
					...(query.category !== undefined ? { category: query.category } : undefined),
					...(query.outcome !== undefined ? { outcome: query.outcome } : undefined),
					...(query.action !== undefined ? { action: query.action } : undefined),
					...(query.actor !== undefined ? { actor: query.actor } : undefined),
					...(Option.isSome(actorAlias) ? { actorAlias: actorAlias.value.userId } : undefined),
					...(query.since !== undefined ? { sinceMs: query.since } : undefined),
					...(query.until !== undefined ? { untilMs: query.until } : undefined),
					...(query.cursor !== undefined ? { before: parseCursor(query.cursor) } : undefined),
					limit: query.limit ?? DEFAULT_PAGE_LIMIT,
				})
				const directory = Arr.some(page.events, (event) => unnamedMapleUserId(event) !== null)
					? yield* readDirectory
					: new Map<string, OrgMember>()
				return {
					events: nameMapleUsers(page.events, directory),
					nextCursor: page.next === null ? null : `${page.next.occurredAtMs}:${page.next.id}`,
				}
			}),
		)
	}),
)
