import type { V2GcpConnector, V2GcpSetupScripts } from "@maple/domain/http/v2"
import { AsyncData } from "foldkit"
import type { Keyed } from "../../data/keyed"
import { type LoadFailure, toLoadFailure } from "../../data/load-failure"
import { GCP_SETUP_FIXTURES } from "../gcp-setup-fixtures"
import type { ApplyOpened, LogFilterDraft, SetupMethod } from "../../page/integrations/gcp-configure-schema"
import { agoOf, connectorOf } from "../gcp-host"

// The connect lab's fixtures: minutes old against the lab's clock.

export const STATES = {
	new: {
		label: "New connection",
		note: "Interactive. Continue on the Data step calls the API and fails here.",
	},
	configure: { label: "Configure", note: "An existing connection's Data step." },
	waiting: { label: "Run · waiting", note: "Just created, nothing reported yet." },
	reporting: { label: "Run · reporting", note: "Log forwarding reported, metrics still running." },
	overdue: { label: "Run · overdue", note: "Six minutes without a report." },
	removing: { label: "Run · org, removing logs", note: "An organization turning log forwarding off." },
	failed: { label: "Run · script failed", note: "The script couldn't be loaded." },
	connected: { label: "Connected", note: "First run confirmed, data not in yet." },
	applied: { label: "Applied", note: "A reconfigured organization, receiving." },
	method: { label: "Method", note: "The Method step, on the script." },
	"method-code": { label: "Method · code", note: "Infrastructure as code picked, Terraform." },
	"manual-project": {
		label: "Manual · project",
		note: "A project with logs and metrics, nothing confirmed.",
	},
	"manual-org": { label: "Manual · org logs", note: "An organization forwarding logs only." },
	"manual-failed": {
		label: "Manual · metrics failing",
		note: "Logs arrive; past the grant's grace, the poller's read is still denied.",
	},
	"manual-removal": { label: "Manual · removal", note: "Log forwarding switched off: what to delete." },
	terraform: { label: "Terraform", note: "Click Copy prompt for coding agent for the prompt." },
	"terraform-removal": {
		label: "Terraform · removal",
		note: "The regenerated file without log forwarding.",
	},
	alchemy: { label: "Alchemy", note: "The same project as an Alchemy stack." },
	"alchemy-org": {
		label: "Alchemy · org metrics",
		note: "An organization's read roles, granted by the file's own ScopeIamMember resource.",
	},
	"method-confirmed": {
		label: "Manual · confirmed",
		note: "Both confirmed: the steps stay in view for a change or a repair.",
	},
} as const

export const LAB_STATES = [
	"new",
	"configure",
	"waiting",
	"reporting",
	"overdue",
	"removing",
	"failed",
	"connected",
	"applied",
	"method",
	"method-code",
	"manual-project",
	"manual-org",
	"manual-failed",
	"manual-removal",
	"terraform",
	"terraform-removal",
	"alchemy",
	"alchemy-org",
	"method-confirmed",
] as const satisfies ReadonlyArray<keyof typeof STATES>
export type LabState = (typeof LAB_STATES)[number]
export type MethodState = "method" | "method-code"
export type MethodApplyState = Exclude<LabState, "new" | "configure" | MethodState | ScriptState>
export type ScriptState =
	| "waiting"
	| "reporting"
	| "overdue"
	| "removing"
	| "failed"
	| "connected"
	| "applied"

export const SCRIPT = `#!/usr/bin/env bash
# Maple setup for Google Cloud project acme-prod
#   Log forwarding:        on
#   Metrics and resources: on
# Safe to run again: it sets up what is on and removes what is off.
# Keep it private: PUSH_ENDPOINT contains this connection's secret.
set -euo pipefail
# gcloud would log every argument, the secret too, and the access token to ~/.config/gcloud/logs.
export CLOUDSDK_CORE_DISABLE_PROMPTS=1 CLOUDSDK_CORE_DISABLE_FILE_LOGGING=1

# ---- Which logs are forwarded ----
LOG_FILTER_MODE='set'
LOG_FILTER='severity>=DEFAULT'
PROJECT='acme-prod'
PUSH_ENDPOINT='https://ingest.maple.dev/v1/logpush/gcp/gcpc_YofPTrK9782DWwcnXhpcCw?secret=lab-fixture'
SINK_CREATED=0
ACCOUNT_CREATED=0

gcloud services enable pubsub.googleapis.com logging.googleapis.com monitoring.googleapis.com \\
  cloudasset.googleapis.com --project="$PROJECT"
gcloud pubsub topics create maple-logs-7f3k --project="$PROJECT"
gcloud logging sinks create maple-7f3k "pubsub.googleapis.com/projects/$PROJECT/topics/maple-logs-7f3k" \\
  --log-filter="$LOG_FILTER" --project="$PROJECT"
gcloud iam service-accounts create maple-7f3k --display-name="Maple (read-only)" --project="$PROJECT"
`

