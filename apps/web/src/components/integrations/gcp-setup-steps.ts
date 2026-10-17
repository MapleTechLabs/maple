import { GCP_READER_PROJECT_ROLE, GCP_READER_SCOPE_ROLES, gcpConnectorResourceNames } from "@maple/domain/gcp"
import type { V2GcpConnector, V2GcpManualSetup, V2GcpSetupStep } from "@maple/domain/http/v2"
import type { GcpScopeType } from "@maple/domain/primitives"

import { gcpScopeRoles } from "./gcp-connector-state"

/** How a connection is set up. Chosen in the dialog's Method step and kept nowhere else. */
export type GcpSetupMethod = "script" | "manual" | "terraform" | "alchemy"

/**
 * One value to enter in the console, or several of a kind. `copy`: exact names or text, shown in
 * mono with a copy button each.
 */
export interface GcpStepField {
	readonly label: string
	readonly value: string | ReadonlyArray<string>
	readonly copy: boolean
}

/** A step of a console setup or removal. */
export interface GcpManualStep {
	readonly id: V2GcpSetupStep
	readonly title: string
	/** What the closed row shows on its right: the name it creates, or a count. */
	readonly summary: string
	/** Where in the console, and what to do there. */
	readonly intro: string
	readonly consoleUrl: string
	readonly fields: ReadonlyArray<GcpStepField>
	/** The pitfalls of the step, one sentence each. */
	readonly notes: ReadonlyArray<string>
}

const CONSOLE = "https://console.cloud.google.com"

const ROLE_NAMES = new Map([
	["roles/monitoring.viewer", "Monitoring Viewer"],
	["roles/cloudasset.viewer", "Cloud Asset Viewer"],
	["roles/serviceusage.serviceUsageConsumer", "Service Usage Consumer"],
])
const roleName = (role: string) => ROLE_NAMES.get(role) ?? role

const field = (label: string, value: GcpStepField["value"], copy = true): GcpStepField => ({
	label,
	value,
	copy,
})

const accountEmail = (accountId: string, projectId: string) =>
	`${accountId}@${projectId}.iam.gserviceaccount.com`

const duration = (seconds: number) =>
	seconds % 86_400 === 0
		? `${seconds / 86_400} ${seconds === 86_400 ? "day" : "days"}`
		: `${seconds} seconds`

interface Scope {
	readonly scope_type: GcpScopeType
	readonly scope_id: string
	readonly project_id: string
}

/**
 * The console page of a project or organization. A folder's address is not documented, so its
 * page opens on the project and the step says to switch to the folder.
 */
const scopePage = (path: string, scope: Scope) =>
	scope.scope_type === "organization"
		? `${CONSOLE}/${path}?organizationId=${encodeURIComponent(scope.scope_id)}`
		: `${CONSOLE}/${path}?project=${encodeURIComponent(scope.scope_type === "project" ? scope.scope_id : scope.project_id)}`

/** Where a step on the scope starts: the page, and how to get to the folder or organization on it. */
const onScope = (where: string, scope: Scope) =>
	scope.scope_type === "project"
		? `In ${where}`
		: `In ${where}, pick the ${scope.scope_type} ${scope.scope_id} in the resource picker`

const hostPage = (path: string, scope: Scope) =>
	`${CONSOLE}/${path}?project=${encodeURIComponent(scope.project_id)}`

const sinkFlag = (scope: Scope) => `--${scope.scope_type}=${scope.scope_id}`

