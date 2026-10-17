import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { GcpConnectorId, GcpProjectId, GcpResourceNumber } from "@maple/domain/primitives"
import { renderGcpAlchemy } from "./alchemy"
import { gcpSetupPlan, type GcpSetupPlanInput } from "./setup-plan"

const connectorId = Schema.decodeUnknownSync(GcpConnectorId)("018f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8")
const host = Schema.decodeUnknownSync(GcpProjectId)("acme-prod")

const input: GcpSetupPlanInput = {
	connectorId,
	scopeType: "project",
	scopeId: host,
	projectId: host,
	pushEndpoint: `https://ingest.test/v1/logpush/gcp/${connectorId}`,
	mapleServiceAccountEmail: "collector@maple-prod.iam.gserviceaccount.com",
	logsEnabled: true,
	metricsEnabled: true,
	applicationLogs: null,
}

const render = (overrides: Partial<GcpSetupPlanInput> = {}) =>
	renderGcpAlchemy(gcpSetupPlan({ ...input, ...overrides }))

/** A top-level constant's value, read back as TypeScript reads the string literal. */
const constant = (rendered: string | null, name: string) => {
	const literal = new RegExp(`^const ${name} = (".*")$`, "m").exec(rendered ?? "")?.[1]
	return literal === undefined ? undefined : (JSON.parse(literal) as unknown)
}

describe("renderGcpAlchemy", () => {
	it("sets the connection's values once, as constants TypeScript reads back unchanged", () => {
		const rendered = render()
		expect(constant(rendered, "PROJECT_ID")).toBe("acme-prod")
		expect(constant(rendered, "PUSH_ENDPOINT")).toBe(input.pushEndpoint)
		expect(constant(rendered, "LOG_FILTER")).toBe(gcpSetupPlan(input).logs?.logFilter)
		expect(constant(rendered, "MAPLE_SERVICE_ACCOUNT")).toBe(input.mapleServiceAccountEmail)
		// Google names the Pub/Sub service agent by the project's number, which only the customer has.
		expect(constant(rendered, "PROJECT_NUMBER")).toBe("")
		expect(rendered).not.toMatch(/maple_gcp_|secret=/)
	})

	it("is unavailable where read-only access needs a folder or organization grant", () => {
		const number = Schema.decodeUnknownSync(GcpResourceNumber)("123456789012")
		for (const scopeType of ["folder", "organization"] as const) {
			expect(render({ scopeType, scopeId: number })).toBeNull()
			expect(render({ scopeType, scopeId: number, metricsEnabled: false })).toContain(
				scopeType === "folder" ? 'folderId: "123456789012"' : 'organization: "123456789012"',
			)
		}
	})

	it("leaves out what is off", () => {
		const metricsOnly = render({ logsEnabled: false })
		expect(metricsOnly).not.toMatch(/PubSub|Logging|PROJECT_NUMBER/)
		expect(metricsOnly).toContain('accountId: "maple-018f2b3c4d5e4f708192a3b4"')
		expect(render({ metricsEnabled: false })).not.toMatch(/maple-reader|MAPLE_SERVICE_ACCOUNT/)
	})
})
