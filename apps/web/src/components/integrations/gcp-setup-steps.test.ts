import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { V2GcpConnector, V2GcpManualSetup } from "@maple/domain/http/v2"

import { GCP_SETUP_FIXTURES } from "@/lab/gcp-setup-fixtures"

import {
	gcpAgentPrompt,
	gcpAlchemyUnavailable,
	gcpManualSteps,
	gcpPendingSetupSteps,
	gcpRemovalSteps,
	gcpSetupChecks,
} from "./gcp-setup-steps"

const manual = (fixture: keyof typeof GCP_SETUP_FIXTURES) =>
	Schema.decodeUnknownSync(V2GcpManualSetup)(GCP_SETUP_FIXTURES[fixture].manual)

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

const values = (steps: ReturnType<typeof gcpManualSteps>, id: string) =>
	steps.find((step) => step.id === id)?.fields.map((field) => field.value)

describe("gcpManualSteps", () => {
	it("lists what the connection collects, in the order Google needs it", () => {
		expect(gcpManualSteps(manual("project")).map((step) => step.id)).toEqual([
			"apis",
			"topic",
			"push_account",
			"subscription",
			"sink",
			"sink_grants",
			"test_message",
			"reader_account",
			"reader_roles",
			"reader_token_creator",
		])
		expect(gcpManualSteps(manual("organization")).map((step) => step.id)).not.toContain("reader_account")
		expect(gcpManualSteps(manual("organizationMetrics")).map((step) => step.id)).toEqual([
			"apis",
			"reader_account",
			"reader_roles",
			"reader_token_creator",
		])
	})

	it("hands over the exact names, endpoint and filter the backend generated", () => {
		const setup = manual("project")
		const steps = gcpManualSteps(setup)
		expect(values(steps, "subscription")).toEqual(
			expect.arrayContaining([
				setup.logs?.subscription,
				setup.logs?.push_endpoint,
				setup.logs?.push_service_account_email,
			]),
		)
		expect(values(steps, "sink")).toContain(setup.logs?.log_filter)
		// A published setup report confirms log forwarding through the signed push.
		expect(JSON.parse(String(values(steps, "test_message")?.[0]))).toEqual({
			logName: "projects/acme-prod/logs/maple-setup",
			jsonPayload: { logs: true },
		})
	})

	it("routes a folder or organization sink to the topic by its full path, children included", () => {
		const setup = manual("organization")
		const sink = gcpManualSteps(setup).find((step) => step.id === "sink")
		expect(sink?.fields.map((field) => field.value)).toEqual(
			expect.arrayContaining(["Other resource", setup.logs?.sink_destination]),
		)
		expect(sink?.consoleUrl).toContain("organizationId=123456789012")
		const roles = gcpManualSteps(manual("organizationMetrics")).find((step) => step.id === "reader_roles")
		expect(roles?.fields.map((field) => field.label)).toEqual([
			"Principal",
			"Roles on the organization",
			"Roles on project acme-observability",
		])
	})
})

describe("gcpPendingSetupSteps", () => {
	it("leaves out what Google Cloud already has, and the APIs alone", () => {
		const setup = manual("project")
		expect(
			gcpPendingSetupSteps(setup, connector({ applied_logs_enabled: true })).map((step) => step.id),
		).toEqual(["apis", "reader_account", "reader_roles", "reader_token_creator"])
		expect(
			gcpPendingSetupSteps(
				setup,
				connector({ applied_logs_enabled: true, applied_metrics_enabled: true }),
			),
		).toEqual([])
	})
})

describe("gcpRemovalSteps", () => {
	it("removes the sink first, and only what was set up and is now off", () => {
		const off = connector({
			...ORGANIZATION,
			logs_enabled: false,
			applied_logs_enabled: true,
			applied_metrics_enabled: true,
		})
		expect(gcpRemovalSteps(off).map((step) => [step.id, step.summary])).toEqual([
			["sink", "maple-018f2b3c4d5e6f708192a3b4"],
			["subscription", "maple-018f2b3c4d5e6f708192a3b4"],
			["topic", "maple-018f2b3c4d5e6f708192a3b4"],
			["push_account", "maple-push-018f2b3c4d5e6f70819@acme-observability.iam.gserviceaccount.com"],
		])
		expect(gcpRemovalSteps(connector({ logs_enabled: false, applied_logs_enabled: null }))).toEqual([])
		expect(
			gcpRemovalSteps(connector({ metrics_enabled: false, applied_metrics_enabled: true })).map(
				(step) => step.id,
			),
		).toEqual(["reader_roles", "reader_account"])
	})
})

describe("gcpSetupChecks", () => {
	it("waits on what is on until confirmed, and on a removal until it is checked", () => {
		const fresh = gcpSetupChecks(connector(), "manual")
		expect(fresh.map((check) => [check.title, check.done, check.checkable])).toEqual([
			["Log forwarding", false, false],
			["Read-only access", false, true],
		])
		const removing = gcpSetupChecks(
			connector({ logs_enabled: false, applied_logs_enabled: true, applied_metrics_enabled: true }),
			"terraform",
		)
		expect(removing.map((check) => [check.title, check.done, check.checkable])).toEqual([
			["Log sink removed", false, true],
			["Read-only access", true, false],
		])
		expect(
			gcpSetupChecks(
				connector({ applied_logs_enabled: true, applied_metrics_enabled: true }),
				"alchemy",
			).every((check) => check.done),
		).toBe(true)
	})
})

describe("gcpAlchemyUnavailable", () => {
	it("sends a folder or organization with read-only access to Terraform", () => {
		expect(gcpAlchemyUnavailable({ scope_type: "organization", metrics_enabled: true })).toContain(
			"Terraform",
		)
		expect(gcpAlchemyUnavailable({ scope_type: "organization", metrics_enabled: false })).toBeNull()
		expect(gcpAlchemyUnavailable({ scope_type: "project", metrics_enabled: true })).toBeNull()
	})
})

describe("gcpAgentPrompt", () => {
	it("asks for a plan before applying, verification with gcloud, and the file in full", () => {
		const config = GCP_SETUP_FIXTURES.project.terraform
		const prompt = gcpAgentPrompt({
			flavour: "terraform",
			config,
			manual: manual("project"),
			connector: connector(),
		})
		expect(prompt).toContain("Run terraform plan and show me the plan. Apply only after I approve it.")
		expect(prompt).toContain(
			"gcloud pubsub subscriptions describe maple-018f2b3c4d5e6f708192a3b4 --project=acme-prod",
		)
		expect(prompt).toContain("click Check access")
		expect(prompt.endsWith(`--- maple.tf ---\n${config.trimEnd()}\n`)).toBe(true)
	})

	it("says what applying a regenerated file removes", () => {
		const prompt = gcpAgentPrompt({
			flavour: "alchemy",
			config: "// stack",
			manual: manual("organizationMetrics"),
			connector: connector({ ...ORGANIZATION, logs_enabled: false, applied_logs_enabled: true }),
		})
		expect(prompt).toContain("applying it removes the log sink, the Pub/Sub topic and subscription")
		expect(prompt).toContain("bunx alchemy deploy maple.ts --stage maple")
		expect(prompt).not.toContain("PROJECT_NUMBER")
	})
})
