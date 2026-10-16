locals {
  hex = replace(var.connector_id, "-", "")

  # The same names Maple's setup script uses, so either can take over from the other.
  name      = "maple-${substr(local.hex, 0, 24)}"
  push_name = "maple-push-${substr(local.hex, 0, 19)}"

  reader = var.maple_service_account != null

  # Pub/Sub carries the log entries, Cloud Logging routes them, IAM holds the push identity.
  # Cloud Monitoring and Cloud Asset answer Maple's reads, IAM Credentials mints its short-lived
  # tokens: no key is ever created. Cloud Resource Manager is what IAM grants go through.
  apis = toset(concat(
    ["cloudresourcemanager.googleapis.com", "iam.googleapis.com"],
    var.logs_enabled ? ["pubsub.googleapis.com", "logging.googleapis.com"] : [],
    local.reader ? ["monitoring.googleapis.com", "cloudasset.googleapis.com", "iamcredentials.googleapis.com"] : [],
  ))
}

resource "google_project_service" "this" {
  for_each = var.enable_apis ? local.apis : toset([])

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

data "google_project" "host" {
  project_id = var.project_id
}
