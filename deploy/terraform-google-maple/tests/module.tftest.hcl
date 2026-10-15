# Plans against mocked providers: no Google credentials, nothing created. Run with
# `terraform test` (1.7+) or `tofu test`.

mock_provider "google" {
  mock_data "google_project" {
    defaults = {
      number = "123456789012"
    }
  }

  mock_resource "google_service_account" {
    defaults = {
      email = "maple-push-0a1b2c3d4e5f4071829@acme-host.iam.gserviceaccount.com"
      name  = "projects/acme-host/serviceAccounts/maple-push-0a1b2c3d4e5f4071829@acme-host.iam.gserviceaccount.com"
    }
  }

  mock_resource "google_pubsub_topic" {
    defaults = {
      id = "projects/acme-host/topics/maple-0a1b2c3d4e5f40718293a4b5"
    }
  }

  mock_resource "google_logging_project_sink" {
    defaults = {
      writer_identity = "serviceAccount:service-123456789012@gcp-sa-logging.iam.gserviceaccount.com"
    }
  }

  mock_resource "google_logging_folder_sink" {
    defaults = {
      writer_identity = "serviceAccount:service-folder-222222222222@gcp-sa-logging.iam.gserviceaccount.com"
    }
  }

  mock_resource "google_logging_organization_sink" {
    defaults = {
      writer_identity = "serviceAccount:service-org-111111111111@gcp-sa-logging.iam.gserviceaccount.com"
    }
  }
}

mock_provider "time" {}

variables {
  connector_id          = "0a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9"
  scope_type            = "project"
  scope_id              = "acme-prod"
  project_id            = "acme-prod"
  push_endpoint         = "https://ingest.maple.dev/v1/logpush/gcp/0a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9"
  maple_service_account = "maple@maple-prd.iam.gserviceaccount.com"
  log_filter            = "NOT log_id(\"cloudaudit.googleapis.com/data_access\")"
}

run "project_scope_names_resources_like_the_setup_script" {
  command = plan

  assert {
    condition     = google_pubsub_topic.logs[0].name == "maple-0a1b2c3d4e5f40718293a4b5"
    error_message = "topic name differs from the setup script's"
  }

  assert {
    condition     = google_service_account.push[0].account_id == "maple-push-0a1b2c3d4e5f4071829"
    error_message = "push account id differs from the setup script's"
  }

  assert {
    condition     = google_service_account.reader[0].account_id == "maple-0a1b2c3d4e5f40718293a4b5"
    error_message = "reader account id differs from the setup script's"
  }

  assert {
    condition     = length(google_logging_project_sink.logs) == 1 && length(google_logging_folder_sink.logs) == 0 && length(google_logging_organization_sink.logs) == 0
    error_message = "a project scope gets exactly one project sink"
  }

  assert {
    condition     = google_logging_project_sink.logs[0].filter == var.log_filter
    error_message = "the sink filter is not the given one"
  }

  assert {
    condition     = google_pubsub_subscription.logs[0].push_config[0].oidc_token[0].audience == var.push_endpoint
    error_message = "pushes are not signed for the connection's endpoint"
  }

  assert {
    condition     = google_service_account_iam_member.push_token_creator[0].member == "serviceAccount:service-123456789012@gcp-sa-pubsub.iam.gserviceaccount.com"
    error_message = "the Pub/Sub service agent may not sign as the push account"
  }

  assert {
    condition     = toset(keys(google_project_iam_member.reader_scope)) == toset(["roles/monitoring.viewer", "roles/cloudasset.viewer"])
    error_message = "the reader lacks its read-only roles on the project"
  }
}

run "organization_scope_routes_children_and_grants_on_the_organization" {
  command = plan

  variables {
    scope_type = "organization"
    scope_id   = "111111111111"
    project_id = "acme-host"
  }

  assert {
    condition     = length(google_logging_organization_sink.logs) == 1 && google_logging_organization_sink.logs[0].include_children
    error_message = "an organization scope routes its children's logs"
  }

  assert {
    condition     = length(google_project_iam_member.reader_scope) == 0 && length(google_organization_iam_member.reader_scope) == 2
    error_message = "read-only roles belong on the organization"
  }

  assert {
    condition     = google_project_iam_member.reader_quota[0].project == "acme-host"
    error_message = "quota is counted against the host project"
  }
}

run "logs_off_and_no_maple_account_create_nothing" {
  command = plan

  variables {
    logs_enabled          = false
    maple_service_account = null
  }

  assert {
    condition     = length(google_pubsub_topic.logs) == 0 && length(google_service_account.push) == 0 && length(google_logging_project_sink.logs) == 0
    error_message = "log forwarding resources exist while it is off"
  }

  assert {
    condition     = length(google_service_account.reader) == 0 && length(google_project_iam_member.reader_scope) == 0
    error_message = "read-only access exists without Maple's account"
  }
}

run "rejects_a_push_endpoint_with_a_secret" {
  command = plan

  variables {
    push_endpoint = "https://ingest.maple.dev/v1/logpush/gcp/0a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9?secret=x"
  }

  expect_failures = [var.push_endpoint]
}
