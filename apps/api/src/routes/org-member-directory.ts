import type { OrgMember, OrgMembersServiceApi } from "@maple/backend/services/org/OrgMembersService"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import type { OrgId } from "@maple/primitives"
import { Cause, Effect, Array as Arr } from "effect"

const byUserId = (members: ReadonlyArray<OrgMember>): ReadonlyMap<string, OrgMember> =>
	new Map(Arr.map(members, (member) => [member.userId, member] as const))

/**
 * The directory for a caller whose answer depends on it: an outage fails. A deployment with no
 * directory at all (self-hosted without Clerk) has no members to look up, which is not a failure.
 */
export const orgMemberDirectoryOrFail = (members: Pick<OrgMembersServiceApi, "listMembers">, orgId: OrgId) =>
	members.listMembers(orgId).pipe(
		Effect.map(byUserId),
		Effect.catchTag("@maple/http/errors/AlertMemberDirectoryNotConfiguredError", () =>
			Effect.succeed<ReadonlyMap<string, OrgMember>>(new Map()),
		),
	)

/**
 * The org's current members by user id, for putting names on audit records. Never fails: an
 * unconfigured or unavailable directory answers with nobody and the records keep their ids.
 */
export const orgMemberDirectory = (
	members: Pick<OrgMembersServiceApi, "listMembers">,
	orgId: OrgId,
): Effect.Effect<ReadonlyMap<string, OrgMember>> =>
	members.listMembers(orgId).pipe(
		Effect.map(byUserId),
		Effect.catchCause((cause) =>
			Cause.hasInterruptsOnly(cause)
				? Effect.interrupt
				: Effect.logWarning("Member directory unavailable; audit records keep their ids").pipe(
						Effect.annotateLogs({ error: summarizeCause(cause) }),
						Effect.as(new Map<string, OrgMember>()),
					),
		),
	)
