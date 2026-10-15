import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { GcpConnectorId, GcpProjectId, GcpResourceNumber } from "@maple/domain/primitives"
import { gcpLogFilter } from "./setup-scripts"
import { renderGcpTerraform, type GcpTerraformInput } from "./terraform"

const connectorId = Schema.decodeUnknownSync(GcpConnectorId)("018f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8")
const PUSH_ENDPOINT = `https://ingest.test/v1/logpush/gcp/${connectorId}`

const input: GcpTerraformInput = {
	connectorId,
	scopeType: "organization",
	scopeId: Schema.decodeUnknownSync(GcpResourceNumber)("123456789012"),
	projectId: Schema.decodeUnknownSync(GcpProjectId)("acme-host"),
	pushEndpoint: PUSH_ENDPOINT,
	mapleServiceAccountEmail: "collector@maple-prod.iam.gserviceaccount.com",
	logsEnabled: true,
	applicationLogs: null,
}

/** The value an attribute is set to, read back as HCL would. */
const attribute = (rendered: string, name: string) => {
	const literal = new RegExp(`^ {2}${name} += (.+)$`, "m").exec(rendered)?.[1]
	return literal === undefined ? undefined : (JSON.parse(literal) as unknown)
}

describe("renderGcpTerraform", () => {
	it("sets every module input from the connection", () => {
		const rendered = renderGcpTerraform(input)
		expect(rendered).toContain('module "maple_gcp_123456789012" {\n')
		expect(attribute(rendered, "connector_id")).toBe(connectorId)
		expect(attribute(rendered, "scope_type")).toBe("organization")
		expect(attribute(rendered, "scope_id")).toBe("123456789012")
		expect(attribute(rendered, "project_id")).toBe("acme-host")
		expect(attribute(rendered, "push_endpoint")).toBe(PUSH_ENDPOINT)
		expect(attribute(rendered, "maple_service_account")).toBe("collector@maple-prod.iam.gserviceaccount.com")
		expect(attribute(rendered, "logs_enabled")).toBe(true)
	})

	it("writes the log filter as a literal HCL reads back unchanged", () => {
		const rendered = renderGcpTerraform({ ...input, applicationLogs: [] })
		// Quotes are escaped, so JSON reads the literal back. No `${` in Maple's filter needs it yet.
		expect(attribute(rendered, "log_filter")).toBe(gcpLogFilter([]))
	})

	it("escapes what HCL would read as a template", () => {
		const rendered = renderGcpTerraform({
			...input,
			mapleServiceAccountEmail: 'a"${b}%{c}\\d',
		})
		expect(rendered).toContain('maple_service_account = "a\\"$${b}%%{c}\\\\d"\n')
	})

	it("leaves read-only access out without Maple's account, and says nothing secret", () => {
		const rendered = renderGcpTerraform({ ...input, mapleServiceAccountEmail: undefined, logsEnabled: false })
		expect(rendered).not.toContain("maple_service_account")
		expect(attribute(rendered, "logs_enabled")).toBe(false)
		expect(rendered).not.toContain("secret=")
	})
})
