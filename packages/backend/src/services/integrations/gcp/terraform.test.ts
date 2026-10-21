import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { gcpSetupPlan, type GcpSetupPlanInput } from "@maple/domain/gcp"
import { GcpConnectorId, GcpProjectId, GcpResourceNumber } from "@maple/domain/primitives"
import { renderGcpAlchemy } from "./alchemy"
import { gcpLogFilter } from "./setup-scripts"
import { hcl, renderGcpTerraform } from "./terraform"

const connectorId = Schema.decodeUnknownSync(GcpConnectorId)("018f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8")
const host = Schema.decodeUnknownSync(GcpProjectId)("acme-host")
const folder = Schema.decodeUnknownSync(GcpResourceNumber)("123456789012")
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
	logFilter: gcpLogFilter(["cloud_run"]),
}

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

	it("adopts what a setup script created", () => {
		expect(renderGcpAlchemy(project(), { logs: true, reader: false })).toContain("--stage maple --adopt")
		expect(renderGcpAlchemy(project(), NEW)).not.toContain("--stage maple --adopt")
	})
})
