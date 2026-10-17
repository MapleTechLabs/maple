import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { GcpConnectorId, GcpProjectId, GcpResourceNumber } from "@maple/domain/primitives"
import { gcpSetupPlan, type GcpSetupPlanInput } from "./setup-plan"
import { hcl, renderGcpTerraform } from "./terraform"

const connectorId = Schema.decodeUnknownSync(GcpConnectorId)("018f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8")
const host = Schema.decodeUnknownSync(GcpProjectId)("acme-host")

const input: GcpSetupPlanInput = {
	connectorId,
	scopeType: "folder",
	scopeId: Schema.decodeUnknownSync(GcpResourceNumber)("123456789012"),
	projectId: host,
	pushEndpoint: `https://ingest.test/v1/logpush/gcp/${connectorId}`,
	mapleServiceAccountEmail: "collector@maple-prod.iam.gserviceaccount.com",
	logsEnabled: true,
	metricsEnabled: true,
	applicationLogs: ["cloud_run"],
}

const render = (overrides: Partial<GcpSetupPlanInput> = {}) =>
	renderGcpTerraform(gcpSetupPlan({ ...input, ...overrides }))

/** A local's value, read back as HCL reads a string without templates: JSON's escapes. */
const local = (rendered: string, name: string) => {
	const literal = new RegExp(`^ {2}${name} += (".*")$`, "m").exec(rendered)?.[1]
	return literal === undefined ? undefined : (JSON.parse(literal) as unknown)
}

describe("renderGcpTerraform", () => {
	it("sets the connection's values once, as locals HCL reads back unchanged", () => {
		const rendered = render()
		const plan = gcpSetupPlan(input)
		expect(local(rendered, "project_id")).toBe("acme-host")
		expect(local(rendered, "folder_id")).toBe("123456789012")
		expect(local(rendered, "push_endpoint")).toBe(input.pushEndpoint)
		expect(local(rendered, "log_filter")).toBe(plan.logs?.logFilter)
		expect(local(rendered, "maple_service_account")).toBe(input.mapleServiceAccountEmail)
		expect(rendered).not.toMatch(/maple_gcp_|secret=/)
	})

	it("escapes what HCL would read as a template", () => {
		expect(hcl('a"${b}%{c}\\d')).toBe('"a\\"$${b}%%{c}\\\\d"')
	})

	it("places the sink and the read-only grants on the scope", () => {
		const folder = render()
		expect(folder).toContain('resource "google_logging_folder_sink" "maple"')
		expect(folder).toMatch(/^ {2}include_children += true$/m)
		expect(folder).toContain('resource "google_folder_iam_member" "maple_reader"')
		expect(folder).toMatch(/^ {2}folder += "folders\/\$\{local\.folder_id\}"$/m)

		const project = render({ scopeType: "project", scopeId: host })
		expect(project).toContain('resource "google_logging_project_sink" "maple"')
		expect(project).toContain('resource "google_project_iam_member" "maple_reader"')
		expect(project).not.toContain("folder")
	})

	it("leaves out what is off", () => {
		const metricsOnly = render({ logsEnabled: false })
		expect(metricsOnly).not.toMatch(/pubsub|logging_|time_sleep|hashicorp\/time|push_endpoint/)
		expect(metricsOnly).toContain('resource "google_service_account" "maple_reader"')

		const logsOnly = render({ metricsEnabled: false })
		expect(logsOnly).not.toMatch(/maple_reader|maple_service_account/)
	})
})
