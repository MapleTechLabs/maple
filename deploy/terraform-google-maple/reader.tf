# Read-only access: a service account Maple reads metrics and resources as, through short-lived
# tokens its own account may mint for this one account. No key is created.

resource "google_service_account" "reader" {
  count = local.reader ? 1 : 0

  project      = var.project_id
  account_id   = local.name
  display_name = "Maple metrics and resource reader"

  depends_on = [google_project_service.this]
}

resource "google_service_account_iam_member" "maple_token_creator" {
  count = local.reader ? 1 : 0

  service_account_id = google_service_account.reader[0].name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${var.maple_service_account}"
}

# On the scope, inherited by every project under a folder or organization. The narrowest
# predefined roles for Maple's two calls: monitoring.timeSeries.list and
# cloudasset.assets.searchAllResources. Both are read-only, and broader than the calls: Cloud
# Asset Viewer can also read resource metadata and IAM policies.
locals {
  scope_roles = local.reader ? toset(["roles/monitoring.viewer", "roles/cloudasset.viewer"]) : toset([])
}

resource "google_project_iam_member" "reader_scope" {
  for_each = var.scope_type == "project" ? local.scope_roles : toset([])

  project = var.scope_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.reader[0].email}"
}

resource "google_folder_iam_member" "reader_scope" {
  for_each = var.scope_type == "folder" ? local.scope_roles : toset([])

  folder = "folders/${var.scope_id}"
  role   = each.value
  member = "serviceAccount:${google_service_account.reader[0].email}"
}

resource "google_organization_iam_member" "reader_scope" {
  for_each = var.scope_type == "organization" ? local.scope_roles : toset([])

  org_id = var.scope_id
  role   = each.value
  member = "serviceAccount:${google_service_account.reader[0].email}"
}

# Maple's reads name the host project as the one their quota is counted against.
resource "google_project_iam_member" "reader_quota" {
  count = local.reader ? 1 : 0

  project = var.project_id
  role    = "roles/serviceusage.serviceUsageConsumer"
  member  = "serviceAccount:${google_service_account.reader[0].email}"
}
