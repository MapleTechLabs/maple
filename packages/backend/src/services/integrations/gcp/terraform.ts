import type { GcpSetupPlan } from "./setup-plan"

const DOCS_URL = "https://maple.dev/docs/integrations/gcp"

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
	values.length === 1
		? `[${values.map(hcl).join("")}]`
		: `[\n${values.map((value) => `    ${hcl(value)},\n`).join("")}  ]`

// `terraform fmt` aligns the equals signs of consecutive attributes.
const attributes = (pairs: ReadonlyArray<readonly [string, string]>, indent = "  ") => {
	const width = Math.max(...pairs.map(([name]) => name.length))
	return pairs.map(([name, value]) => `${indent}${name.padEnd(width)} = ${value}\n`).join("")
}

// How each scope's sink and read-only grants are addressed.
const SCOPES = {
	project: {
		sink: "google_logging_project_sink",
		sinkScope: "project",
		iam: "google_project_iam_member",
		iamScope: "project",
	},
	folder: {
		sink: "google_logging_folder_sink",
		sinkScope: "folder",
		iam: "google_folder_iam_member",
		iamScope: "folder",
	},
	organization: {
		sink: "google_logging_organization_sink",
		sinkScope: "org_id",
		iam: "google_organization_iam_member",
		iamScope: "org_id",
	},
} as const

const scopeLocal = {
	project: "local.project_id",
	folder: "local.folder_id",
	organization: "local.organization_id",
}

const logsSection = (plan: GcpSetupPlan, logs: NonNullable<GcpSetupPlan["logs"]>) => {
	const scope = SCOPES[plan.scopeType]
	return `
# ---- Log forwarding ----
# A Log Router sink on the ${plan.scopeType} routes entries into a Pub/Sub topic in the host project,
# whose push subscription delivers each LogEntry to Maple, signed as the push service account.

resource "google_pubsub_topic" "maple" {
  project = local.project_id
  name    = ${hcl(logs.topic)}

  depends_on = [google_project_service.maple]
}

# What Pub/Sub signs its pushes as. It holds no role anywhere: a token for it proves only that a
# push came from this subscription.
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

# Pub/Sub's service agent mints the push tokens. Newer projects allow it by default, older ones
# need this grant. After the topic: Google creates the agent on first use.
resource "google_service_account_iam_member" "maple_push_token_creator" {
  service_account_id = google_service_account.maple_push.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:service-\${data.google_project.host.number}@gcp-sa-pubsub.iam.gserviceaccount.com"

  depends_on = [google_pubsub_topic.maple]
}

# One LogEntry per request, unwrapped. A day of retention bounds what is replayed after an outage,
# and the subscription never expires while it is idle.
resource "google_pubsub_subscription" "maple" {
  project                    = local.project_id
  name                       = ${hcl(logs.subscription)}
  topic                      = google_pubsub_topic.maple.id
  ack_deadline_seconds       = ${logs.ackDeadlineSeconds}
  message_retention_duration = "${logs.messageRetentionSeconds}s"

  expiration_policy {
    ttl = ""
  }

  retry_policy {
    minimum_backoff = "${logs.minRetryDelaySeconds}s"
    maximum_backoff = "${logs.maxRetryDelaySeconds}s"
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

# Google keeps routing for a while after a sink is deleted. With the topic gone by then it logs an
# error in the host project and may notify its contacts, so the topic outlives the sink a minute.
resource "time_sleep" "maple_sink_drain" {
  destroy_duration = "60s"

  depends_on = [google_pubsub_topic.maple]
}

resource "${scope.sink}" "maple" {
${attributes([
	[scope.sinkScope, scopeLocal[plan.scopeType]],
	["name", hcl(logs.sink)],
	["destination", `"pubsub.googleapis.com/\${google_pubsub_topic.maple.id}"`],
	["filter", "local.log_filter"],
	plan.scopeType === "project" ? ["unique_writer_identity", "true"] : ["include_children", "true"],
])}
  depends_on = [time_sleep.maple_sink_drain]
}

# The sink writes as a Google-managed identity: Logs Writer on the project that holds the
# destination, and Pub/Sub Publisher on this one topic.
resource "google_project_iam_member" "maple_sink_log_writer" {
  project = local.project_id
  role    = "roles/logging.logWriter"
  member  = ${scope.sink}.maple.writer_identity
}

resource "google_pubsub_topic_iam_member" "maple_sink_publisher" {
  project = local.project_id
  topic   = google_pubsub_topic.maple.name
  role    = "roles/pubsub.publisher"
  member  = ${scope.sink}.maple.writer_identity
}
`
}

const readerSection = (plan: GcpSetupPlan, reader: NonNullable<GcpSetupPlan["reader"]>) => {
	const scope = SCOPES[plan.scopeType]
	return `
# ---- Metrics and resources ----
# A read-only service account Maple reads metrics and resources as, through short-lived tokens its
# own account may mint for this one account. No key is created.

resource "google_service_account" "maple_reader" {
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

# On the ${plan.scopeType}${plan.scopeType === "project" ? "" : ", inherited by every project under it"}. The narrowest predefined roles for Maple's two
# calls, monitoring.timeSeries.list and cloudasset.assets.searchAllResources. Both are read-only,
# and broader than the calls: Cloud Asset Viewer can also read resource metadata and IAM policies.
resource "${scope.iam}" "maple_reader" {
  for_each = toset(${hclList(reader.scopeRoles)})

${attributes([
	[
		scope.iamScope,
		plan.scopeType === "folder" ? `"folders/\${local.folder_id}"` : scopeLocal[plan.scopeType],
	],
	["role", "each.value"],
	["member", `"serviceAccount:\${google_service_account.maple_reader.email}"`],
])}}

# Maple's reads name the host project as the one their quota is counted against.
resource "google_project_iam_member" "maple_reader_quota" {
  for_each = toset(${hclList(reader.projectRoles)})

  project = local.project_id
  role    = each.value
  member  = "serviceAccount:\${google_service_account.maple_reader.email}"
}
`
}

/**
 * A self-contained Terraform file for the connection: every resource inline, so it can be read in
 * full before it is applied. It holds no secret, so it can be committed.
 */
export const renderGcpTerraform = (plan: GcpSetupPlan): string => {
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
# It holds no secret${logs === null ? "." : ": Pub/Sub signs each push as the push service account, and Maple accepts only\n# that account's tokens."} Resource names follow the connection, so a second connection goes
# in a module of its own. Details: ${DOCS_URL}

terraform {
  # Drop this block where your configuration declares these providers already.
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.0"
    }${
		logs === null
			? ""
			: `
    time = {
      source  = "hashicorp/time"
      version = ">= 0.9"
    }`
	}
  }
}

locals {
  # The host project holds Maple's Pub/Sub topic, subscription and service accounts.
${attributes(locals)}}

# APIs in the host project. They stay on when this is destroyed.
resource "google_project_service" "maple" {
  for_each = toset(${hclList(plan.apis)})

  project            = local.project_id
  service            = each.value
  disable_on_destroy = false
}
${logs === null ? "" : logsSection(plan, logs)}${reader === null ? "" : readerSection(plan, reader)}`
}