/** `GcpApplyView`'s props as the run step's state: `logFilter` is the draft that reads as it. */
export type ApplyFixture = Readonly<{
	connector: V2GcpConnector
	created: boolean
	filter: LogFilterDraft
	scripts: Keyed<V2GcpSetupScripts, LoadFailure>
	opened: ApplyOpened
}>

export type Fixtures = Readonly<{
	configured: V2GcpConnector
	apply: Readonly<Record<ScriptState, ApplyFixture>>
	method: Readonly<Record<MethodState, Readonly<{ connector: V2GcpConnector; method: SetupMethod }>>>
	methodApply: Readonly<Record<MethodApplyState, MethodApplyFixture>>
}>

/** `GcpMethodApplyView`'s props as state: the run step's, with the method. */
export type MethodApplyFixture = ApplyFixture & Readonly<{ method: SetupMethod }>

const PLATFORM_LOGS: LogFilterDraft = { keep: null, runtimes: null }
const CURRENT_FILTER: LogFilterDraft = { keep: null, runtimes: null }
/** Once the sink exists, "Platform logs" is a replaced filter. */
const REPLACED_PLATFORM_LOGS: LogFilterDraft = { keep: false, runtimes: null }

type SetupFields = (typeof GCP_SETUP_FIXTURES)[keyof typeof GCP_SETUP_FIXTURES]

const script = (
	text: string,
	setup: SetupFields = GCP_SETUP_FIXTURES.project,
): Keyed<V2GcpSetupScripts, LoadFailure> => ({
	key: null,
	data: AsyncData.Success({
		data: { object: "gcp_connector.setup_scripts", setup_script: text, cleanup_script: "", ...setup },
	}),
})

/** "Couldn't load the script.": an unexpected failure, as the run step words it. */
const FAILED_SCRIPT: Keyed<V2GcpSetupScripts, LoadFailure> = {
	key: null,
	data: AsyncData.Failure({ error: toLoadFailure("lab fixture: the script read failed") }),
}

type Over = Readonly<Record<string, unknown>>

/** `METHOD_APPLY`: "Platform logs" over an existing sink is a replaced filter. */
const methodApplyFixtures = (
	connector: (over?: Over) => V2GcpConnector,
	organization: Over,
	ago: (minutes: number) => string,
	opened: ApplyOpened,
): Fixtures["methodApply"] => {
	const removingLogs = connector({
		...organization,
		logs_enabled: false,
		applied_logs_enabled: true,
		applied_metrics_enabled: true,
		setup_reported_at: ago(60 * 24),
		last_metrics_received_at: ago(3),
		discovered_project_count: 14,
	})
	const fixture = (
		shown: V2GcpConnector,
		method: SetupMethod,
		setup: SetupFields,
		created = true,
	): MethodApplyFixture => ({
		connector: shown,
		created,
		filter: shown.applied_logs_enabled === true ? REPLACED_PLATFORM_LOGS : PLATFORM_LOGS,
		scripts: script("", setup),
		opened,
		method,
	})
	const failing =
		"Google denied Maple's read of project acme-prod: the read-only roles are missing. Grant them with the setup script, the console steps or your Terraform. A new grant can take a few minutes. (Cloud Monitoring returned 403 PERMISSION_DENIED)"
	return {
		"manual-project": fixture(connector(), "manual", GCP_SETUP_FIXTURES.project),
		"manual-org": fixture(
			connector({ ...organization, created_at: ago(2), metrics_enabled: false }),
			"manual",
			GCP_SETUP_FIXTURES.organization,
		),
		"manual-failed": fixture(
			connector({
				created_at: ago(20),
				applied_logs_enabled: true,
				last_log_received_at: ago(0.2),
				last_metrics_error: failing,
			}),
			"manual",
			GCP_SETUP_FIXTURES.project,
		),
		"manual-removal": fixture(removingLogs, "manual", GCP_SETUP_FIXTURES.organizationMetrics, false),
		terraform: fixture(connector(), "terraform", GCP_SETUP_FIXTURES.project),
		"terraform-removal": fixture(
			removingLogs,
			"terraform",
			GCP_SETUP_FIXTURES.organizationMetrics,
			false,
		),
		alchemy: fixture(connector(), "alchemy", GCP_SETUP_FIXTURES.project),
		"alchemy-org": fixture(
			connector({
				...organization,
				created_at: ago(1),
				logs_enabled: false,
				applied_logs_enabled: false,
			}),
			"alchemy",
			GCP_SETUP_FIXTURES.organizationMetrics,
		),
		"method-confirmed": fixture(
			connector({
				applied_logs_enabled: true,
				applied_metrics_enabled: true,
				setup_reported_at: ago(0.5),
				last_log_received_at: ago(0.3),
			}),
			"manual",
			GCP_SETUP_FIXTURES.project,
		),
	}
}

