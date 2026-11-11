import type { OrgMember, OrgMembersServiceApi } from "@maple/backend/services/org/OrgMembersService"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import type { OrgId } from "@maple/primitives"
import { Cause, Effect, Array as Arr } from "effect"

/**
 * The org's current members by user id, for putting names on audit records. Never fails: an
 * unconfigured or unavailable directory answers with nobody and the records keep their ids.
 */
export const orgMemberDirectory = (
	members: Pick<OrgMembersServiceApi, "listMembers">,
	orgId: OrgId,
): Effect.Effect<ReadonlyMap<string, OrgMember>> =>
	members.listMembers(orgId).pipe(
		Effect.map((all) => new Map(Arr.map(all, (member) => [member.userId, member] as const))),
		Effect.catchCause((cause) =>
			Cause.hasInterruptsOnly(cause)
				? Effect.interrupt
				: Effect.logWarning("Member directory unavailable; audit records keep their ids").pipe(
						Effect.annotateLogs({ error: summarizeCause(cause) }),
						Effect.as(new Map<string, OrgMember>()),
					),
		),
	)
