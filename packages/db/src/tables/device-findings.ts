import * as PG from "@maple-dev/effect-orm/postgres"
import { DeviceRef, DeviceSourceKind, VulnerableSoftware } from "@maple/domain/device-security"
import { OrgId } from "@maple/primitives"
import { Schema } from "effect"

// What the org's device management tools report, one shape for every source. A source's sync
// replaces its connection's rows; the source deletes them when the connection goes. Links are
// stored as the source builds them, so reading needs no source.

/** A policy at least one device fails. A policy every device passes has no row. */
export const DevicePolicyFindings = PG.table("device_policy_findings", {
	columns: {
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		source: PG.brand(PG.text, DeviceSourceKind),
		connectionId: PG.column(PG.text, { name: "connection_id" }),
		policyId: PG.column(PG.text, { name: "policy_id" }),
		name: PG.text,
		/** The device group the policy is set for, as the source names it (a Fleet fleet); null for no one group. */
		groupName: PG.column(PG.nullable(PG.text), { name: "group_name" }),
		description: PG.nullable(PG.text),
		resolution: PG.nullable(PG.text),
		critical: PG.bool,
		/** Comma-joined platforms the policy runs on (`darwin,windows`); null for every platform. */
		platform: PG.nullable(PG.text),
		failingDeviceCount: PG.column(PG.int4, { name: "failing_device_count" }),
		/** Null when the source does not count passing devices. */
		passingDeviceCount: PG.column(PG.nullable(PG.int4), { name: "passing_device_count" }),
		failingDevices: PG.column(PG.jsonb(Schema.Array(DeviceRef)), { name: "failing_devices" }),
		/** When the source last counted the policy's devices. */
		countedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "counted_at" }),
		url: PG.text,
		firstSeenAt: PG.column(PG.timestamptzMillis, { name: "first_seen_at" }),
		lastSeenAt: PG.column(PG.timestamptzMillis, { name: "last_seen_at" }),
	},
	primaryKey: ["orgId", "source", "connectionId", "policyId"],
	tenantColumn: "orgId",
})

export type DevicePolicyFindingRow = PG.SelectRowOf<typeof DevicePolicyFindings>

/** A CVE in software installed on at least one device. Scores are null where the source has none. */
export const DeviceVulnerabilityFindings = PG.table("device_vulnerability_findings", {
	columns: {
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		source: PG.brand(PG.text, DeviceSourceKind),
		connectionId: PG.column(PG.text, { name: "connection_id" }),
		cve: PG.text,
		cvssScore: PG.column(PG.nullable(PG.float8), { name: "cvss_score" }),
		epssProbability: PG.column(PG.nullable(PG.float8), { name: "epss_probability" }),
		/** On CISA's known exploited list; null when the source does not say. */
		knownExploited: PG.column(PG.nullable(PG.bool), { name: "known_exploited" }),
		detailsLink: PG.column(PG.nullable(PG.text), { name: "details_link" }),
		/** Devices with any affected version, summed across versions: a device with two counts twice. */
		deviceCount: PG.column(PG.int4, { name: "device_count" }),
		software: PG.jsonb(Schema.Array(VulnerableSoftware)),
		url: PG.text,
		firstSeenAt: PG.column(PG.timestamptzMillis, { name: "first_seen_at" }),
		lastSeenAt: PG.column(PG.timestamptzMillis, { name: "last_seen_at" }),
	},
	primaryKey: ["orgId", "source", "connectionId", "cve"],
	tenantColumn: "orgId",
})

export type DeviceVulnerabilityFindingRow = PG.SelectRowOf<typeof DeviceVulnerabilityFindings>
