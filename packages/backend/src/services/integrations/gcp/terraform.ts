import {
	GCP_PUSH_SUBSCRIPTION,
	GCP_READER_PROJECT_ROLE,
	GCP_READER_SCOPE_ROLES,
	type GcpSetupPlan,
} from "@maple/domain/gcp"
import type { GcpScopeType } from "@maple/primitives"
import { Array as Arr, String as Str } from "effect"

/** An HCL string literal: `${` and `%{` would start a template, a newline would end the line. */
export const hcl = (value: string): string =>
	`"${Str.replaceAll(
		"%{",
		"%%{",
	)(
		Str.replaceAll(
			"\n",
			"\\n",
		)(
			// In a replacement string `$$` is one literal `$`, so `$$$$` writes `$$`.
			Str.replaceAll("${", "$$$${")(Str.replaceAll('"', '\\"')(Str.replaceAll("\\", "\\\\")(value))),
		),
	)}"`

const hclList = (values: ReadonlyArray<string>) =>
	`[\n${Arr.join(
		Arr.map(values, (value) => `    ${hcl(value)},\n`),
		"",
	)}  ]`

// `terraform fmt` aligns the equals signs of consecutive attributes.
const attributes = (pairs: ReadonlyArray<readonly [string, string]>) => {
	const width = Math.max(...Arr.map(pairs, ([name]) => name.length))
	return Arr.join(
		Arr.map(pairs, ([name, value]) => `  ${Str.padEnd(width)(name)} = ${value}\n`),
		"",
	)
}

// Per scope: the sink resource, the IAM member resource, their scope argument and value, and the
// sink's import ID prefix.
const SCOPES = {
	project: [
		"google_logging_project_sink",
		"google_project_iam_member",
		"project",
		"local.project_id",
		"projects",
	],
	folder: [
		"google_logging_folder_sink",
		"google_folder_iam_member",
		"folder",
		"local.folder_id",
		"folders",
	],
	organization: [
		"google_logging_organization_sink",
		"google_organization_iam_member",
		"org_id",
		"local.organization_id",
		"organizations",
	],
} as const

// `commented`: for a resource only some earlier setups created, to take over by uncommenting.
const importBlock = (to: string, id: string, commented = false) => {
	const block = [`import {`, `  to = ${to}`, `  id = ${hcl(id)}`, `}`]
	return `\n${Arr.join(
		Arr.map(block, (line) => (commented ? `# ${line}` : line)),
		"\n",
	)}\n`
}

/** What Maple has recorded as set up: Terraform imports it rather than failing on a duplicate. */
export interface GcpExisting {
	readonly logs: boolean
	readonly reader: boolean
}

const logsSection = (plan: GcpSetupPlan, logs: NonNullable<GcpSetupPlan["logs"]>, existing: boolean) => {
	const [sink, , scopeArg, scopeValue, sinkPrefix] = SCOPES[plan.scopeType]
	const host = plan.projectId
	return `
# ---- Log forwarding ----
${
	existing
		? `# An earlier setup created the topic, subscription and sink: Terraform takes them over.
${importBlock("google_pubsub_topic.maple", `projects/${host}/topics/${logs.topic}`)}${importBlock("google_pubsub_subscription.maple", `projects/${host}/subscriptions/${logs.subscription}`)}${importBlock(`${sink}.maple`, `${sinkPrefix}/${plan.scopeId}/sinks/${logs.sink}`)}
# A setup in the console also created the push service account: uncomment to take it over.
${importBlock("google_service_account.maple_push", `projects/${host}/serviceAccounts/${logs.pushServiceAccountEmail}`, true)}
`
		: ""
}resource "google_pubsub_topic" "maple" {
  project = local.project_id
  name    = ${hcl(logs.topic)}

  depends_on = [google_project_service.maple]
}

