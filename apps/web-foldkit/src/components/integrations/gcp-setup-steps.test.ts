import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { gcpSetupPlan } from "@maple/domain/gcp"
import { V2GcpConnector } from "@maple/domain/http/v2"

import { GCP_SETUP_FIXTURES } from "../../lab/gcp-setup-fixtures"

import { gcpAgentPrompt, gcpManualSteps, gcpRemovalList } from "./gcp-setup-steps"

const connector = (over: Record<string, unknown> = {}) =>
	Schema.decodeUnknownSync(V2GcpConnector)({
		id: "gcpc_YofPTrK9782DWwcnXhpcCw",
		object: "gcp_connector",
		scope_type: "project",
		scope_id: "acme-prod",
		project_id: "acme-prod",
		logs_enabled: true,
		metrics_enabled: true,
		created_at: "2026-10-17T12:00:00.000Z",
		last_log_received_at: null,
		last_log_error: null,
		applied_logs_enabled: null,
		applied_metrics_enabled: null,
		setup_reported_at: null,
		last_metrics_received_at: null,
		last_metrics_error: null,
		discovered_project_count: 0,
		last_resources_error: null,
		...over,
	})

const ORGANIZATION = {
	scope_type: "organization",
	scope_id: "123456789012",
	project_id: "acme-observability",
}

/** What the dialog renders from: the connector and the setup_scripts response. */
const plan = (of: V2GcpConnector) =>
	gcpSetupPlan({
		connectorId: of.id,
		scopeType: of.scope_type,
		scopeId: of.scope_id,
		projectId: of.project_id,
		pushEndpoint: GCP_SETUP_FIXTURES.project.push_endpoint,
		mapleServiceAccountEmail: GCP_SETUP_FIXTURES.project.maple_service_account_email,
		logsEnabled: of.logs_enabled,
		metricsEnabled: of.metrics_enabled,
		logFilter: GCP_SETUP_FIXTURES.project.log_filter,
	})

const titles = (of: V2GcpConnector) => gcpManualSteps(plan(of)).map((step) => step.title)
const values = (of: V2GcpConnector, title: string) =>
	gcpManualSteps(plan(of))
		.find((step) => step.title === title)
		?.fields.map((field) => field.value)

describe("gcpManualSteps", () => {
	it("lists what the connection collects, Maple's grant before the read-only roles", () => {
		expect(titles(connector())).toEqual([
			"Enable the APIs",
			"Create the Pub/Sub topic",
			"Create the push service account",
			"Create the push subscription",
			"Create the Log Router sink",
			"Let the sink publish to the topic",
			"Send a test message",
			"Create the read-only service account",
			"Let Maple use the read-only account",
			"Grant the read-only roles",
		])
		expect(titles(connector({ metrics_enabled: false }))).not.toContain("Grant the read-only roles")
		expect(titles(connector({ logs_enabled: false }))).not.toContain("Create the Pub/Sub topic")
	})

	it("hands over the exact endpoint, filter and push account, and no Logs Writer grant", () => {
		const fixture = GCP_SETUP_FIXTURES.project
		expect(values(connector(), "Create the push subscription")).toEqual(
			expect.arrayContaining([
				fixture.push_endpoint,
				"maple-push-018f2b3c4d5e6f70819@acme-prod.iam.gserviceaccount.com",
			]),
		)
		expect(values(connector(), "Create the Log Router sink")).toContain(fixture.log_filter)
		expect(values(connector(), "Let the sink publish to the topic")).toEqual(["Pub/Sub Publisher"])
		// A published setup report confirms log forwarding through the signed push.
		expect(JSON.parse(String(values(connector(), "Send a test message")?.[0]))).toEqual({
			logName: "projects/acme-prod/logs/maple-setup",
			jsonPayload: { logs: true },
		})
	})

	it("routes an organization's sink to the topic by its full path", () => {
		const org = connector(ORGANIZATION)
		const sink = gcpManualSteps(plan(org)).find((step) =>
			step.title.startsWith("Create the Log Router sink"),
		)
		expect(sink?.title).toBe("Create the Log Router sink on the organization")
		expect(sink?.fields.map((field) => field.value)).toEqual(
			expect.arrayContaining([
				"Other resource",
				"pubsub.googleapis.com/projects/acme-observability/topics/maple-018f2b3c4d5e6f708192a3b4",
			]),
		)
		expect(sink?.consoleUrl).toContain("organizationId=123456789012")
	})

	it("grants the quota role on the host project, the read roles on the scope", () => {
		const steps = gcpManualSteps(plan(connector(ORGANIZATION)))
		const scope = steps.find((step) => step.title === "Grant the read-only roles on the organization")
		const host = steps.find((step) => step.title === "Grant Service Usage Consumer on acme-observability")
		expect(scope?.consoleUrl).toContain("organizationId=123456789012")
		expect(scope?.fields.map((field) => field.value)).not.toContain("Service Usage Consumer")
		expect(host?.consoleUrl).toContain("project=acme-observability")
		expect(host?.fields.map((field) => field.value)).toContain("Service Usage Consumer")
	})

	it("opens a folder's console pages on the folder", () => {
		const steps = gcpManualSteps(plan(connector({ ...ORGANIZATION, scope_type: "folder" })))
		expect(steps.find((step) => step.title === "Create the Log Router sink on the folder")?.consoleUrl).toContain(
			"folder=123456789012",
		)
	})
})

