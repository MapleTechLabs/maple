import { Effect } from "effect"
import { type OrgId, UserId } from "@maple/primitives"
import * as Policy from "@maple/domain/policy"

const testUserId = UserId.make("user_acting_as")

/** Run a service call as an actor in `orgId` holding `permissions`, as a request or tool call would. */
export const actingAs = (orgId: OrgId, permissions: Policy.Grants, userId: UserId = testUserId) =>
	Effect.provideService(Policy.CurrentActor, { orgId, userId, permissions })
