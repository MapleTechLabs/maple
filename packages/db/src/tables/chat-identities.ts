import * as PG from "@maple-dev/effect-orm/postgres"
import { ChatConnectorId, ChatIdentityId, OrgId, UserId } from "@maple/domain/primitives"

// One row per chat account a person has proved they control, bound to the Maple user they were
// signed in as when they proved it. It is the whole answer to "who is this clicking a button":
// the bot is still an org-level actor for reading, but a WRITE it proposes runs as the Maple user
// behind this row, under that user's own roles.
//
// The binding is per org, not global: the same person on the same platform may belong to two
// Maple orgs as two different users, and a row minted for one must never speak for the other.
//
// No tokens: the authorization proves control of the chat account at that moment and is
// discarded. Maple never acts on the platform as the person, only as the bot.
//
// `org_id` and `user_id` carry no foreign key: orgs and users live in Clerk, not Postgres. Org
// deletion is handled by the explicit `ORG_SCOPED_TABLES` purge list in
// `packages/backend/src/services/org/OrganizationService.ts`; this table must be listed there.

export const ChatIdentities = PG.table("chat_identities", {
	columns: {
		id: PG.brand(PG.text, ChatIdentityId),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		/** The connector that owns this row (`ChatConnectorId`). */
		connector: PG.brand(PG.text, ChatConnectorId),
		/** The platform's own id for the account: what ingress reports as an action's `actor.id`. */
		externalUserId: PG.column(PG.text, { name: "external_user_id" }),
		/** The Maple user a change approved from that account runs as. */
		userId: PG.column(PG.brand(PG.text, UserId), { name: "user_id" }),
		/**
		 * What the platform showed for the account when it was linked. Display only (nothing is
		 * ever resolved by it), and it is nullable because a platform need not report one.
		 *
		 * Stored rather than read fresh because the only reader that HAS a fresh one is the bot,
		 * which already knows who clicked; the settings card has nothing but this row, and
		 * "Linked as 1122334455667788990" is not an answer.
		 */
		displayName: PG.column(PG.nullable(PG.text), { name: "display_name" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		// One chat account speaks for at most one Maple user per org: the constraint the whole
		// feature rests on, and what makes the bot's `(org, connector, external id)` lookup
		// unambiguous. Re-linking takes the account over from whoever held it.
		PG.uniqueIndex("chat_identities_org_connector_external_idx", ["orgId", "connector", "externalUserId"]),
		// And at most one account per person per connector, which is the other direction of the
		// same rule. Without it somebody who re-linked after losing an account would leave the old
		// one able to approve as them: standing authority they cannot see, since the card and the
		// API both show a single link.
		PG.uniqueIndex("chat_identities_org_connector_user_idx", ["orgId", "connector", "userId"]),
		// Every row a user holds in an org, for unlinking the lot when they leave it.
		PG.index("chat_identities_org_user_idx", ["orgId", "userId"]),
	],
	tenantColumn: "orgId",
})

export type ChatIdentityRow = PG.SelectRowOf<typeof ChatIdentities>
