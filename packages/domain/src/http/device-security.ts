import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Schema } from "effect"
import { DeviceRef, DeviceSourceKind, VulnerableSoftware } from "../device-security"
import { AuditedRead } from "./audit-log"
import { SessionAuthorization } from "./current-tenant"
import { IntegrationsForbiddenError, IntegrationsPersistenceError } from "./integrations"

// The Security hub's Devices page: what the org's device management tools report about its
// devices, merged across sources. Links go to each source's own pages.

/** A connected device management tool and how its last sync went. */
export class DeviceSource extends Schema.Class<DeviceSource>("DeviceSource")({
	kind: DeviceSourceKind,
	connectionId: Schema.String,
	/** The account or organization name the source reports. */
	label: Schema.NullOr(Schema.String),
	/** The source's web address. */
	url: Schema.String,
	/** Enrolled devices at the last sync. */
	deviceCount: Schema.NullOr(Schema.Number),
	syncedAt: Schema.NullOr(Schema.Number),
	/** Why the last sync failed; null once one succeeds. */
	error: Schema.NullOr(Schema.String),
	/** The source rejected the saved credential: nothing syncs until a new one is saved. */
	authFailed: Schema.Boolean,
	/** The source's full vulnerability list, past the ones listed here. */
	vulnerabilitiesUrl: Schema.NullOr(Schema.String),
	/** This source's CVEs past the 500 listed for it. */
	moreVulnerabilities: Schema.Number,
	/** This source's CVEs on CISA's known exploited list, listed or not. */
	knownExploitedVulnerabilities: Schema.Number,
}) {}

export class DevicePolicyFinding extends Schema.Class<DevicePolicyFinding>("DevicePolicyFinding")({
	source: DeviceSourceKind,
	connectionId: Schema.String,
	/** The source's own id for the policy. */
	policyId: Schema.String,
	name: Schema.String,
	/** The device group the policy belongs to, as the source names it (a Fleet fleet); null for every device. */
	groupName: Schema.NullOr(Schema.String),
	description: Schema.NullOr(Schema.String),
	resolution: Schema.NullOr(Schema.String),
	critical: Schema.Boolean,
	platform: Schema.NullOr(Schema.String),
	failingDeviceCount: Schema.Number,
	/** Null when the source does not count passing devices. */
	passingDeviceCount: Schema.NullOr(Schema.Number),
	/** A sample of the failing devices; the source decides how many. */
	failingDevices: Schema.Array(DeviceRef),
	countedAt: Schema.NullOr(Schema.Number),
	firstSeenAt: Schema.Number,
	url: Schema.String,
}) {}

export class DeviceVulnerabilityFinding extends Schema.Class<DeviceVulnerabilityFinding>(
	"DeviceVulnerabilityFinding",
)({
	source: DeviceSourceKind,
	connectionId: Schema.String,
	cve: Schema.String,
	/** Null when the source gives no score (Fleet Free). */
	cvssScore: Schema.NullOr(Schema.Number),
	epssProbability: Schema.NullOr(Schema.Number),
	knownExploited: Schema.NullOr(Schema.Boolean),
	detailsLink: Schema.NullOr(Schema.String),
	/** Devices with an affected version, summed across versions. */
	deviceCount: Schema.Number,
	software: Schema.Array(VulnerableSoftware),
	firstSeenAt: Schema.Number,
	url: Schema.String,
}) {}

export class DevicesResponse extends Schema.Class<DevicesResponse>("DevicesResponse")({
	/** Every connected source; empty when none is. */
	sources: Schema.Array(DeviceSource),
	/** Failing policies across sources, critical first, then by failing devices. */
	policies: Schema.Array(DevicePolicyFinding),
	/** CVEs across sources, highest score first, then by devices; at most 500 per source. */
	vulnerabilities: Schema.Array(DeviceVulnerabilityFinding),
	/** CVEs past those listed, summed across sources. */
	moreVulnerabilities: Schema.Number,
}) {}

export class DeviceSecurityApiGroup extends HttpApiGroup.make("deviceSecurity")
	.add(
		HttpApiEndpoint.get("devices", "/devices", {
			success: DevicesResponse,
			error: [IntegrationsForbiddenError, IntegrationsPersistenceError],
		}),
	)
	.prefix("/internal/device-security")
	.middleware(SessionAuthorization)
	// Device names, policies they fail and the software on them.
	.annotate(AuditedRead, "telemetry.read") {}