/** The console steps that create what `manual` describes, in the order Google needs them. */
export function gcpManualSteps(manual: V2GcpManualSetup): ReadonlyArray<GcpManualStep> {
	const { logs, reader } = manual
	const host = manual.project_id
	const steps: Array<GcpManualStep> = [
		{
			id: "apis",
			title: "Enable the APIs",
			summary: `${manual.apis.length} APIs`,
			intro: `In APIs & Services › Library, search for each API and enable it in ${host}.`,
			consoleUrl: hostPage("apis/library", manual),
			fields: [
				field("APIs", manual.apis),
				...(reader === null
					? []
					: [
							field(
								"Billing",
								"Linked: Cloud Monitoring only answers for projects with billing",
								false,
							),
						]),
			],
			notes: [],
		},
	]
	if (logs !== null) {
		const topicPath = `projects/${host}/topics/${logs.topic}`
		steps.push(
			{
				id: "topic",
				title: "Create the Pub/Sub topic",
				summary: logs.topic,
				intro: "In Pub/Sub › Topics, create a topic.",
				consoleUrl: hostPage("cloudpubsub/topic/list", manual),
				fields: [field("Topic ID", logs.topic), field("Add a default subscription", "Off", false)],
				notes: [
					"The default subscription is on by default. Left on, it keeps a copy of every log nobody reads.",
				],
			},
			{
				id: "push_account",
				title: "Create the push service account",
				summary: logs.push_service_account_id,
				intro: "In IAM & Admin › Service accounts, create a service account and click Done without granting it a role. Then open its Permissions tab and grant access.",
				consoleUrl: hostPage("iam-admin/serviceaccounts", manual),
				fields: [
					field("Service account name", "Maple log push identity"),
					field("Service account ID", logs.push_service_account_id),
					field("Description", "Signs Pub/Sub push requests to Maple. Holds no roles."),
					field("Grant access to", "service-PROJECT_NUMBER@gcp-sa-pubsub.iam.gserviceaccount.com"),
					field("Role", "Service Account Token Creator", false),
				],
				notes: [
					"The grant is only needed in projects created before April 2021, and is harmless in newer ones.",
					`PROJECT_NUMBER is on the ${host} dashboard, or: gcloud projects describe ${host} --format='value(projectNumber)'`,
				],
			},
			{
				id: "subscription",
				title: "Create the push subscription",
				summary: logs.subscription,
				intro: "In Pub/Sub › Subscriptions, create a subscription on the topic with these settings.",
				consoleUrl: hostPage("cloudpubsub/subscription/list", manual),
				fields: [
					field("Subscription ID", logs.subscription),
					field("Pub/Sub topic", topicPath),
					field("Delivery type", "Push", false),
					field("Endpoint URL", logs.push_endpoint),
					field("Enable authentication", "On", false),
					field("Service account", logs.push_service_account_email),
					field("Audience", logs.push_endpoint),
					field("Enable payload unwrapping", "On, Write metadata off", false),
					field(
						"Retry policy",
						`Exponential backoff, ${logs.min_retry_delay_seconds} to ${logs.max_retry_delay_seconds} seconds`,
						false,
					),
					field("Acknowledgement deadline", `${logs.ack_deadline_seconds} seconds`, false),
					field("Message retention duration", duration(logs.message_retention_seconds), false),
					field("Expiration period", "Never expire", false),
				],
				notes: [
					"Without payload unwrapping Maple can't read what Pub/Sub sends, and drops it.",
					"The expiration period defaults to 31 days: an idle subscription would be deleted.",
				],
			},
			{
				id: "sink",
				title:
					manual.scope_type === "project"
						? "Create the Log Router sink"
						: `Create the Log Router sink on the ${manual.scope_type}`,
				summary: logs.sink,
				intro: `${onScope("Logging › Log Router", manual)}, and create a sink.`,
				consoleUrl: scopePage("logs/router", manual),
				fields: [
					field("Sink name", logs.sink),
					...(logs.include_children
						? [
								field("Sink service", "Other resource", false),
								field("Destination", logs.sink_destination),
								field(
									"Logs to include",
									`Include logs ingested by this ${manual.scope_type} and all child resources`,
									false,
								),
							]
						: [field("Sink service", "Pub/Sub topic", false), field("Topic", topicPath)]),
					field("Inclusion filter", logs.log_filter),
				],
				notes: [
					...(logs.include_children
						? [
								"Not “Intercept logs”: that keeps the logs from the projects' own sinks and buckets.",
							]
						: []),
					"Paste the filter unchanged: it leaves out Data Access audit logs, health checks and other noise.",
				],
			},
			{
				id: "sink_grants",
				title: "Let the sink publish to the topic",
				summary: "2 roles",
				intro: "In Log Router, open the sink's ⋮ menu › View sink details and copy its writer identity. Grant it Pub/Sub Publisher in the topic's Permissions panel, and Logs Writer in IAM on the host project.",
				consoleUrl: hostPage("cloudpubsub/topic/list", manual),
				fields: [
					field(`Topic ${logs.topic}`, "Pub/Sub Publisher", false),
					field(`Project ${host}`, "Logs Writer", false),
				],
				notes: [
					"Grant Publisher on the topic: on the IAM page it would cover every topic in the project.",
					"The console may have granted these already when it created the sink. Add whichever is missing.",
				],
			},
			{
				id: "test_message",
				title: "Send a test message",
				summary: "Optional",
				intro: "In Pub/Sub › Topics, open the topic's Messages tab and publish this message. Maple confirms log forwarding as soon as it arrives, before the first log.",
				consoleUrl: hostPage("cloudpubsub/topic/list", manual),
				fields: [
					field(
						"Message body",
						JSON.stringify({
							logName: `projects/${host}/logs/maple-setup`,
							jsonPayload: { logs: true },
						}),
					),
				],
				notes: [],
			},
		)
	}
	if (reader !== null) {
		const scopeRoles = reader.scope_roles.map(roleName)
		const projectRoles = reader.project_roles.map(roleName)
		steps.push(
			{
				id: "reader_account",
				title: "Create the read-only service account",
				summary: reader.service_account_id,
				intro: "In IAM & Admin › Service accounts, create a service account and click Done. It gets no key.",
				consoleUrl: hostPage("iam-admin/serviceaccounts", manual),
				fields: [
					field("Service account name", "Maple metrics and resource reader"),
					field("Service account ID", reader.service_account_id),
				],
				notes: [],
			},
			{
				id: "reader_roles",
				title: "Grant the read-only roles",
				summary: `${scopeRoles.length + projectRoles.length} roles`,
				intro: `${onScope("IAM & Admin › IAM", manual)}, grant the account access.`,
				consoleUrl: scopePage("iam-admin/iam", manual),
				fields: [
					field("Principal", reader.service_account_email),
					...(manual.scope_type === "project"
						? [field("Roles", [...scopeRoles, ...projectRoles].join(", "), false)]
						: [
								field(`Roles on the ${manual.scope_type}`, scopeRoles.join(", "), false),
								field(`Roles on project ${host}`, projectRoles.join(", "), false),
							]),
				],
				notes:
					manual.scope_type === "project"
						? []
						: [
								`Grant the first roles on the ${manual.scope_type}, not the host project: otherwise only ${host} is read.`,
							],
			},
			{
				id: "reader_token_creator",
				title: "Let Maple use the read-only account",
				summary: "Token Creator",
				intro: "In IAM & Admin › Service accounts, open the read-only account's Permissions tab and grant access.",
				consoleUrl: hostPage("iam-admin/serviceaccounts", manual),
				fields: [
					field("Grant access to", reader.maple_service_account_email),
					field("Role", "Service Account Token Creator", false),
				],
				notes: [
					"An organization policy that restricts members to your domain refuses this grant. The docs say how to allow this one account.",
				],
			},
		)
	}
	return steps
}

