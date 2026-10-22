import * as PG from "@maple-dev/effect-orm/postgres"
import { AwsAccountId, AwsConnectionId, AwsModule, OrgId, SourceId } from "@maple/domain/primitives"
import { Schema } from "effect"
import { Sources } from "./sources"

// One row per connected AWS account. Maple holds no secret for it: the customer's stack creates a
// role (named from `id`) that trusts Maple's own identity with `external_id`. `modules` is what
// the connection asks for; the check writes what the role was found to grant.
export const AwsConnections = PG.table("aws_connections", {
	columns: {
		id: PG.brand(PG.text, AwsConnectionId),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		// The source this integration sends as. Deleting the source deletes the row.
		sourceId: PG.column(PG.brand(PG.text, SourceId), { name: "source_id" }),
		accountId: PG.column(PG.brand(PG.text, AwsAccountId), { name: "account_id" }),
		externalId: PG.column(PG.text, { name: "external_id" }),
		modules: PG.jsonb(Schema.Array(AwsModule)),
		// What the latest check that assumed the role read off it. Null until one could.
		grantedModules: PG.column(PG.nullable(PG.jsonb(Schema.Array(AwsModule))), {
			name: "granted_modules",
		}),
		templateVersion: PG.column(PG.nullable(PG.int4), { name: "template_version" }),
		// First check that assumed the role: the setup is deployed. A failure before it is the
		// setup still being done, not a broken connection.
		verifiedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "verified_at" }),
		lastCheckedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_checked_at" }),
		lastCheckError: PG.column(PG.nullable(PG.text), { name: "last_check_error" }),
		// A check claims the row by moving this past now; it also orders the hourly sweep.
		checkLeaseUntil: PG.column(PG.nullable(PG.timestamptzMillis), { name: "check_lease_until" }),
		createdBy: PG.column(PG.text, { name: "created_by" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.index("aws_connections_source_idx", ["sourceId"]),
		PG.uniqueIndex("aws_connections_org_account_idx", ["orgId", "accountId"]),
	],
	foreignKeys: [
		PG.foreignKey({
			columns: ["sourceId"],
			references: Sources,
			foreignColumns: ["id"],
			onDelete: "cascade",
		}),
	],
	tenantColumn: "orgId",
})

export type AwsConnectionRow = PG.SelectRowOf<typeof AwsConnections>
