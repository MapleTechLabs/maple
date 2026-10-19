import {
	GCP_PUSH_SUBSCRIPTION,
	GCP_READER_PROJECT_ROLE,
	GCP_READER_SCOPE_ROLES,
	type GcpSetupPlan,
} from "@maple/domain/gcp"

/** An HCL string literal: `${` and `%{` would start a template, a newline would end the line. */
export const hcl = (value: string): string =>
	`"${value
		.replaceAll("\\", "\\\\")
		.replaceAll('"', '\\"')
		.replaceAll("\n", "\\n")
		// A function: in a replacement string, `$$` is itself an escape for one `$`.
		.replaceAll("${", () => "$${")
		.replaceAll("%{", "%%{")}"`

const hclList = (values: ReadonlyArray<string>) =>
	`[\n${values.map((value) => `    ${hcl(value)},\n`).join("")}  ]`

// `terraform fmt` aligns the equals signs of consecutive attributes.
const attributes = (pairs: ReadonlyArray<readonly [string, string]>) => {
	const width = Math.max(...pairs.map(([name]) => name.length))
	return pairs.map(([name, value]) => `  ${name.padEnd(width)} = ${value}\n`).join("")
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
	return `\n${block.map((line) => (commented ? `# ${line}` : line)).join("\n")}\n`
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

# What Pub/Sub signs its pushes as. It holds no role anywhere.
resource "google_service_account" "maple_push" {
  project      = local.project_id
  account_id   = ${hcl(logs.pushServiceAccountId)}
  display_name = "Maple log push identity"
  description  = "Signs Pub/Sub push requests to Maple. Holds no roles."

  depends_on = [google_project_service.maple]
}

data "google_project" "host" {
  project_id = local.project_id
}

# Pub/Sub's service agent mints the push tokens: needed in projects created before April 2021.
resource "google_service_account_iam_member" "maple_push_token_creator" {
  service_account_id = google_service_account.maple_push.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:service-\${data.google_project.host.number}@gcp-sa-pubsub.iam.gserviceaccount.com"

  depends_on = [google_pubsub_topic.maple]
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

const readerSection = (
	plan: GcpSetupPlan,
	reader: NonNullable<GcpSetupPlan["reader"]>,
	existing: boolean,
) => {
	const [, member, scopeArg, scopeValue] = SCOPES[plan.scopeType]
	return `
# ---- Metrics and resources ----
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
  display_name = "Maple metrics and resource reader"

  depends_on = [google_project_service.maple]
}

resource "google_service_account_iam_member" "maple_reader_token_creator" {
  service_account_id = google_service_account.maple_reader.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:\${local.maple_service_account}"
}

# The narrowest predefined roles for Maple's reads, on the ${plan.scopeType}. Cloud Asset Viewer can also read IAM policies.
resource "${member}" "maple_reader" {
  for_each = toset(${hclList(GCP_READER_SCOPE_ROLES)})

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
	const { logs, reader } = plan
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
	]
	return `# Maple connection for Google Cloud ${plan.scopeType} ${plan.scopeId}
#   Log forwarding:        ${logs === null ? "off" : "on"}
#   Metrics and resources: ${reader === null ? "off" : "on"}
# This configuration carries no secret${logs === null ? "." : `: Pub/Sub signs each push as ${logs.pushServiceAccountId},\n# and Maple checks the signature.`} Put it in a root module of its own: names follow the
# connection, and imports only work in a root module.
# Details: https://maple.dev/docs/integrations/gcp-infrastructure-as-code

terraform {
  required_version = ">= 1.5"

  # Drop this block where your configuration declares these providers already.
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.0, < 8.0"
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
${logs === null ? "" : logsSection(plan, logs, existing.logs)}${reader === null ? "" : readerSection(plan, reader, existing.reader)}`
}