const LOG_STEPS: ReadonlySet<V2GcpSetupStep> = new Set<V2GcpSetupStep>([
	"topic",
	"push_account",
	"subscription",
	"sink",
	"sink_grants",
	"test_message",
])

/** The console steps of what a connection collects and Google Cloud does not have yet. */
export const gcpPendingSetupSteps = (
	manual: V2GcpManualSetup,
	connector: Pick<V2GcpConnector, "applied_logs_enabled" | "applied_metrics_enabled">,
): ReadonlyArray<GcpManualStep> => {
	const pending = gcpManualSteps(manual).filter((step) =>
		LOG_STEPS.has(step.id)
			? connector.applied_logs_enabled !== true
			: step.id === "apis" || connector.applied_metrics_enabled !== true,
	)
	// The APIs alone are no setup: everything they serve is in place.
	return pending.every((step) => step.id === "apis") ? [] : pending
}

/**
 * The console steps that remove what a connection no longer collects: the log sink first, so
 * nothing routes into a topic that is gone.
 */
export function gcpRemovalSteps(connector: V2GcpConnector): ReadonlyArray<GcpManualStep> {
	const names = gcpConnectorResourceNames(connector.id)
	const host = connector.project_id
	const removeLogs = !connector.logs_enabled && connector.applied_logs_enabled === true
	const removeReader = !connector.metrics_enabled && connector.applied_metrics_enabled === true
	const remove = (
		id: V2GcpSetupStep,
		title: string,
		name: string,
		intro: string,
		consoleUrl: string,
		notes: ReadonlyArray<string> = [],
	): GcpManualStep => ({
		id,
		title,
		summary: name,
		intro,
		consoleUrl,
		fields: [field("Name", name)],
		notes,
	})
	const readerEmail = accountEmail(names.serviceAccountId, host)
	return [
		...(removeLogs
			? [
					remove(
						"sink",
						"Delete the Log Router sink",
						names.sink,
						`${onScope("Logging › Log Router", connector)}, and delete the sink.`,
						scopePage("logs/router", connector),
						["Wait a minute before deleting the topic: Google keeps routing to it for a moment."],
					),
					remove(
						"subscription",
						"Delete the push subscription",
						names.subscription,
						"In Pub/Sub › Subscriptions, delete the subscription.",
						hostPage("cloudpubsub/subscription/list", connector),
					),
					remove(
						"topic",
						"Delete the Pub/Sub topic",
						names.topic,
						"In Pub/Sub › Topics, delete the topic.",
						hostPage("cloudpubsub/topic/list", connector),
					),
					remove(
						"push_account",
						"Delete the push service account",
						accountEmail(names.pushServiceAccountId, host),
						"In IAM & Admin › Service accounts, delete the account.",
						hostPage("iam-admin/serviceaccounts", connector),
					),
				]
			: []),
		...(removeReader
			? [
					{
						...remove(
							"reader_roles",
							"Remove the read-only roles",
							readerEmail,
							`${onScope("IAM & Admin › IAM", connector)}, and remove the account's roles.`,
							scopePage("iam-admin/iam", connector),
						),
						summary: `${GCP_READER_SCOPE_ROLES.length + 1} roles`,
						notes:
							connector.scope_type === "project"
								? []
								: [
										`${roleName(GCP_READER_PROJECT_ROLE)} is on project ${host}, the others on the ${connector.scope_type}.`,
									],
						fields: [
							field("Principal", readerEmail),
							field(
								"Roles",
								[...GCP_READER_SCOPE_ROLES, GCP_READER_PROJECT_ROLE].map(roleName).join(", "),
								false,
							),
						],
					},
					remove(
						"reader_account",
						"Delete the read-only service account",
						readerEmail,
						"In IAM & Admin › Service accounts, delete the account.",
						hostPage("iam-admin/serviceaccounts", connector),
					),
				]
			: []),
	]
}