export const fixturesAt = (nowMs: number): Fixtures => {
	const ago = agoOf(nowMs)
	const base = {
		id: "gcpc_YofPTrK9782DWwcnXhpcCw",
		object: "gcp_connector",
		scope_type: "project",
		scope_id: "acme-prod",
		project_id: "acme-prod",
		logs_enabled: true,
		metrics_enabled: true,
		created_at: ago(1),
		last_log_received_at: null,
		last_log_error: null,
		applied_logs_enabled: null,
		applied_metrics_enabled: null,
		setup_reported_at: null,
		last_metrics_received_at: null,
		last_metrics_error: null,
		discovered_project_count: 0,
		last_resources_error: null,
	}
	const connector = (over: Readonly<Record<string, unknown>> = {}) => connectorOf(base, over)
	const organization = {
		scope_type: "organization",
		scope_id: "123456789012",
		project_id: "acme-observability",
		created_at: ago(60 * 24 * 7),
	}
	const receiving = {
		...organization,
		applied_logs_enabled: true,
		applied_metrics_enabled: true,
		last_log_received_at: ago(1),
		last_metrics_received_at: ago(3),
		discovered_project_count: 14,
	}
	const firstRun: ApplyOpened = { at: nowMs - 30_000, rerun: false, seen: null }
	const created = (over: Readonly<Record<string, unknown>>, filter: LogFilterDraft): ApplyFixture => ({
		connector: connector(over),
		created: true,
		filter,
		scripts: script(SCRIPT),
		opened: firstRun,
	})
	return {
		configured: connector({ ...receiving, setup_reported_at: ago(60 * 24) }),
		apply: {
			waiting: created({}, PLATFORM_LOGS),
			reporting: created(
				{ applied_logs_enabled: true, setup_reported_at: ago(0.3) },
				REPLACED_PLATFORM_LOGS,
			),
			overdue: created({ created_at: ago(6) }, { keep: null, runtimes: ["gke"] }),
			removing: {
				connector: connector({ ...receiving, logs_enabled: false, setup_reported_at: ago(60 * 24) }),
				created: false,
				filter: CURRENT_FILTER,
				scripts: script(SCRIPT),
				opened: { at: nowMs - 30_000, rerun: false, seen: ago(60 * 24) },
			},
			failed: { ...created({}, PLATFORM_LOGS), scripts: FAILED_SCRIPT },
			connected: created(
				{ applied_logs_enabled: true, applied_metrics_enabled: true, setup_reported_at: ago(3) },
				REPLACED_PLATFORM_LOGS,
			),
			applied: {
				connector: connector({ ...receiving, setup_reported_at: ago(4) }),
				created: false,
				filter: CURRENT_FILTER,
				scripts: script(SCRIPT),
				opened: { at: nowMs - 8 * 60_000, rerun: true, seen: ago(60 * 24) },
			},
		},
		method: {
			method: { connector: connector(), method: "script" },
			"method-code": { connector: connector(), method: "terraform" },
		},
		methodApply: methodApplyFixtures(connector, organization, ago, firstRun),
	}
}