# One LogEntry per request, unwrapped. A day of retention bounds a replay; it never expires idle.
resource "google_pubsub_subscription" "maple" {
  project                    = local.project_id
  name                       = ${hcl(logs.subscription)}
  topic                      = google_pubsub_topic.maple.id
  ack_deadline_seconds       = ${GCP_PUSH_SUBSCRIPTION.ackDeadlineSeconds}
  message_retention_duration = "${GCP_PUSH_SUBSCRIPTION.messageRetentionSeconds}s"

  expiration_policy {
    ttl = ""
  }

  retry_policy {
    minimum_backoff = "${GCP_PUSH_SUBSCRIPTION.minRetryDelaySeconds}s"
    maximum_backoff = "${GCP_PUSH_SUBSCRIPTION.maxRetryDelaySeconds}s"
  }

  push_config {
    push_endpoint = local.push_endpoint

    no_wrapper {
      write_metadata = false
    }

    oidc_token {
      service_account_email = google_service_account.maple_push.email
      audience              = local.push_endpoint
    }
  }

  depends_on = [google_service_account_iam_member.maple_push_token_creator]
}

# Google keeps routing over a minute after a sink is deleted: the subscription and topic outlive it
# two minutes, or Google logs an error. The sink also waits for the subscription to deliver to.
resource "time_sleep" "maple_sink_drain" {
  destroy_duration = "120s"

  depends_on = [google_pubsub_subscription.maple]
}

resource "${sink}" "maple" {
${attributes([
	[scopeArg, scopeValue],
	["name", hcl(logs.sink)],
	["destination", `"pubsub.googleapis.com/\${google_pubsub_topic.maple.id}"`],
	["filter", "local.log_filter"],
	plan.scopeType === "project" ? ["unique_writer_identity", "true"] : ["include_children", "true"],
])}
  depends_on = [time_sleep.maple_sink_drain]
}

# The sink writes as the logging service agent every sink on the ${plan.scopeType} shares. Publisher on
# this topic is all it needs; a project role it holds is not this file's to revoke.
resource "google_pubsub_topic_iam_member" "maple_sink_publisher" {
  project = local.project_id
  topic   = google_pubsub_topic.maple.name
  role    = "roles/pubsub.publisher"
  member  = ${sink}.maple.writer_identity
}
`
}

// One push identity signs both subscriptions: declared once when either is on.
const pushIdentitySection = (plan: GcpSetupPlan, pushServiceAccountId: string) => {
	const topics = [
		...(plan.logs === null ? [] : ["google_pubsub_topic.maple"]),
		...(plan.security === null ? [] : ["google_pubsub_topic.maple_security"]),
	]
	return `
# ---- Push identity ----
# What Pub/Sub signs its pushes to Maple as. It holds no role anywhere.
resource "google_service_account" "maple_push" {
  project      = local.project_id
  account_id   = ${hcl(pushServiceAccountId)}
  display_name = ${plan.logs === null ? '"Maple push identity"' : '"Maple log push identity"'}
  description  = "Signs Pub/Sub push requests to Maple. Holds no roles."

  depends_on = [google_project_service.maple]
}

data "google_project" "host" {
  project_id = local.project_id
}

# Pub/Sub's service agent mints the push tokens: needed in projects created before April 2021.
# Google creates the agent with a first topic, so the grant waits for one.
resource "google_service_account_iam_member" "maple_push_token_creator" {
  service_account_id = google_service_account.maple_push.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:service-\${data.google_project.host.number}@gcp-sa-pubsub.iam.gserviceaccount.com"

  depends_on = [${Arr.join(topics, ", ")}]
}
`
}

// Per scope: the notification config resource, its scope argument and value, its import ID prefix.
const NOTIFICATION_CONFIGS = {
	project: ["google_scc_v2_project_notification_config", "project", "local.project_id", "projects"],
	folder: ["google_scc_v2_folder_notification_config", "folder", "local.folder_id", "folders"],
	organization: [
		"google_scc_v2_organization_notification_config",
		"organization",
		"local.organization_id",
		"organizations",
	],
} as const satisfies Record<GcpScopeType, readonly [string, string, string, string]>

const securitySection = (plan: GcpSetupPlan, security: NonNullable<GcpSetupPlan["security"]>) => {
	const [config, scopeArg, scopeValue, prefix] = NOTIFICATION_CONFIGS[plan.scopeType]
	const host = plan.projectId
	return `