/** A capability's confirmation in a setup without the script, which sends Maple no report. */
export interface GcpSetupCheck {
	readonly capability: "logs" | "metrics"
	readonly title: string
	readonly done: boolean
	/** Confirmed by Check access; log forwarding by the first push instead. */
	readonly checkable: boolean
	readonly detail: string
}

/**
 * What waits on Google Cloud for a connection set up or changed without the script: a capability
 * that is on until it is confirmed, one switched off until its removal is.
 */
export function gcpSetupChecks(
	connector: V2GcpConnector,
	method: Exclude<GcpSetupMethod, "script">,
): ReadonlyArray<GcpSetupCheck> {
	const scope = `${connector.scope_type} ${connector.scope_id}`
	const later =
		method === "manual"
			? "Check once the read-only steps are done"
			: `Check after you ${method === "terraform" ? "apply" : "deploy"}`
	return [
		connector.logs_enabled
			? {
					capability: "logs" as const,
					title: "Log forwarding",
					done: connector.applied_logs_enabled === true,
					checkable: false,
					detail:
						connector.applied_logs_enabled === true
							? "Maple receives this connection's logs"
							: "Confirmed by the first log Maple receives",
				}
			: connector.applied_logs_enabled === true
				? {
						capability: "logs" as const,
						title: "Log sink removed",
						done: false,
						checkable: true,
						detail: "Check once the log sink is deleted",
					}
				: null,
		connector.metrics_enabled
			? {
					capability: "metrics" as const,
					title: "Read-only access",
					done: connector.applied_metrics_enabled === true,
					checkable: connector.applied_metrics_enabled !== true,
					detail: connector.applied_metrics_enabled === true ? `Maple can read ${scope}` : later,
				}
			: connector.applied_metrics_enabled === true
				? {
						capability: "metrics" as const,
						title: "Read-only account removed",
						done: false,
						checkable: true,
						detail: "Check once the account is deleted",
					}
				: null,
	].filter((check) => check !== null)
}

