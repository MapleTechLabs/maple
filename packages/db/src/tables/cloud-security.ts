import * as PG from "@maple-dev/effect-orm/postgres"
import {
	CloudFindingSeverity,
	CloudFindingSource,
	CloudFindingStatus,
	CloudSecurityFeed,
	CloudServiceState,
} from "@maple/domain/cloud-security"
import { AwsAccountId, AwsConnectionId, AwsRegion, OrgId } from "@maple/primitives"
import { Schema } from "effect"
import { AwsConnections } from "./aws-connections"

// What the AWS `security` module pulls: each finding at its latest version, and how each service
// answered in each region. Both go with their connection.

/** One finding from one service, as the service last reported it. */
export const CloudSecurityFindings = PG.table("cloud_security_findings", {
	columns: {
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		connectionId: PG.column(PG.brand(PG.text, AwsConnectionId), { name: "connection_id" }),
		accountId: PG.column(PG.brand(PG.text, AwsAccountId), { name: "account_id" }),
		region: PG.brand(PG.text, AwsRegion),
		source: PG.brand(PG.text, CloudFindingSource),
		/** The service's id for it: GuardDuty's finding id, the Security Hub ARN, Inspector's ARN. */
		findingId: PG.column(PG.text, { name: "finding_id" }),
		/** The service's type, like `UnauthorizedAccess:EC2/SSHBruteForce` or a control id. */
		type: PG.text,
		title: PG.text,
		description: PG.nullable(PG.text),
		severity: PG.brand(PG.text, CloudFindingSeverity),
		status: PG.brand(PG.text, CloudFindingStatus),
		/** The affected resource as the service names it: `AwsEc2Instance`, `Instance`, `AWS::S3::Bucket`. */
		resourceType: PG.column(PG.text, { name: "resource_type" }),
		/** Its id: an instance id, a function or bucket name, an ARN. Matched against telemetry. */
		resourceId: PG.column(PG.text, { name: "resource_id" }),
		resourceName: PG.column(PG.nullable(PG.text), { name: "resource_name" }),
		/** How many times the service saw it. 1 for services that do not count. */
		occurrences: PG.column(PG.int4, { default: 1 }),
		firstSeenAt: PG.column(PG.timestamptzMillis, { name: "first_seen_at" }),
		lastSeenAt: PG.column(PG.timestamptzMillis, { name: "last_seen_at" }),
		/** The service's own updated time; the poller's cursor moves along it. */
		providerUpdatedAt: PG.column(PG.timestamptzMillis, { name: "provider_updated_at" }),
		/** When Maple first saw it closed (archived or resolved); null while open. Pruning counts from it. */
		closedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "closed_at" }),
		/** The service's finding, trimmed; null when it was too large to keep. */
		detail: PG.nullable(PG.jsonb(Schema.Record(Schema.String, Schema.Unknown))),
		syncedAt: PG.column(PG.timestamptzMillis, { name: "synced_at" }),
	},
	primaryKey: ["orgId", "connectionId", "region", "source", "findingId"],
	indexes: [
		PG.index("cloud_security_findings_org_status_idx", ["orgId", "status", "lastSeenAt"]),
		PG.index("cloud_security_findings_org_resource_idx", ["orgId", "resourceId"]),
	],
	foreignKeys: [
		// On the org as well as the id: a row can only name a connection of its own org.
		PG.foreignKey({
			columns: ["orgId", "connectionId"],
			references: AwsConnections,
			foreignColumns: ["orgId", "id"],
			onDelete: "cascade",
		}),
	],
	tenantColumn: "orgId",
})

export type CloudSecurityFindingRow = PG.SelectRowOf<typeof CloudSecurityFindings>

/** One service in one region of one connection: whether it is on, and how far the poller read. */
export const CloudSecurityServiceStates = PG.table("cloud_security_service_states", {
	columns: {
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		connectionId: PG.column(PG.brand(PG.text, AwsConnectionId), { name: "connection_id" }),
		region: PG.brand(PG.text, AwsRegion),
		source: PG.brand(PG.text, CloudSecurityFeed),
		state: PG.brand(PG.text, CloudServiceState),
		/** The newest `provider_updated_at` stored; the next poll reads from here. Null: never read. */
		cursorAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "cursor_at" }),
		/** For feeds read in time windows: the window size the last read ended on, where the next starts. */
		windowMs: PG.column(PG.nullable(PG.int8), { name: "window_ms" }),
		lastError: PG.column(PG.nullable(PG.text), { name: "last_error" }),
		checkedAt: PG.column(PG.timestamptzMillis, { name: "checked_at" }),
	},
	primaryKey: ["orgId", "connectionId", "region", "source"],
	indexes: [PG.index("cloud_security_service_states_org_idx", ["orgId"])],
	foreignKeys: [
		// On the org as well as the id: a row can only name a connection of its own org.
		PG.foreignKey({
			columns: ["orgId", "connectionId"],
			references: AwsConnections,
			foreignColumns: ["orgId", "id"],
			onDelete: "cascade",
		}),
	],
	tenantColumn: "orgId",
})

export type CloudSecurityServiceStateRow = PG.SelectRowOf<typeof CloudSecurityServiceStates>
