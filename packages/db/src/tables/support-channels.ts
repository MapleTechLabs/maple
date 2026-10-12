import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgId } from "@maple/domain/primitives"

/**
 * The org's shared Slack channel with the Maple team: one per org, created in Maple's own
 * workspace and shared into the customer's with Slack Connect invites.
 *
 * The row is written before the channel exists (`slackChannelId` null, `reservedAt` set) so two
 * members pressing the button together create one channel, not two.
 */
export const OrgSupportChannels = PG.table("org_support_channels", {
	columns: {
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		slackChannelId: PG.column(PG.nullable(PG.text), { name: "slack_channel_id" }),
		slackChannelName: PG.column(PG.nullable(PG.text), { name: "slack_channel_name" }),
		/** Owner of the creation in flight; only it may finalize or release the reservation. */
		reservationId: PG.column(PG.nullable(PG.text), { name: "reservation_id" }),
		/** A creation in flight; cleared once the channel exists, and treated as stale after a lease. */
		reservedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "reserved_at" }),
		createdByUserId: PG.column(PG.text, { name: "created_by_user_id" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["orgId"],
	tenantColumn: "orgId",
})

export type OrgSupportChannelRow = PG.SelectRowOf<typeof OrgSupportChannels>
export type OrgSupportChannelInsert = PG.InsertRowOf<typeof OrgSupportChannels>
