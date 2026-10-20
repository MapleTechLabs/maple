import {
	GCP_PUSH_SUBSCRIPTION,
	GCP_READER_PROJECT_ROLE,
	GCP_READER_SCOPE_ROLES,
	gcpConnectorResourceNames,
	gcpServiceAccountEmail,
	type GcpSetupPlan,
} from "@maple/domain/gcp"
import type { V2GcpConnector } from "@maple/domain/http/v2"

import { gcpScopeRoles } from "./gcp-connector-state"

/** One value to enter in the console, or several of a kind. `copy`: exact text, in mono with a copy button. */
export interface GcpStepField {
	readonly label: string
	readonly value: string | ReadonlyArray<string>
	readonly copy: boolean
}

/** A step of a console setup. */
export interface GcpManualStep {
	readonly title: string
	/** What the closed row shows on its right: the name it creates, or a count. */
	readonly summary: string
	/** Where in the console, and what to do there. */
	readonly intro: string
	readonly consoleUrl: string
	readonly fields: ReadonlyArray<GcpStepField>
	/** The step's pitfalls, one sentence each. */
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

type Scope = Pick<GcpSetupPlan, "scopeType" | "scopeId" | "projectId">

const hostPage = (path: string, scope: Scope) =>
	`${CONSOLE}/${path}?project=${encodeURIComponent(scope.projectId)}`

/** A scope's console page: the same query the connection's Log Router link uses. */
const scopePage = (path: string, scope: Scope) =>
	scope.scopeType === "project"
		? hostPage(path, scope)
		: `${CONSOLE}/${path}?${scope.scopeType === "folder" ? "folder" : "organizationId"}=${encodeURIComponent(scope.scopeId)}`

/** Where a step on the scope starts, and how to reach a folder or organization there. */
const onScope = (where: string, scope: Scope) =>
	scope.scopeType === "project"
		? `In ${where},`
		: `In ${where}, pick the ${scope.scopeType} ${scope.scopeId} in the resource picker, and`

/** The console steps that create what `plan` describes, in the order Google needs them. */
export function gcpManualSteps(plan: GcpSetupPlan): ReadonlyArray<GcpManualStep> {
	const { logs, reader } = plan
	const host = plan.projectId
	const steps: Array<GcpManualStep> = [
		{
			title: "Enable the APIs",
			summary: `${plan.apis.length} APIs`,
			intro: `In APIs & Services › Library, search for each API, open it and click Enable in ${host}. One that shows Manage and “API Enabled” is on already.`,
			consoleUrl: hostPage("apis/library", plan),
			fields: [field("APIs", plan.apis)],
			notes: [
				"pubsub.googleapis.com is the Cloud Pub/Sub API, not Pub/Sub Lite.",
				...(reader === null
					? []
					: ["Cloud Monitoring only answers for a project with billing linked."]),
			],
		},
	]
	if (logs !== null) {
		const topicPath = `projects/${host}/topics/${logs.topic}`
		steps.push(
			{
				title: "Create the Pub/Sub topic",
				summary: logs.topic,
				intro: "In Pub/Sub › Topics, click Create topic and click Create. The topic then warns that messages will be lost: the subscription in step 4 takes care of that.",
				consoleUrl: hostPage("cloudpubsub/topic/list", plan),
				fields: [field("Topic ID", logs.topic), field("Add a default subscription", "Off", false)],
				notes: ["The default subscription is on by default: left on, it keeps a copy of every log."],
			},
			{
				title: "Create the push service account",
				summary: logs.pushServiceAccountId,
				intro: "In IAM & Admin › Service accounts, click Create service account, fill in the name, then replace the ID the console fills in, and click Create and close. Then open the account, its Principals with access tab, and click Grant access.",
				consoleUrl: hostPage("iam-admin/serviceaccounts", plan),
				fields: [
					field("Service account name", "Maple log push identity"),
					field("Service account ID", logs.pushServiceAccountId),
					field("Description", "Signs Pub/Sub push requests to Maple. Holds no roles."),
					field("Grant access to", "service-PROJECT_NUMBER@gcp-sa-pubsub.iam.gserviceaccount.com"),
					field("Role", "Service Account Token Creator", false),
				],
				notes: [
					"In New principals, type gcp-sa-pubsub and pick “Cloud Pub/Sub Service Account for Project …”: that fills in PROJECT_NUMBER.",
					"The role picker starts on Service Account Admin: replace it with Service Account Token Creator.",
					"Only needed where the Pub/Sub service agent was created before April 8, 2021; harmless elsewhere. Google lists the grant only with Include Google-provided role grants ticked.",
				],
			},
			{
				title: "Create the push subscription",
				summary: logs.subscription,
				intro: "In Pub/Sub › Subscriptions, click Create subscription, set these, and click Create.",
				consoleUrl: hostPage("cloudpubsub/subscription/list", plan),
				fields: [
					field("Subscription ID", logs.subscription),
					field("Pub/Sub topic", topicPath),
					field("Delivery type", "Push", false),
					field("Endpoint URL", logs.pushEndpoint),
					field("Enable authentication", "On", false),
					field("Service account", logs.pushServiceAccountEmail),
					field("Audience (marked optional)", logs.pushEndpoint),
					field("Enable payload unwrapping", "On, Write metadata off", false),
					field(
						"Retry policy",
						`Retry after exponential backoff delay, ${GCP_PUSH_SUBSCRIPTION.minRetryDelaySeconds} to ${GCP_PUSH_SUBSCRIPTION.maxRetryDelaySeconds} seconds`,
						false,
					),
					field(
						"Acknowledgement deadline",
						`${GCP_PUSH_SUBSCRIPTION.ackDeadlineSeconds} seconds`,
						false,
					),
					field("Message retention duration", "1 day, 0 hours, 0 minutes", false),
					field("Expiry period", "Never expire", false),
				],
				notes: [
					"Without payload unwrapping Maple can't read what Pub/Sub sends, and drops it.",
					"The expiry period defaults to 31 days: an idle subscription would be deleted.",
				],
			},
			{
				title: `Create the Log Router sink${plan.scopeType === "project" ? "" : ` on the ${plan.scopeType}`}`,
				summary: logs.sink,
				intro: `${onScope("Logging › Log Router", plan)} create a sink.`,
				consoleUrl: scopePage("logs/router", plan),
				fields: [
					field("Sink name", logs.sink),
					...(plan.scopeType === "project"
						? [field("Sink service", "Cloud Pub/Sub topic", false), field("Topic", topicPath)]
						: [
								field("Sink service", "Other resource", false),
								field("Destination", logs.sinkDestination),
								field(
									"Logs to include",
									`Include logs ingested by this ${plan.scopeType} and all child resources`,
									false,
								),
							]),
					field("Build inclusion filter", logs.logFilter),
				],
				notes: [
					...(plan.scopeType === "project"
						? []
						: [
								"Not “Intercept logs”: that keeps the logs from the projects' own sinks and buckets.",
							]),
					"Entries written in the first minutes after the sink is created are dropped, not delayed.",
				],
			},
			{
				title: "Let the sink publish to the topic",
				summary: "Pub/Sub Publisher",
				intro: "In Log Router, open the sink's ⋮ menu › View sink details and copy its Writer identity. In Pub/Sub › Topics, tick the topic; in the info panel on the right (Show info panel if it's hidden) open Permissions › Add principal, paste the identity and grant the role.",
				consoleUrl: scopePage("logs/router", plan),
				fields: [field(`Topic ${logs.topic}`, "Pub/Sub Publisher", false)],
				notes: [
					"Paste the writer identity without its leading serviceAccount:, or the console refuses it.",
					"Grant it on the topic: on the IAM page it would cover every topic in the project.",
				],
			},
			{
				title: "Send a test message",
				summary: "Optional",
				intro: "In the topic's Messages tab, click Publish message, paste this as the message and click Publish. It proves the topic, subscription and push reach Maple, which confirms log forwarding; the sink is proven by the first real log.",
				consoleUrl: hostPage("cloudpubsub/topic/list", plan),
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
		steps.push(
			{
				title: "Create the read-only service account",
				summary: reader.serviceAccountId,
				intro: "In IAM & Admin › Service accounts, click Create service account, fill in the name, replace the ID the console fills in, and click Create and close. It gets no key.",
				consoleUrl: hostPage("iam-admin/serviceaccounts", plan),
				fields: [
					field("Service account name", "Maple metrics and resource reader"),
					field("Service account ID", reader.serviceAccountId),
				],
				notes: [],
			},
			{
				title: "Let Maple use the read-only account",
				summary: "Token Creator",
				intro: "Open the read-only account, its Principals with access tab, and click Grant access.",
				consoleUrl: hostPage("iam-admin/serviceaccounts", plan),
				fields: [
					field("Grant access to", reader.mapleServiceAccountEmail),
					field("Role", "Service Account Token Creator", false),
				],
				notes: [
					"The role picker starts on Service Account Admin: replace it with Service Account Token Creator.",
					"Before the roles: an organization policy that restricts members to your domain refuses this grant, and then nothing is left behind.",
				],
			},
			plan.scopeType === "project"
				? {
						title: "Grant the read-only roles",
						summary: `${GCP_READER_SCOPE_ROLES.length + 1} roles`,
						intro: `${onScope("IAM & Admin › IAM", plan)} click Grant access, paste the account as a new principal and add the roles, each after the first with Add another role.`,
						consoleUrl: scopePage("iam-admin/iam", plan),
						fields: [
							field("Principal", reader.serviceAccountEmail),
							field(
								"Roles",
								[...GCP_READER_SCOPE_ROLES, GCP_READER_PROJECT_ROLE].map(roleName).join(", "),
								false,
							),
						],
						notes: [],
					}
				: {
						title: `Grant the read-only roles on the ${plan.scopeType}`,
						summary: `${GCP_READER_SCOPE_ROLES.length} roles`,
						intro: `${onScope("IAM & Admin › IAM", plan)} click Grant access, paste the account as a new principal and add the roles, each after the first with Add another role.`,
						consoleUrl: scopePage("iam-admin/iam", plan),
						fields: [
							field("Principal", reader.serviceAccountEmail),
							field("Roles", GCP_READER_SCOPE_ROLES.map(roleName).join(", "), false),
						],
						notes: [`Granted on project ${host} instead, Maple would read only that project.`],
					},
			...(plan.scopeType === "project"
				? []
				: [
						{
							title: `Grant ${roleName(GCP_READER_PROJECT_ROLE)} on ${host}`,
							summary: "1 role",
							intro: `In IAM & Admin › IAM on project ${host}, grant the account the role Maple's reads are billed through.`,
							consoleUrl: hostPage("iam-admin/iam", plan),
							fields: [
								field("Principal", reader.serviceAccountEmail),
								field("Role", roleName(GCP_READER_PROJECT_ROLE), false),
							],
							notes: [],
						},
					]),
		)
	}
	return steps
}

/**
 * What a connection still has in Google Cloud, in the order to delete it: the sink first, two
 * minutes before the topic. `switched-off`: only what was switched off; `all`: everything not known
 * to be gone, for a disconnect. Leaves the shared Logs Writer grant alone.
 */
export function gcpRemovalList(
	connector: V2GcpConnector,
	which: "switched-off" | "all" = "switched-off",
): ReadonlyArray<{
	readonly what: string
	readonly name: string
	readonly consoleUrl: string
	readonly confirmed: boolean
}> {
	const names = gcpConnectorResourceNames(connector.id)
	const host = connector.project_id
	const scope: Scope = { scopeType: connector.scope_type, scopeId: connector.scope_id, projectId: host }
	const readerEmail = gcpServiceAccountEmail(names.serviceAccountId, host)
	const listed = (enabled: boolean, applied: boolean | null) =>
		(which === "all" || !enabled) && applied !== false
	return [
		...(listed(connector.logs_enabled, connector.applied_logs_enabled)
			? [
					{
						what: `Log Router sink on the ${connector.scope_type}, then wait two minutes`,
						name: names.sink,
						consoleUrl: scopePage("logs/router", scope),
					},
					{
						what: "Pub/Sub subscription",
						name: names.subscription,
						consoleUrl: hostPage("cloudpubsub/subscription/list", scope),
					},
					{
						what: "Pub/Sub topic: type delete to confirm",
						name: names.topic,
						consoleUrl: hostPage("cloudpubsub/topic/list", scope),
					},
					{
						what: "Push service account, if present",
						name: gcpServiceAccountEmail(names.pushServiceAccountId, host),
						consoleUrl: hostPage("iam-admin/serviceaccounts", scope),
					},
				]
			: []),
		...(listed(connector.metrics_enabled, connector.applied_metrics_enabled)
			? [
					{
						what: `The read-only account's roles on the ${connector.scope_type}${connector.scope_type === "project" ? "" : ` and ${host}`}: Remove access`,
						name: readerEmail,
						consoleUrl: scopePage("iam-admin/iam", scope),
					},
					{
						what: "Read-only service account",
						name: readerEmail,
						consoleUrl: hostPage("iam-admin/serviceaccounts", scope),
					},
				]
			: []),
	].map((item) => ({
		...item,
		confirmed:
			item.name === readerEmail
				? connector.applied_metrics_enabled === true
				: connector.applied_logs_enabled === true,
	}))
}

/**
 * What a coding agent is asked to do with the generated file: put it in place, plan and apply only
 * with approval, check the result with gcloud, and say how Maple confirms it.
 */
export function gcpAgentPrompt({
	flavour,
	config,
	plan,
	connector,
}: {
	flavour: "terraform" | "alchemy"
	config: string
	plan: GcpSetupPlan
	connector: V2GcpConnector
}): string {
	const host = plan.projectId
	const file = flavour === "terraform" ? "maple.tf" : "maple.ts"
	const removal = gcpRemovalList(connector)
	const removing = removal.some((item) => item.confirmed)
	const takesOver = connector.applied_logs_enabled === true || connector.applied_metrics_enabled === true
	const scopeRoles = gcpScopeRoles(plan.scopeType, connector)
	const place =
		flavour === "terraform"
			? `Add the file below as ${file} in a root module of its own (its import blocks only work there), next to the configuration that manages ${host}. Reuse the google provider credentials this repo already uses, and drop the file's terraform block if the providers are declared already.`
			: `Add the file below as ${file} and install what its header's bun add names.${plan.logs === null ? "" : ` Fill in PROJECT_NUMBER: gcloud projects describe ${host} --format='value(projectNumber)'.`} Switch the APIs on first: gcloud services enable ${plan.apis.join(" ")} --project=${host}`
	const apply =
		flavour === "terraform"
			? "Run terraform plan and show me the plan. Apply only after I approve it."
			: `Tell me what the stack creates and deploy only after I approve it, with the command in the file's header.`
	const verify = [
		...(plan.logs === null
			? []
			: [
					`gcloud pubsub subscriptions describe ${plan.logs.subscription} --project=${host} --format="value(pushConfig.pushEndpoint,pushConfig.oidcToken.serviceAccountEmail)"`,
					`gcloud logging sinks describe ${plan.logs.sink} --${plan.scopeType}=${plan.scopeId} --format="value(destination,writerIdentity)"`,
				]),
		...(plan.reader === null
			? []
			: [
					`gcloud iam service-accounts get-iam-policy ${plan.reader.serviceAccountEmail} --project=${host} --format="value(bindings.members)"`,
				]),
	]
	const finish = [
		plan.logs === null ? null : "the first log reaches Maple within a few minutes",
		plan.reader === null ? null : "Maple's first metrics read confirms read-only access within 5 minutes",
		removing ? "to click I've removed them in Maple's Google Cloud dialog" : null,
	].filter((part) => part !== null)
	const steps = [
		`${place} Keep every name and the endpoint URL exactly as given. If the repo already has a Maple log_filter, keep that one and ask me.${
			takesOver
				? ` An earlier setup created some of these resources: the file ${flavour === "terraform" ? "imports them" : "deploys with --adopt to take them over"}.`
				: ""
		}${
			removing
				? ` Applying it removes what an earlier version of this file created and this one no longer has. Whatever the file didn't create (a setup by script or in the console) I delete by hand: ${removal.map((item) => `${item.what}: ${item.name}`).join("; ")}.`
				: ""
		}`,
		`${apply} The account that applies it needs Owner on ${host}${scopeRoles.length === 0 ? "" : ` and ${scopeRoles.join(" and ")} on the ${plan.scopeType} ${plan.scopeId}`}.`,
		...(verify.length === 0
			? []
			: [`Verify with gcloud:\n${verify.map((command) => `   ${command}`).join("\n")}`]),
		`Finish by telling me: ${finish.join("; ")}.`,
	]
	return `Connect Google Cloud ${plan.scopeType} ${plan.scopeId} to Maple with this repo's ${flavour === "terraform" ? "Terraform" : "Alchemy"}.

${steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}

--- ${file} ---
${config.trimEnd()}
`
}
