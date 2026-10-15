import { useState } from "react"
import { Schema } from "effect"

import { V2GcpConnector } from "@maple/domain/http/v2"
import { Button } from "@maple/ui/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@maple/ui/components/ui/toggle-group"

import {
	GcpApplyView,
	GcpConfigure,
	GcpConfigureFrame,
	type ApplyOpened,
	type GcpApplyViewProps,
} from "@/components/integrations/gcp-configure"

/** The lab's clock: the fixtures are minutes old against the page's load. */
const NOW = Date.now()
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()

const decode = Schema.decodeUnknownSync(V2GcpConnector)
const connector = (over: Record<string, unknown> = {}) =>
	decode({
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
		...over,
	})

const ORGANIZATION = {
	scope_type: "organization",
	scope_id: "123456789012",
	project_id: "acme-observability",
	created_at: ago(60 * 24 * 7),
}

const SCRIPT = `#!/usr/bin/env bash
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

const FIRST_RUN: ApplyOpened = { at: NOW - 30_000, rerun: false, seen: null }
const noop = () => {}

type ApplyFixture = Omit<GcpApplyViewProps, "onBack" | "onClose" | "nowMs">

const STATES = {
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
} as const
type LabState = keyof typeof STATES

const APPLY = {
	waiting: {
		title: "Connect Google Cloud",
		connector: connector(),
		created: true,
		logFilter: "default",
		script: SCRIPT,
		failure: null,
		opened: FIRST_RUN,
	},
	reporting: {
		title: "Connect Google Cloud",
		connector: connector({ applied_logs_enabled: true, setup_reported_at: ago(0.3) }),
		created: true,
		logFilter: "default",
		script: SCRIPT,
		failure: null,
		opened: FIRST_RUN,
	},
	overdue: {
		title: "Connect Google Cloud",
		connector: connector({ created_at: ago(6) }),
		created: true,
		logFilter: "include_gke_container_logs",
		script: SCRIPT,
		failure: null,
		opened: FIRST_RUN,
	},
	removing: {
		title: "Organization 123456789012",
		connector: connector({
			...ORGANIZATION,
			logs_enabled: false,
			applied_logs_enabled: true,
			applied_metrics_enabled: true,
			setup_reported_at: ago(60 * 24),
			last_log_received_at: ago(1),
			last_metrics_received_at: ago(3),
			discovered_project_count: 14,
		}),
		created: false,
		logFilter: "keep",
		script: SCRIPT,
		failure: null,
		opened: { at: NOW - 30_000, rerun: false, seen: ago(60 * 24) },
	},
	failed: {
		title: "Connect Google Cloud",
		connector: connector(),
		created: true,
		logFilter: "default",
		script: null,
		failure: { message: "Couldn't load the script.", retry: noop, retrying: false },
		opened: FIRST_RUN,
	},
	connected: {
		title: "Connect Google Cloud",
		connector: connector({
			applied_logs_enabled: true,
			applied_metrics_enabled: true,
			setup_reported_at: ago(3),
		}),
		created: true,
		logFilter: "default",
		script: SCRIPT,
		failure: null,
		opened: FIRST_RUN,
	},
	applied: {
		title: "Organization 123456789012",
		connector: connector({
			...ORGANIZATION,
			applied_logs_enabled: true,
			applied_metrics_enabled: true,
			setup_reported_at: ago(4),
			last_log_received_at: ago(1),
			last_metrics_received_at: ago(3),
			discovered_project_count: 14,
		}),
		created: false,
		logFilter: "keep",
		script: SCRIPT,
		failure: null,
		opened: { at: NOW - 8 * 60_000, rerun: true, seen: ago(60 * 24) },
	},
} satisfies { readonly [State in Exclude<LabState, "new" | "configure">]: ApplyFixture }

const CONFIGURED = connector({
	...ORGANIZATION,
	applied_logs_enabled: true,
	applied_metrics_enabled: true,
	setup_reported_at: ago(60 * 24),
	last_log_received_at: ago(1),
	last_metrics_received_at: ago(3),
	discovered_project_count: 14,
})

/** Every step and run state of the Google Cloud connect dialog, over fixture connectors. */
export function GcpConnectLab() {
	const [state, setState] = useState<LabState>("new")
	// Bumped to reopen the dialog after it is closed, from its first step.
	const [opening, setOpening] = useState(0)
	const [open, setOpen] = useState(true)
	const close = () => setOpen(false)
	const show = (next: LabState) => {
		setState(next)
		setOpening(opening + 1)
		setOpen(true)
	}

	return (
		<div className="flex flex-col gap-4 p-6">
			<div className="flex flex-col gap-1">
				<h1 className="text-lg font-medium">Google Cloud connect flow</h1>
				<p className="text-sm text-muted-foreground">{STATES[state].note}</p>
			</div>
			<div className="flex flex-wrap items-center gap-3">
				<ToggleGroup
					variant="outline"
					connected={false}
					value={[state]}
					onValueChange={(values) => {
						const next = (Object.keys(STATES) as LabState[]).find(
							(key) => key !== state && values.includes(key),
						)
						if (next !== undefined) show(next)
					}}
				>
					{(Object.keys(STATES) as LabState[]).map((key) => (
						<ToggleGroupItem key={key} value={key} size="sm">
							{STATES[key].label}
						</ToggleGroupItem>
					))}
				</ToggleGroup>
				{open ? null : (
					<Button size="sm" variant="outline" onClick={() => show(state)}>
						Reopen
					</Button>
				)}
			</div>
			{!open ? null : state === "new" ? (
				<GcpConfigure
					key={opening}
					target={{ kind: "new" }}
					connectors={[]}
					metricsAvailable
					nowMs={NOW}
					onCreated={noop}
					onClose={close}
				/>
			) : state === "configure" ? (
				<GcpConfigure
					key={opening}
					target={{ kind: "connection", id: CONFIGURED.id, stage: "choose" }}
					connectors={[CONFIGURED]}
					metricsAvailable
					nowMs={NOW}
					onCreated={noop}
					onClose={close}
				/>
			) : (
				<GcpConfigureFrame key={opening} onClose={close}>
					<GcpApplyView {...APPLY[state]} nowMs={NOW} onBack={noop} onClose={close} />
				</GcpConfigureFrame>
			)}
		</div>
	)
}