# ---- Security findings ----
# If an earlier setup made these, uncomment to take them over.
${importBlock("google_pubsub_topic.maple_security", `projects/${host}/topics/${security.topic}`, true)}${importBlock("google_pubsub_subscription.maple_security", `projects/${host}/subscriptions/${security.subscription}`, true)}${importBlock(`${config}.maple`, `${prefix}/${plan.scopeId}/locations/global/notificationConfigs/${security.notificationConfig}`, true)}
resource "google_pubsub_topic" "maple_security" {
  project = local.project_id
  name    = ${hcl(security.topic)}

  depends_on = [google_project_service.maple]
}

# One finding per request, unwrapped, signed as the push identity for Maple's address.
resource "google_pubsub_subscription" "maple_security" {
  project                    = local.project_id
  name                       = ${hcl(security.subscription)}
  topic                      = google_pubsub_topic.maple_security.id
  ack_deadline_seconds       = ${GCP_PUSH_SUBSCRIPTION.ackDeadlineSeconds}
  message_retention_duration = "${GCP_PUSH_SUBSCRIPTION.messageRetentionSeconds}s"

  expiration_policy {
    ttl = ""
  }

  retry_policy {
    minimum_backoff = "${GCP_PUSH_SUBSCRIPTION.minRetryDelaySeconds}s"
    maximum_backoff = "${GCP_PUSH_SUBSCRIPTION.maxRetryDelaySeconds}s"
  }

  push_config {
    push_endpoint = local.security_push_endpoint

    no_wrapper {
      write_metadata = false
    }

    oidc_token {
      service_account_email = google_service_account.maple_push.email
      audience              = local.security_push_endpoint
    }
  }

  depends_on = [google_service_account_iam_member.maple_push_token_creator]
}

# Security Command Center sends each finding written or changed on the ${plan.scopeType} to the topic.
# Creating it grants its own service agent the right to publish there. Destroyed before the
# subscription, so nothing publishes into a topic that is gone.
resource "${config}" "maple" {
${attributes([
	["config_id", hcl(security.notificationConfig)],
	[scopeArg, scopeValue],
	["location", '"global"'],
	["description", '"Sends Security Command Center findings to Maple."'],
	["pubsub_topic", "google_pubsub_topic.maple_security.id"],
])}
  streaming_config {
    filter = local.security_filter
  }

  depends_on = [google_pubsub_subscription.maple_security]
}
`
}

// The account reads metrics, findings, or both: named for what it does, as the setup script does.
const readerDisplayName = (reader: NonNullable<GcpSetupPlan["reader"]>) =>
	Arr.some(GCP_READER_SCOPE_ROLES, (role) => Arr.contains(reader.scopeRoles, role))
		? '"Maple metrics and resource reader"'
		: '"Maple security findings reader"'

const readerSection = (
	plan: GcpSetupPlan,
	reader: NonNullable<GcpSetupPlan["reader"]>,
	existing: boolean,
) => {
	const [, member, scopeArg, scopeValue] = SCOPES[plan.scopeType]
	return `
# ---- Read-only access: metrics and resources, security findings ----
# A read-only account Maple reads as through short-lived tokens. No key is created.
${
	existing
		? `${importBlock("google_service_account.maple_reader", `projects/${plan.projectId}/serviceAccounts/${reader.serviceAccountEmail}`)}
`
		: `# If an earlier setup left the read-only account in place, uncomment to take it over.
${importBlock("google_service_account.maple_reader", `projects/${plan.projectId}/serviceAccounts/${reader.serviceAccountEmail}`, true)}
`
}resource "google_service_account" "maple_reader" {
  project      = local.project_id
  account_id   = ${hcl(reader.serviceAccountId)}
  display_name = ${readerDisplayName(reader)}

  depends_on = [google_project_service.maple]
}

