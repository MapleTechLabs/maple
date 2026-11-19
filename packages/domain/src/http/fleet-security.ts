import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Schema } from "effect"
import { AuditedRead } from "./audit-log"
import { SessionAuthorization } from "./current-tenant"
import { IntegrationsForbiddenError, IntegrationsPersistenceError } from "./integrations"

// The Security hub's Devices page: what the org's Fleet server reports about its devices,
// synced hourly. Links go to the Fleet server's own pages.

export class FleetDevicesConnection extends Schema.Class<FleetDevicesConnection>("FleetDevicesConnection")({
	organizationName: Schema.NullOr(Schema.String),
	baseUrl: Schema.String,
	licenseTier: Schema.NullOr(Schema.String),
	/** Enrolled devices at the last sync. */
	hostCount: Schema.NullOr(Schema.Number),
	syncedAt: Schema.NullOr(Schema.Number),
	/** Why the last sync failed; null once one succeeds. */
	error: Schema.NullOr(Schema.String),
	/** Fleet rejected the token: nothing syncs until a new one is saved. */
	authFailed: Schema.Boolean,
}) {}

export const FleetDeviceRef = Schema.Struct({
	id: Schema.Number,
	name: Schema.String,
	platform: Schema.NullOr(Schema.String),
	url: Schema.String,
})

export class FleetPolicyFinding extends Schema.Class<FleetPolicyFinding>("FleetPolicyFinding")({
	policyId: Schema.Number,
	name: Schema.String,
	description: Schema.NullOr(Schema.String),
	resolution: Schema.NullOr(Schema.String),
	critical: Schema.Boolean,
	platform: Schema.NullOr(Schema.String),
	failingHostCount: Schema.Number,
	passingHostCount: Schema.Number,
	/** Up to 20 of the failing devices. */
	failingHosts: Schema.Array(FleetDeviceRef),
	countedAt: Schema.NullOr(Schema.Number),
	firstSeenAt: Schema.Number,
	url: Schema.String,
}) {}

export const FleetVulnerableSoftwareView = Schema.Struct({
	name: Schema.String,
	version: Schema.String,
	source: Schema.NullOr(Schema.String),
	hostCount: Schema.Number,
	resolvedInVersion: Schema.NullOr(Schema.String),
})

export class FleetVulnerabilityFinding extends Schema.Class<FleetVulnerabilityFinding>(
	"FleetVulnerabilityFinding",
)({
	cve: Schema.String,
	/** Fleet Premium only; null on Fleet Free. */
	cvssScore: Schema.NullOr(Schema.Number),
	epssProbability: Schema.NullOr(Schema.Number),
	knownExploited: Schema.NullOr(Schema.Boolean),
	detailsLink: Schema.NullOr(Schema.String),
	/** Devices with an affected version, summed across versions. */
	hostCount: Schema.Number,
	software: Schema.Array(FleetVulnerableSoftwareView),
	firstSeenAt: Schema.Number,
	url: Schema.String,
}) {}

export class FleetDevicesResponse extends Schema.Class<FleetDevicesResponse>("FleetDevicesResponse")({
	/** Null when no Fleet server is connected. */
	connection: Schema.NullOr(FleetDevicesConnection),
	/** Failing policies, critical first, then by failing devices. */
	policies: Schema.Array(FleetPolicyFinding),
	/** CVEs, highest score first, then by devices; at most 500. */
	vulnerabilities: Schema.Array(FleetVulnerabilityFinding),
	/** CVEs past the 500 listed. */
	moreVulnerabilities: Schema.Number,
}) {}

export class FleetSecurityApiGroup extends HttpApiGroup.make("fleetSecurity")
	.add(
		HttpApiEndpoint.get("devices", "/devices", {
			success: FleetDevicesResponse,
			error: [IntegrationsForbiddenError, IntegrationsPersistenceError],
		}),
	)
	.prefix("/internal/fleet-security")
	.middleware(SessionAuthorization)
	// Device names, policies they fail and the software on them.
	.annotate(AuditedRead, "telemetry.read") {}
