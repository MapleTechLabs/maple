import { describe, expect, it } from "vitest"
import { Effect, Schema } from "effect"
import { GcpConnectorId, GcpProjectId, GcpResourceNumber } from "@maple/domain/primitives"
import { gcpSetupPlan, type GcpSetupPlanInput } from "./setup-plan"
import { renderGcpSetupScript } from "./setup-scripts"

const connectorId = Schema.decodeUnknownSync(GcpConnectorId)("018f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8")
const PUSH_ENDPOINT = `https://ingest.test/v1/logpush/gcp/${connectorId}`
const MAPLE_ACCOUNT = "collector@maple-prod.iam.gserviceaccount.com"

const input: GcpSetupPlanInput = {
	connectorId,
	scopeType: "organization",
	scopeId: Schema.decodeUnknownSync(GcpResourceNumber)("123456789012"),
	projectId: Schema.decodeUnknownSync(GcpProjectId)("acme-host"),
	pushEndpoint: PUSH_ENDPOINT,
	mapleServiceAccountEmail: MAPLE_ACCOUNT,
	logsEnabled: true,
	metricsEnabled: true,
	applicationLogs: null,
}

const scriptFilter = (applicationLogs: GcpSetupPlanInput["applicationLogs"]) =>
	Effect.runSync(
		renderGcpSetupScript({
			...input,
			mapleUrl: "https://app.maple.test",
			pushEndpoint: `${PUSH_ENDPOINT}?secret=maple_gcp_x`,
			applicationLogs,
		}),
	).match(/^LOG_FILTER='(.*)'$/m)?.[1]

describe("gcpSetupPlan", () => {
	it("signs pushes as the account the ingest gateway accepts for the connector", () => {
		const logs = gcpSetupPlan(input).logs
		// The gateway's rule: the connector id's first 19 hex digits, in the host project.
		const hex = connectorId.replaceAll("-", "").slice(0, 19)
		expect(logs?.pushServiceAccountEmail).toBe(`maple-push-${hex}@acme-host.iam.gserviceaccount.com`)
		expect(logs?.pushEndpoint).toBe(PUSH_ENDPOINT)
		expect(logs?.includeChildren).toBe(true)
		expect(logs?.sinkDestination).toBe(`pubsub.googleapis.com/projects/acme-host/topics/${logs?.topic}`)
	})

	it("sets the log filter the setup script would set for the same request", () => {
		for (const applicationLogs of [null, [], ["cloud_run", "gke"] as const]) {
			expect(gcpSetupPlan({ ...input, applicationLogs }).logs?.logFilter).toBe(
				scriptFilter(applicationLogs),
			)
		}
	})

	it("leaves out what is off, and the reader on a deployment without a Google identity", () => {
		expect(gcpSetupPlan({ ...input, logsEnabled: false }).logs).toBeNull()
		expect(gcpSetupPlan({ ...input, metricsEnabled: false }).reader).toBeNull()
		expect(gcpSetupPlan({ ...input, mapleServiceAccountEmail: undefined }).reader).toBeNull()
		expect(gcpSetupPlan({ ...input, metricsEnabled: false }).apis).toEqual([
			"cloudresourcemanager.googleapis.com",
			"iam.googleapis.com",
			"logging.googleapis.com",
			"pubsub.googleapis.com",
		])
		expect(gcpSetupPlan({ ...input, logsEnabled: false }).apis).not.toContain("pubsub.googleapis.com")
	})
})
