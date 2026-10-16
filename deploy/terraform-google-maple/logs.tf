# Log forwarding: a Log Router sink on the scope routes entries into a Pub/Sub topic in the host
# project, whose push subscription delivers each LogEntry to Maple, signed as the push account.

resource "google_pubsub_topic" "logs" {
  count = var.logs_enabled ? 1 : 0

  project = var.project_id
  name    = local.name

  depends_on = [google_project_service.this]
}

# What Pub/Sub signs its pushes as. It holds no role anywhere: an ID token for it proves only
# that a push came from this subscription.
resource "google_service_account" "push" {
  count = var.logs_enabled ? 1 : 0

  project      = var.project_id
  account_id   = local.push_name
  display_name = "Maple log push identity"
  description  = "Signs Pub/Sub push requests to Maple. Holds no roles."

  depends_on = [google_project_service.this]
}

# Pub/Sub's service agent mints the push tokens. Projects created after April 2021 allow it by
# default; older ones need this grant. After the topic: Google creates the agent on first use.
resource "google_service_account_iam_member" "push_token_creator" {
  count = var.logs_enabled ? 1 : 0

  service_account_id = google_service_account.push[0].name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:service-${data.google_project.host.number}@gcp-sa-pubsub.iam.gserviceaccount.com"

  depends_on = [google_pubsub_topic.logs]
}

# One LogEntry per request, unwrapped. A day of retention bounds what is replayed after an outage,
# and the subscription never expires while it is idle.
resource "google_pubsub_subscription" "logs" {
  count = var.logs_enabled ? 1 : 0

  project                    = var.project_id
  name                       = local.name
  topic                      = google_pubsub_topic.logs[0].id
  ack_deadline_seconds       = 30
  message_retention_duration = "86400s"

  expiration_policy {
    ttl = ""
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  push_config {
    push_endpoint = var.push_endpoint

    no_wrapper {
      write_metadata = false
    }

    oidc_token {
      service_account_email = google_service_account.push[0].email
      audience              = var.push_endpoint
    }
  }

  depends_on = [google_service_account_iam_member.push_token_creator]
}

# Google keeps routing for a while after a sink is deleted. With the topic gone by then it logs an
# error in the host project and may notify its contacts, so the topic outlives the sink a minute.
resource "time_sleep" "sink_drain" {
  count = var.logs_enabled ? 1 : 0

  destroy_duration = "60s"

  depends_on = [google_pubsub_topic.logs]
}

locals {
  destination = var.logs_enabled ? "pubsub.googleapis.com/${google_pubsub_topic.logs[0].id}" : null
}

resource "google_logging_project_sink" "logs" {
  count = var.logs_enabled && var.scope_type == "project" ? 1 : 0

  project                = var.scope_id
  name                   = local.name
  destination            = local.destination
  filter                 = var.log_filter
  unique_writer_identity = true

  depends_on = [time_sleep.sink_drain]
}

# A folder or organization sink also routes the logs of every project underneath.
resource "google_logging_folder_sink" "logs" {
  count = var.logs_enabled && var.scope_type == "folder" ? 1 : 0

  folder           = var.scope_id
  name             = local.name
  destination      = local.destination
  filter           = var.log_filter
  include_children = true

  depends_on = [time_sleep.sink_drain]
}

resource "google_logging_organization_sink" "logs" {
  count = var.logs_enabled && var.scope_type == "organization" ? 1 : 0

  org_id           = var.scope_id
  name             = local.name
  destination      = local.destination
  filter           = var.log_filter
  include_children = true

  depends_on = [time_sleep.sink_drain]
}

locals {
  writer_identity = one(concat(
    google_logging_project_sink.logs[*].writer_identity,
    google_logging_folder_sink.logs[*].writer_identity,
    google_logging_organization_sink.logs[*].writer_identity,
  ))
}

# The sink writes as a Google-managed identity: Logs Writer on the project that holds the
# destination, and Pub/Sub Publisher on this one topic.
resource "google_project_iam_member" "sink_log_writer" {
  count = var.logs_enabled ? 1 : 0

  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = local.writer_identity
}

resource "google_pubsub_topic_iam_member" "sink_publisher" {
  count = var.logs_enabled ? 1 : 0

  project = var.project_id
  topic   = google_pubsub_topic.logs[0].name
  role    = "roles/pubsub.publisher"
  member  = local.writer_identity
}
