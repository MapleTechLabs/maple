import { describe, expect, it } from "vitest"
import { Array as Arr, Schema, String as Str } from "effect"
import { gcpSetupPlan, type GcpSetupPlanInput } from "@maple/domain/gcp"
import { GcpConnectorId, GcpProjectId, GcpResourceNumber } from "@maple/primitives"
import { renderGcpAlchemy } from "./alchemy"
import { gcpLogFilter } from "./setup-scripts"
import { hcl, renderGcpTerraform } from "./terraform"

const connectorId = Schema.decodeSync(GcpConnectorId)("018f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8")
const host = Schema.decodeSync(GcpProjectId)("acme-host")
const folder = Schema.decodeSync(GcpResourceNumber)("123456789012")
const NEW = { logs: false, reader: false }

const input: GcpSetupPlanInput = {
	connectorId,
	scopeType: "folder",
	scopeId: folder,
	projectId: host,
	pushEndpoint: `https://ingest.test/v1/logpush/gcp/${connectorId}`,
	mapleServiceAccountEmail: "collector@maple-prod.iam.gserviceaccount.com",
	logsEnabled: true,
	metricsEnabled: true,
	securityEnabled: false,
	logFilter: gcpLogFilter(["cloud_run"]),
	securityPushEndpoint: `https://api.test/api/integrations/gcp/security/${connectorId}`,
}
const org = Schema.decodeSync(GcpResourceNumber)("987654321098")

/** Every `resource "type" "name"` the file declares. */
const resources = (rendered: string) =>
	Arr.map(
		Array.from(Str.matchAll(/^resource "([^"]+)" "([^"]+)"/gm)(rendered)),
		(match) => `${match[1]}.${match[2]}`,
	)

const plan = (overrides: Partial<GcpSetupPlanInput> = {}) => gcpSetupPlan({ ...input, ...overrides })

/** A value as HCL or TypeScript reads a string literal without templates: JSON's escapes. */
const literal = (rendered: string | null, pattern: string) => {
	const value = new RegExp(pattern, "m").exec(rendered ?? "")?.[1]
	return value === undefined ? undefined : (JSON.parse(value) as unknown)
}