describe("gcpRemovalList", () => {
	it("deletes the sink first and only what was set up and is now off", () => {
		const off = connector({
			...ORGANIZATION,
			logs_enabled: false,
			applied_logs_enabled: true,
			applied_metrics_enabled: true,
		})
		expect(gcpRemovalList(off).map((item) => item.name)).toEqual([
			"maple-018f2b3c4d5e6f708192a3b4",
			"maple-018f2b3c4d5e6f708192a3b4",
			"maple-018f2b3c4d5e6f708192a3b4",
			"maple-push-018f2b3c4d5e6f70819@acme-observability.iam.gserviceaccount.com",
		])
		expect(gcpRemovalList(off)[0]?.what).toContain("then wait two minutes")
		expect(gcpRemovalList(connector({ logs_enabled: false, applied_logs_enabled: false }))).toEqual([])
		// Set up by hand or as code but never confirmed: listed, with nothing to confirm.
		const unconfirmed = gcpRemovalList(connector({ logs_enabled: false, applied_logs_enabled: null }))
		expect(unconfirmed.map((item) => item.name)).toHaveLength(4)
		expect(unconfirmed.some((item) => item.confirmed)).toBe(false)
		const reader = gcpRemovalList(connector({ metrics_enabled: false, applied_metrics_enabled: true }))
		expect(reader.map((item) => item.name)).toEqual([
			"maple-018f2b3c4d5e6f708192a3b4@acme-prod.iam.gserviceaccount.com",
			"maple-018f2b3c4d5e6f708192a3b4@acme-prod.iam.gserviceaccount.com",
		])
		expect(reader[0]?.consoleUrl).toContain("iam-admin/iam?project=acme-prod")
	})

	it("lists everything not known to be gone for a disconnect", () => {
		const loggingOnly = connector({ logs_enabled: true, applied_logs_enabled: true, applied_metrics_enabled: false })
		expect(gcpRemovalList(loggingOnly)).toEqual([])
		expect(gcpRemovalList(loggingOnly, "all").map((item) => item.name)).toHaveLength(4)
		expect(gcpRemovalList(connector({ applied_logs_enabled: false, applied_metrics_enabled: false }), "all")).toEqual(
			[],
		)
	})
})

describe("gcpAgentPrompt", () => {
	it("asks for a plan before applying, verification with gcloud, and the file in full", () => {
		const config = GCP_SETUP_FIXTURES.project.terraform
		const prompt = gcpAgentPrompt({
			flavour: "terraform",
			config,
			plan: plan(connector()),
			connector: connector(),
		})
		expect(prompt).toContain("Run terraform plan and show me the plan. Apply only after I approve it.")
		expect(prompt).toContain(
			"gcloud pubsub subscriptions describe maple-018f2b3c4d5e6f708192a3b4 --project=acme-prod",
		)
		expect(prompt).toContain("Maple's first metrics read confirms read-only access")
		expect(prompt.endsWith(`--- maple.tf ---\n${config.trimEnd()}\n`)).toBe(true)
	})

	it("says what it takes over and what applying a regenerated file removes", () => {
		const removing = connector({
			...ORGANIZATION,
			logs_enabled: false,
			applied_logs_enabled: true,
			applied_metrics_enabled: true,
		})
		const prompt = gcpAgentPrompt({
			flavour: "alchemy",
			config: "// stack",
			plan: plan(removing),
			connector: removing,
		})
		expect(prompt).toContain("deploys with --adopt to take them over")
		expect(prompt).toContain("Applying it removes what an earlier version of this file created")
		// What a script or the console made, no file removes: the prompt names it to delete by hand.
		expect(prompt).toContain("I delete by hand: Log Router sink on the organization")
		expect(prompt).toContain("keep that one and ask me")
		expect(prompt).toContain("to click I've removed them")
		expect(prompt).not.toContain("PROJECT_NUMBER")
	})
})
