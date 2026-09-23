import type { ChatConnectorId, ChatIdentityId, OrgId, UserId } from "@maple/domain/primitives"
import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"

// One row per chat account a person has proved they control, bound to the Maple user they were
// signed in as when they proved it. It is the whole answer to "who is this clicking a button" —
// the bot is still an org-level actor for reading, but a WRITE it proposes runs as the Maple user
// behind this row, under that user's own roles.
//
// The binding is per org, not global: the same person on the same platform may belong to two
// Maple orgs as two different users, and a row minted for one must never speak for the other.
//
// Deliberately absent, and what it would take to add each back:
//
//   - no tokens. The authorization proves control of the chat account at that moment and is
//     discarded; Maple never acts on the platform as the person. Storing one would mean a refresh
//     loop, an encryption key and a revocation story, for a capability nothing wants.
//   - no `linked_by` / audit columns. `user_id` IS who linked it — the flow only ever binds the
//     caller's own account — and the audit log records what the link went on to do.
//   - no `updated_at`. A link is created or deleted, never edited; re-linking replaces the row.
//   - no expiry. A link lasts until the person unlinks it or leaves the org, which
//     `MembershipRevocationService` handles.
//
// `org_id` and `user_id` carry no foreign key: orgs and users live in Clerk, not Postgres. Org
// deletion is handled by the explicit `ORG_SCOPED_TABLES` purge list in
// `packages/backend/src/services/org/OrganizationService.ts` — this table must be listed there.

export const chatIdentities = pgTable(
	"chat_identities",
	{
		id: text("id").$type<ChatIdentityId>().notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		/** The connector that owns this row (`ChatConnectorId`). */
		connector: text("connector").$type<ChatConnectorId>().notNull(),
		/** The platform's own id for the account — what ingress reports as an action's `actor.id`. */
		externalUserId: text("external_user_id").notNull(),
		/** The Maple user a change approved from that account runs as. */
		userId: text("user_id").$type<UserId>().notNull(),
		/**
		 * What the platform showed for the account when it was linked. Display only — nothing is
		 * ever resolved by it, and it is nullable because a platform need not report one.
		 *
		 * Stored rather than read fresh because the only reader that HAS a fresh one is the bot,
		 * which already knows who clicked; the settings card has nothing but this row, and
		 * "Linked as 1122334455667788990" is not an answer.
		 */
		displayName: text("display_name"),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [
		// One chat account speaks for at most one Maple user per org — the constraint the whole
		// feature rests on, and what makes the bot's `(org, connector, external id)` lookup
		// unambiguous. Re-linking replaces the row rather than adding a second.
		uniqueIndex("chat_identities_org_connector_external_idx").on(
			table.orgId,
			table.connector,
			table.externalUserId,
		),
		// Every row a user holds in an org, for unlinking on revocation and for showing the caller
		// their own links.
		index("chat_identities_org_user_idx").on(table.orgId, table.userId),
	],
)

export type ChatIdentityRow = typeof chatIdentities.$inferSelect