/** Whether Alchemy can express the connection: it can't grant roles on a folder or organization. */
export const gcpAlchemyUnavailable = (connector: Pick<V2GcpConnector, "scope_type" | "metrics_enabled">) =>
	connector.scope_type !== "project" && connector.metrics_enabled
		? `Alchemy can't grant roles on ${connector.scope_type === "folder" ? "a folder" : "an organization"}. Use Terraform for this connection.`
		: null

/**
 * What a coding agent is asked to do with the generated file: put it in place, plan and apply only
 * with approval, check the result with gcloud, and hand back to Maple's dialog.
 */
export function gcpAgentPrompt({
	flavour,
	config,
	manual,
	connector,
}: {
	flavour: "terraform" | "alchemy"
	config: string
	manual: V2GcpManualSetup
	connector: V2GcpConnector
}): string {
	const host = manual.project_id
	const names = gcpConnectorResourceNames(connector.id)
	const file = flavour === "terraform" ? "maple.tf" : "maple.ts"
	const removing = [
		!connector.logs_enabled && connector.applied_logs_enabled === true
			? "the log sink, the Pub/Sub topic and subscription, and the push service account"
			: null,
		!connector.metrics_enabled && connector.applied_metrics_enabled === true
			? "the read-only service account and its roles"
			: null,
	].filter((part) => part !== null)
	const scopeRoles = gcpScopeRoles(manual.scope_type, connector)
	const place =
		flavour === "terraform"
			? `Add the file below as ${file} in a directory or module of its own, next to the configuration that manages ${host}. Reuse the google provider credentials this repo already uses, and drop the file's terraform block if the providers are declared already.`
			: `Add the file below as ${file}. Install the alchemy version its header names.${manual.logs === null ? "" : ` Fill in PROJECT_NUMBER: gcloud projects describe ${host} --format='value(projectNumber)'.`} Switch the APIs on first: gcloud services enable ${manual.apis.join(" ")} --project=${host}`
	const apply =
		flavour === "terraform"
			? "Run terraform plan and show me the plan. Apply only after I approve it."
			: `Tell me what the stack creates and deploy only after I approve it: GOOGLE_ACCESS_TOKEN="$(gcloud auth print-access-token)" GOOGLE_PROJECT_ID=${host} bunx alchemy deploy ${file} --stage maple`
	const verify = [
		...(manual.logs === null
			? []
			: [
					`gcloud pubsub subscriptions describe ${manual.logs.subscription} --project=${host} --format="value(pushConfig.pushEndpoint,pushConfig.oidcToken.serviceAccountEmail)"`,
					`gcloud logging sinks describe ${manual.logs.sink} ${sinkFlag(manual)} --format="value(destination,writerIdentity)"`,
				]),
		...(manual.reader === null
			? []
			: [
					`gcloud iam service-accounts get-iam-policy ${manual.reader.service_account_email} --project=${host} --format="value(bindings.members)"`,
				]),
		...(removing.length === 0
			? []
			: [
					`gcloud iam service-accounts list --project=${host} --format="value(email)" (no ${names.serviceAccountId} or ${names.pushServiceAccountId} left)`,
				]),
	]
	const finish = [
		manual.reader !== null || removing.length > 0
			? "click Check access in Maple's Google Cloud dialog"
			: null,
		manual.logs === null ? null : "expect the first logs in Maple within about 10 minutes",
	].filter((part) => part !== null)
	const steps = [
		`${place} Keep every name, the endpoint URL and the log filter exactly as given.${removing.length === 0 ? "" : ` It replaces an earlier version of the file: applying it removes ${removing.join(", and ")}.`}`,
		`${apply} The account that applies it needs Owner on ${host}${scopeRoles.length === 0 ? "" : ` and ${scopeRoles.join(" and ")} on the ${manual.scope_type} ${manual.scope_id}`}.`,
		`Verify with gcloud:\n${verify.map((command) => `   ${command}`).join("\n")}`,
		`Finish by telling me to ${finish.join(", and ")}.`,
	]
	return `Connect Google Cloud ${manual.scope_type} ${manual.scope_id} to Maple with this repo's ${flavour === "terraform" ? "Terraform" : "Alchemy"}.

${steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}

--- ${file} ---
${config.trimEnd()}
`
}
