import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { gcpConnectorResourceNames, gcpSetupPlan, type GcpSetupPlanInput } from "./gcp"
import { GcpConnectorId, GcpProjectId } from "./primitives"

const connectorId = Schema.decodeUnknownSync(GcpConnectorId)("018f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8")

describe("gcpConnectorResourceNames", () => {
	it("derives a service account id inside Google's limits from the connector id alone", () => {
		const names = gcpConnectorResourceNames(connectorId)
		expect(names).toEqual({
			serviceAccountId: "maple-018f2b3c4d5e4f708192a3b4",
			topic: "maple-018f2b3c4d5e4f708192a3b4",
			subscription: "maple-018f2b3c4d5e4f708192a3b4",
			sink: "maple-018f2b3c4d5e4f708192a3b4",
			pushServiceAccountId: "maple-push-018f2b3c4d5e4f70819",
		})
		// Google: 6-30 characters, [a-z]([-a-z0-9]*[a-z0-9]).
		expect(names.serviceAccountId).toMatch(/^[a-z][-a-z0-9]{4,28}[a-z0-9]$/)
		expect(names.pushServiceAccountId).toMatch(/^[a-z][-a-z0-9]{4,28}[a-z0-9]$/)
	})
})

describe("gcpSetupPlan", () => {
	const project = Schema.decodeUnknownSync(GcpProjectId)("acme-prod")
	const input: GcpSetupPlanInput = {
		connectorId,
		scopeType: "project",
		scopeId: project,
		projectId: project,
		pushEndpoint: `https://ingest.test/v1/logpush/gcp/${connectorId}`,
		mapleServiceAccountEmail: "collector@maple-prod.iam.gserviceaccount.com",
		logsEnabled: true,
		metricsEnabled: true,
		logFilter: 'NOT log_id("cloudaudit.googleapis.com/data_access")',
	}

	it("signs pushes as the account the ingest gateway accepts: 19 hex digits, in the host project", () => {
		expect(gcpSetupPlan(input).logs?.pushServiceAccountEmail).toBe(
			"maple-push-018f2b3c4d5e4f70819@acme-prod.iam.gserviceaccount.com",
		)
	})

	it("leaves out what is off, and the reader on a deployment without a Google identity", () => {
		expect(gcpSetupPlan({ ...input, logsEnabled: false }).apis).not.toContain("pubsub.googleapis.com")
		expect(gcpSetupPlan({ ...input, metricsEnabled: false }).reader).toBeNull()
		expect(gcpSetupPlan({ ...input, mapleServiceAccountEmail: undefined }).reader).toBeNull()
		// The push service account needs the IAM API even without the reader.
		expect(gcpSetupPlan({ ...input, metricsEnabled: false }).apis).toContain("iam.googleapis.com")
	})
})
