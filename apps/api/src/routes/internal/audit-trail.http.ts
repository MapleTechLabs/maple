import { HttpApiBuilder } from "effect/http-api"
import {
	AuditTrailForbiddenError,
	AuditTrailPersistenceError,
	CurrentTenant,
	MapleInternalApi,
} from "@maple/domain/http"
import type { AuditTrailEntry } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { recordHttpAudit } from "@maple/backend/services/audit/AuditLogService"
import { AuditDetectionsService } from "@maple/backend/services/audit-trail/AuditDetectionsService"
import { AuditTrailService } from "@maple/backend/services/audit-trail/AuditTrailService"
import type { OrgMember } from "@maple/backend/services/org/OrgMembersService"
import { OrgMembersService } from "@maple/backend/services/org/OrgMembersService"
import { Effect, Array as Arr, Option, String as Str } from "effect"
import { orgMemberDirectory, orgMemberDirectoryOrFail } from "@/routes/org-member-directory"
import { auditDiff } from "@/routes/v2/audit-changes"

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

const detectionAuditDiff = auditDiff({
	fields: ["name", "enabled", "filters", "windowMinutes", "threshold", "severity", "destinationIds"],
})

/**
 * The tenant, once it may read the audit log. Detections sit behind the same gate as the events:
 * a rule that counts them says what the log holds, so only the people who may read it write one.
 */
const requireAuditLogRead = Effect.gen(function* () {
	const tenant = yield* CurrentTenant.Context
	yield* Policy.check(
		tenant.roles,
		"audit_log:read",
		(denial) => new AuditTrailForbiddenError({ message: denial.message }),
	)
	return tenant
})

export const HttpAuditTrailLive = HttpApiBuilder.group(MapleInternalApi, "auditTrail", (handlers) =>
	Effect.gen(function* () {
		const trail = yield* AuditTrailService
		const detections = yield* AuditDetectionsService
		const members = yield* OrgMembersService

		return handlers
			.handle("list", ({ query }) =>
				Effect.gen(function* () {
					// Every platform's actor emails and origin IPs: the same gate as Maple's own audit log.
					const tenant = yield* requireAuditLogRead
					// Only Maple's own events store a user id where the page shows an email.
					const emailActor =
						query.actor !== undefined &&
						Str.includes("@")(query.actor) &&
						(query.provider === undefined || query.provider === "maple")
							? query.actor
							: undefined
					// The filter's answer depends on this lookup, so an outage fails the request: a
					// page that silently left the member's Maple events out would read as complete.
					const filterDirectory =
						emailActor === undefined
							? undefined
							: yield* orgMemberDirectoryOrFail(members, tenant.orgId).pipe(
									Effect.mapError(
										(error) =>
											new AuditTrailPersistenceError({
												message:
													"The member directory is unavailable, so an email cannot be matched to a member",
												cause: error._tag,
											}),
									),
								)
					const actorAlias =
						emailActor === undefined || filterDirectory === undefined
							? Option.none()
							: memberByEmail(filterDirectory, emailActor)
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
					// Names are decoration: without a directory the page still shows every id.
					const directory =
						filterDirectory ??
						(Arr.some(page.events, (event) => unnamedMapleUserId(event) !== null)
							? yield* orgMemberDirectory(members, tenant.orgId)
							: new Map<string, OrgMember>())
					return {
						events: nameMapleUsers(page.events, directory),
						nextCursor: page.next === null ? null : `${page.next.occurredAtMs}:${page.next.id}`,
					}
				}),
			)
			.handle("listDetections", () =>
				Effect.gen(function* () {
					const tenant = yield* requireAuditLogRead
					return { detections: yield* detections.list(tenant.orgId) }
				}),
			)
			.handle("createDetection", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* requireAuditLogRead
					const created = yield* detections.create(tenant.orgId, {
						...payload,
						createdBy: tenant.userId,
					})
					yield* recordHttpAudit("alert_rule.created", {
						resourceId: created.id,
						metadata: { name: created.name, signalType: "audit" },
					})
					return created
				}),
			)
			.handle("updateDetection", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* requireAuditLogRead
					const current = yield* detections.get(tenant.orgId, params.id)
					const updated = yield* detections.update(tenant.orgId, params.id, {
						...payload,
						updatedBy: tenant.userId,
					})
					yield* recordHttpAudit("alert_rule.updated", {
						resourceId: updated.id,
						changes: detectionAuditDiff(payload, current, updated),
						metadata: { name: updated.name, signalType: "audit" },
					})
					return updated
				}),
			)
			.handle("deleteDetection", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* requireAuditLogRead
					const id = yield* detections.remove(tenant.orgId, params.id)
					yield* recordHttpAudit("alert_rule.deleted", {
						resourceId: id,
						metadata: { signalType: "audit" },
					})
					return { id }
				}),
			)
	}),
)