describe("renderGcpTerraform", () => {
	it("sets the connection's values once, as locals HCL reads back unchanged", () => {
		const rendered = renderGcpTerraform(plan(), NEW)
		const local = (name: string) => literal(rendered, `^ {2}${name} += (".*")$`)
		expect(local("project_id")).toBe("acme-host")
		expect(local("folder_id")).toBe("123456789012")
		expect(local("push_endpoint")).toBe(input.pushEndpoint)
		expect(local("log_filter")).toBe(input.logFilter)
		expect(local("maple_service_account")).toBe(input.mapleServiceAccountEmail)
		expect(rendered).not.toMatch(/maple_gcp_|secret=/)
	})

	it("escapes what HCL would read as a template", () => {
		expect(hcl('a"${b}%{c}\\d')).toBe('"a\\"$${b}%%{c}\\\\d"')
	})

	it("places the sink and the read-only grants on the scope, and leaves the shared Logs Writer grant alone", () => {
		const rendered = renderGcpTerraform(plan(), NEW)
		expect(rendered).toContain('resource "google_logging_folder_sink" "maple"')
		// Every sink on the scope writes as the same identity: a destroy must not revoke its grant.
		expect(rendered).not.toMatch(/role += "roles\/logging\.logWriter"/)
		expect(renderGcpTerraform(plan({ scopeType: "project", scopeId: host }), NEW)).toContain(
			'resource "google_logging_project_sink" "maple"',
		)
	})

	it("imports what a setup script created instead of creating it again", () => {
		const rendered = renderGcpTerraform(plan(), { logs: true, reader: true })
		expect(rendered).toMatch(
			/to = google_logging_folder_sink\.maple\s+id = "folders\/123456789012\/sinks\/maple-018f2b3c4d5e4f708192a3b4"/,
		)
		expect(rendered).toMatch(
			/to = google_service_account\.maple_reader\s+id = "projects\/acme-host\/serviceAccounts\/maple-018f2b3c4d5e4f708192a3b4@acme-host\.iam\.gserviceaccount\.com"/,
		)
		// Only commented: a resource only some earlier setups created is taken over by uncommenting.
		expect(renderGcpTerraform(plan(), NEW)).not.toMatch(/^import \{/m)
	})

	it("leaves out what is off", () => {
		expect(renderGcpTerraform(plan({ logsEnabled: false }), NEW)).not.toMatch(
			/pubsub|logging_|time_sleep|push_endpoint/,
		)
		expect(renderGcpTerraform(plan({ metricsEnabled: false }), NEW)).not.toMatch(
			/maple_reader|maple_service_account/,
		)
	})
})

describe("renderGcpTerraform with security findings", () => {
	const secure = (overrides: Partial<GcpSetupPlanInput> = {}) =>
		plan({ securityEnabled: true, ...overrides })
	const scopes = [
		["project", host, "project      = local.project_id", "projects/acme-host"],
		["folder", folder, "folder       = local.folder_id", "folders/123456789012"],
		["organization", org, "organization = local.organization_id", "organizations/987654321098"],
	] as const

	it.each(scopes)(
		"sends a %s's findings through a notification config on that scope",
		(scopeType, scopeId, scopeLine, parent) => {
			const rendered = renderGcpTerraform(secure({ scopeType, scopeId }), NEW)
			expect(rendered).toContain(`resource "google_scc_v2_${scopeType}_notification_config" "maple" {`)
			expect(rendered).toContain(`  ${scopeLine}\n`)
			expect(rendered).toMatch(/location +=  ?"global"/)
			expect(rendered).toContain("pubsub_topic = google_pubsub_topic.maple_security.id")
			expect(rendered).toContain(
				`#   id = "${parent}/locations/global/notificationConfigs/maple-018f2b3c4d5e4f708192a3b4"`,
			)
			// The findings role on the scope, for the same reader the metrics roles go to.
			expect(rendered).toContain('"roles/securitycenter.findingsViewer",')
		},
	)

	it("signs the findings pushes for the API's address, with no secret", () => {
		const rendered = renderGcpTerraform(secure(), NEW)
		const local = (name: string) => literal(rendered, `^ {2}${name} += (".*")$`)
		expect(local("security_push_endpoint")).toBe(input.securityPushEndpoint)
		expect(local("security_filter")).toBe('state="ACTIVE" OR state="INACTIVE"')
		expect(rendered).toMatch(
			/resource "google_pubsub_subscription" "maple_security" \{[\s\S]*?push_endpoint = local\.security_push_endpoint[\s\S]*?no_wrapper \{\s*write_metadata = false[\s\S]*?service_account_email = google_service_account\.maple_push\.email\s*audience += local\.security_push_endpoint/,
		)
		expect(rendered).toContain("#   Security findings:     on")
		// The notification configs need a provider that has all three.
		expect(rendered).toContain('version = ">= 5.42, < 8.0"')
		expect(rendered).not.toMatch(/maple_gcp_|secret=/)
	})

	it("shares one push identity between logs and findings", () => {
		const both = resources(renderGcpTerraform(secure(), NEW))
		expect(Arr.filter(both, (name) => name === "google_service_account.maple_push")).toHaveLength(1)
		expect(both).toEqual(
			expect.arrayContaining([
				"google_pubsub_topic.maple",
				"google_pubsub_topic.maple_security",
				"google_pubsub_subscription.maple_security",
			]),
		)
		const findingsOnly = renderGcpTerraform(secure({ logsEnabled: false, metricsEnabled: false }), NEW)
		expect(resources(findingsOnly)).toEqual([
			"google_project_service.maple",
			"google_service_account.maple_push",
			"google_service_account_iam_member.maple_push_token_creator",
			"google_pubsub_topic.maple_security",
			"google_pubsub_subscription.maple_security",
			"google_scc_v2_folder_notification_config.maple",
			"google_service_account.maple_reader",
			"google_service_account_iam_member.maple_reader_token_creator",
			"google_folder_iam_member.maple_reader",
			"google_project_iam_member.maple_reader_quota",
		])
		// Without metrics the reader holds the findings role alone, and no log pipeline is declared.
		expect(findingsOnly).not.toContain("roles/monitoring.viewer")
		expect(findingsOnly).not.toMatch(/time_sleep|logging_|local\.push_endpoint/)
		expect(findingsOnly).toContain("#   Metrics and resources: off")
	})

	it("leaves findings out when they are off", () => {
		const rendered = renderGcpTerraform(plan(), NEW)
		expect(rendered).not.toMatch(/scc_v2|maple_security|findingsViewer/)
		expect(rendered).toContain('version = ">= 5.0, < 8.0"')
		// Neither logs nor findings: nothing pushes, so there is no push identity.
		expect(renderGcpTerraform(plan({ logsEnabled: false }), NEW)).not.toContain("maple_push")
	})
})

describe("renderGcpAlchemy", () => {
	const project = (overrides: Partial<GcpSetupPlanInput> = {}) =>
		plan({ scopeType: "project", scopeId: host, ...overrides })

	it("sets the connection's values once, as constants TypeScript reads back unchanged", () => {
		const rendered = renderGcpAlchemy(project(), NEW)
		const constant = (name: string) => literal(rendered, `^const ${name} = (".*")$`)
		expect(constant("PUSH_ENDPOINT")).toBe(input.pushEndpoint)
		expect(constant("LOG_FILTER")).toBe(input.logFilter)
		expect(constant("MAPLE_SERVICE_ACCOUNT")).toBe(input.mapleServiceAccountEmail)
		// Google names the Pub/Sub service agent by the project's number, which only the customer has.
		expect(constant("PROJECT_NUMBER")).toBe("")
		expect(rendered).not.toMatch(/maple_gcp_|secret=|logging\.logWriter",/)
	})

	// alchemy's IAM members stop at projects: the file brings its own grant for a folder's policy.
	it("grants the read roles on a folder through its own resource, the quota role on the host", () => {
		const folder = renderGcpAlchemy(plan(), NEW)
		expect(literal(folder, '^const SCOPE = (".*")$')).toBe("folders/123456789012")
		expect(folder).toContain("yield* ScopeIamMember(")
		expect(folder).toMatch(/"maple-reader-serviceusage\.serviceUsageConsumer", \{\s*kind: "project"/)
		expect(renderGcpAlchemy(plan({ metricsEnabled: false }), NEW)).toContain('folderId: "123456789012"')
		expect(renderGcpAlchemy(project(), NEW)).not.toContain("ScopeIamMember")
	})

	// Alchemy keys its state by stack name: two connections under one name would replace each other.
	it("names the stack after the connection", () => {
		expect(renderGcpAlchemy(project(), NEW)).toMatch(
			/Alchemy\.Stack\(\s*"maple-018f2b3c4d5e4f708192a3b4"/,
		)
	})

	it.each([
		["project", host, "projects/acme-host"],
		["folder", folder, "folders/123456789012"],
		["organization", org, "organizations/987654321098"],
	] as const)(
		"sends a %s's findings through a v2 notification config on that scope",
		(scopeType, scopeId, parent) => {
			const rendered = renderGcpAlchemy(plan({ scopeType, scopeId, securityEnabled: true }), NEW)
			const constant = (name: string) => literal(rendered, `^const ${name} = (".*")$`)
			expect(constant("SCOPE")).toBe(parent)
			expect(constant("SECURITY_PUSH_ENDPOINT")).toBe(input.securityPushEndpoint)
			expect(constant("SECURITY_FILTER")).toBe('state="ACTIVE" OR state="INACTIVE"')
			expect(rendered).toMatch(
				/yield\* SccNotification\("maple-security-notification", \{\s*parent: SCOPE,\s*configId: "maple-018f2b3c4d5e4f708192a3b4",\s*pubsubTopic: securityTopic\.name,/,
			)
			// The v2 API: alchemy's own SecurityCenter resources call v1, whose findings name no location.
			expect(rendered).toContain('"https://securitycenter.googleapis.com/v2"')
			expect(rendered).toContain("/locations/global/notificationConfigs")
			expect(rendered).toContain("SccNotificationProvider.pipe(")
			expect(rendered).toContain('"roles/securitycenter.findingsViewer"')
		},
	)

	it("signs the findings pushes as the one push identity, for the API's address", () => {
		const both = renderGcpAlchemy(project({ securityEnabled: true }), NEW)
		expect(
			Arr.filter(Str.split("\n")(both), (line) =>
				Str.includes('GCP.IAM.ServiceAccount("maple-push"')(line),
			),
		).toHaveLength(1)
		expect(both).toMatch(
			/const securityPushConfig = \{\s*pushEndpoint: SECURITY_PUSH_ENDPOINT,\s*noWrapper: \{ writeMetadata: false \},\s*oidcToken: \{ serviceAccountEmail: pushAccount\.email, audience: SECURITY_PUSH_ENDPOINT \},/,
		)
		const findingsOnly = renderGcpAlchemy(
			project({ securityEnabled: true, logsEnabled: false, metricsEnabled: false }),
			NEW,
		)
		expect(literal(findingsOnly, '^const PROJECT_NUMBER = (".*")$')).toBe("")
		expect(findingsOnly).not.toMatch(/LOG_FILTER|GCP\.Logging|maple-topic/)
		expect(findingsOnly).not.toContain("roles/monitoring.viewer")
		expect(findingsOnly).toContain("//   Security findings:     on")
		expect(findingsOnly).not.toMatch(/maple_gcp_|secret=/)
	})

	it("leaves findings out when they are off", () => {
		expect(renderGcpAlchemy(project(), NEW)).not.toMatch(/SccNotification|SECURITY_|securitycenter/)
	})

	it("adopts what a setup script created", () => {
		expect(renderGcpAlchemy(project(), { logs: true, reader: false })).toContain("--stage maple --adopt")
		expect(renderGcpAlchemy(project(), NEW)).not.toContain("--stage maple --adopt")
	})
})
