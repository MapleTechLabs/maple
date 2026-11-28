import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { gcpConnectorResourceNames, gcpSetupPlan, type GcpSetupPlanInput } from "./gcp"
import { GcpConnectorId, GcpProjectId, GcpResourceNumber } from "@maple/primitives"

const connectorId = Schema.decodeSync(GcpConnectorId)("018f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8")

describe("gcpConnectorResourceNames", () => {
	it("derives a service account id inside Google's limits from the connector id alone", () => {
		const names = gcpConnectorResourceNames(connectorId)
		expect(names).toEqual({
			serviceAccountId: "maple-018f2b3c4d5e4f708192a3b4",
			topic: "maple-018f2b3c4d5e4f708192a3b4",
			subscription: "maple-018f2b3c4d5e4f708192a3b4",
			sink: "maple-018f2b3c4d5e4f708192a3b4",
			pushServiceAccountId: "maple-push-018f2b3c4d5e4f70819",
			securityTopic: "maple-018f2b3c4d5e4f708192a3b4-scc",
			securitySubscription: "maple-018f2b3c4d5e4f708192a3b4-scc",
			notificationConfig: "maple-018f2b3c4d5e4f708192a3b4",
		})
		// Security Command Center: 1-128 letters, digits, underscores or hyphens.
		expect(names.notificationConfig).toMatch(/^[\w-]{1,128}$/)
		// Google: 6-30 characters, [a-z]([-a-z0-9]*[a-z0-9]).
		expect(names.serviceAccountId).toMatch(/^[a-z][-a-z0-9]{4,28}[a-z0-9]$/)
		expect(names.pushServiceAccountId).toMatch(/^[a-z][-a-z0-9]{4,28}[a-z0-9]$/)
	})
})

describe("gcpSetupPlan", () => {
	const project = Schema.decodeSync(GcpProjectId)("acme-prod")
	const input: GcpSetupPlanInput = {
		connectorId,
		scopeType: "project",
		scopeId: project,
		projectId: project,
		pushEndpoint: `https://ingest.test/v1/logpush/gcp/${connectorId}`,
		mapleServiceAccountEmail: "collector@maple-prod.iam.gserviceaccount.com",
		logsEnabled: true,
		metricsEnabled: true,
		securityEnabled: false,
		logFilter: 'NOT log_id("cloudaudit.googleapis.com/data_access")',
		securityPushEndpoint: `https://api.test/api/integrations/gcp/security/${connectorId}`,
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

	it("sends findings through their own topic, at the scope's Security Command Center parent", () => {
		const number = Schema.decodeSync(GcpResourceNumber)("123456789012")
		const parents = [
			["project", project, "projects/acme-prod"],
			["folder", number, "folders/123456789012"],
			["organization", number, "organizations/123456789012"],
		] as const
		for (const [scopeType, scopeId, parent] of parents) {
			const security = gcpSetupPlan({ ...input, scopeType, scopeId, securityEnabled: true }).security
			expect(security).toEqual({
				parent,
				notificationConfig: "maple-018f2b3c4d5e4f708192a3b4",
				topic: "maple-018f2b3c4d5e4f708192a3b4-scc",
				subscription: "maple-018f2b3c4d5e4f708192a3b4-scc",
				filter: 'state="ACTIVE" OR state="INACTIVE"',
				pushEndpoint: input.securityPushEndpoint,
				pushServiceAccountId: "maple-push-018f2b3c4d5e4f70819",
				// The same account log pushes sign as: the API checks it the way the gateway does.
				pushServiceAccountEmail: gcpSetupPlan(input).logs?.pushServiceAccountEmail,
			})
		}
		// The topic differs from the log topic: a finding must never reach the log receiver.
		const both = gcpSetupPlan({ ...input, securityEnabled: true })
		expect(both.security?.topic).not.toBe(both.logs?.topic)
	})

	it("gives the reader the findings role with security, and the metrics roles only with metrics", () => {
		const roles = (metricsEnabled: boolean, securityEnabled: boolean) =>
			gcpSetupPlan({ ...input, metricsEnabled, securityEnabled }).reader?.scopeRoles ?? null
		expect(roles(true, false)).toEqual(["roles/monitoring.viewer", "roles/cloudasset.viewer"])
		expect(roles(false, true)).toEqual(["roles/securitycenter.findingsViewer"])
		expect(roles(true, true)).toEqual([
			"roles/monitoring.viewer",
			"roles/cloudasset.viewer",
			"roles/securitycenter.findingsViewer",
		])
		expect(roles(false, false)).toBeNull()
	})

	it("switches on Security Command Center's APIs for findings, and the metrics APIs only for metrics", () => {
		const findingsOnly = gcpSetupPlan({
			...input,
			logsEnabled: false,
			metricsEnabled: false,
			securityEnabled: true,
		})
		expect(findingsOnly.apis).toEqual([
			"cloudresourcemanager.googleapis.com",
			"iam.googleapis.com",
			"iamcredentials.googleapis.com",
			"pubsub.googleapis.com",
			"securitycenter.googleapis.com",
		])
		expect(findingsOnly.logs).toBeNull()
		expect(gcpSetupPlan(input).apis).not.toContain("securitycenter.googleapis.com")
	})

	it("leaves findings out on a deployment without a Google identity: the reader reads them", () => {
		const plan = gcpSetupPlan({ ...input, securityEnabled: true, mapleServiceAccountEmail: undefined })
		expect(plan.security).toBeNull()
		expect(plan.apis).not.toContain("securitycenter.googleapis.com")
	})
})