resource "google_service_account_iam_member" "maple_reader_token_creator" {
  service_account_id = google_service_account.maple_reader.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:\${local.maple_service_account}"
}

# The narrowest predefined roles for Maple's reads, on the ${plan.scopeType}.${Arr.contains(reader.scopeRoles, "roles/cloudasset.viewer") ? " Cloud Asset Viewer can also read IAM policies." : ""}
resource "${member}" "maple_reader" {
  for_each = toset(${hclList(reader.scopeRoles)})

${attributes([
	[scopeArg, plan.scopeType === "folder" ? `"folders/\${local.folder_id}"` : scopeValue],
	["role", "each.value"],
	["member", `"serviceAccount:\${google_service_account.maple_reader.email}"`],
])}}

# Maple's reads count against the host project's quota.
resource "google_project_iam_member" "maple_reader_quota" {
  project = local.project_id
  role    = ${hcl(GCP_READER_PROJECT_ROLE)}
  member  = "serviceAccount:\${google_service_account.maple_reader.email}"
}
`
}

/** A self-contained Terraform file for the connection: every resource inline, readable before it is applied. */
export const renderGcpTerraform = (plan: GcpSetupPlan, existing: GcpExisting): string => {
	const { logs, reader, security } = plan
	const pushServiceAccountId = logs?.pushServiceAccountId ?? security?.pushServiceAccountId
	const locals: ReadonlyArray<readonly [string, string]> = [
		["project_id", hcl(plan.projectId)],
		...(plan.scopeType === "folder" ? [["folder_id", hcl(plan.scopeId)] as const] : []),
		...(plan.scopeType === "organization" ? [["organization_id", hcl(plan.scopeId)] as const] : []),
		...(logs === null
			? []
			: [
					["push_endpoint", hcl(logs.pushEndpoint)] as const,
					["log_filter", hcl(logs.logFilter)] as const,
				]),
		...(reader === null
			? []
			: [["maple_service_account", hcl(reader.mapleServiceAccountEmail)] as const]),
		...(security === null
			? []
			: [
					["security_push_endpoint", hcl(security.pushEndpoint)] as const,
					["security_filter", hcl(security.filter)] as const,
				]),
	]
	return `# Maple connection for Google Cloud ${plan.scopeType} ${plan.scopeId}
#   Log forwarding:        ${logs === null ? "off" : "on"}
#   Metrics and resources: ${reader !== null && Arr.some(GCP_READER_SCOPE_ROLES, (role) => Arr.contains(reader.scopeRoles, role)) ? "on" : "off"}
#   Security findings:     ${security === null ? "off" : "on"}
# This configuration carries no secret${pushServiceAccountId === undefined ? "." : `: Pub/Sub signs each push as ${pushServiceAccountId},\n# and Maple checks the signature.`} Put it in a root module of its own: names follow the
# connection, and imports only work in a root module.
# Details: https://maple.dev/docs/integrations/gcp-infrastructure-as-code

terraform {
  required_version = ">= 1.5"

  # Drop this block where your configuration declares these providers already.
  required_providers {
${security === null ? "" : "    # 5.42 brought the last of the SCC v2 notification config resources, the folder's.\n"}    google = {
      source  = "hashicorp/google"
      version = "${security === null ? ">= 5.0" : ">= 5.42"}, < 8.0"
    }${
		logs === null
			? ""
			: `
    time = {
      source  = "hashicorp/time"
      version = ">= 0.9, < 1.0"
    }`
	}
  }
}

locals {
${attributes(locals)}}

# APIs in the host project. They stay on when this is destroyed.
resource "google_project_service" "maple" {
  for_each = toset(${hclList(plan.apis)})

  project            = local.project_id
  service            = each.value
  disable_on_destroy = false
}
${logs === null ? "" : logsSection(plan, logs, existing.logs)}${pushServiceAccountId === undefined ? "" : pushIdentitySection(plan, pushServiceAccountId)}${security === null ? "" : securitySection(plan, security)}${reader === null ? "" : readerSection(plan, reader, existing.reader)}`
}
