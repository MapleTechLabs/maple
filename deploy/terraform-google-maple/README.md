# Maple Google Cloud connection

Terraform (1.5+) and OpenTofu module that connects a Google Cloud project, folder or organization to [Maple](https://maple.dev). It creates the same resources as Maple's Cloud Shell setup script, under the same names, so either can take over from the other.

Create the connection in Maple first (**Integrations → Google Cloud**). Its **Apply in Google Cloud** stage, under **Terraform**, gives the module block with every input filled in. Setup guide: https://maple.dev/docs/integrations/gcp#set-up-with-terraform

```hcl
module "maple_gcp_acme_prod" {
  source = "github.com/MapleTechLabs/maple//deploy/terraform-google-maple?ref=terraform-google-maple-v1.0.0"

  connector_id          = "0a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9"
  scope_type            = "project"
  scope_id              = "acme-prod"
  project_id            = "acme-prod"
  push_endpoint         = "https://ingest.maple.dev/v1/logpush/gcp/0a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9"
  maple_service_account = "…"
  logs_enabled          = true
  log_filter            = "…"
}
```

## What it creates

In the host project (`project_id`):

| Resource | Name | Purpose |
| --- | --- | --- |
| Pub/Sub topic | `maple-<24 hex>` | Carries the log entries the sink routes. |
| Pub/Sub push subscription | `maple-<24 hex>` | Delivers each entry to `push_endpoint`, unwrapped, retained a day. |
| Service account | `maple-push-<19 hex>` | What Pub/Sub signs each push as. Holds no role. |
| Service account | `maple-<24 hex>` | Read-only account Maple reads metrics and resources as, through short-lived tokens. No key is created. |

On the scope: a Log Router sink `maple-<24 hex>` (with `include_children` on a folder or organization).

Role grants, all additive (`*_iam_member`, never a policy replace):

| Role | To | On |
| --- | --- | --- |
| `roles/pubsub.publisher` | The sink's writer identity | The topic |
| `roles/logging.logWriter` | The sink's writer identity | The host project |
| `roles/iam.serviceAccountTokenCreator` | The host project's Pub/Sub service agent | The push service account |
| `roles/monitoring.viewer`, `roles/cloudasset.viewer` | The read-only account | The scope |
| `roles/serviceusage.serviceUsageConsumer` | The read-only account | The host project |
| `roles/iam.serviceAccountTokenCreator` | `maple_service_account` | The read-only account |

With `enable_apis` (default), it switches on the APIs these need in the host project and never switches them off.

## No secret

`push_endpoint` carries no secret. Pub/Sub signs every push with a Google ID token for the push service account, and Maple accepts a push only when Google signed it for that account in this host project and for this connection's endpoint. Nothing in the configuration or the state is private.

## Inputs

| Name | Description | Default |
| --- | --- | --- |
| `connector_id` | The connection's ID in Maple. Every name derives from it. | |
| `scope_type` | `project`, `folder` or `organization`. | |
| `scope_id` | The project ID, or the numeric folder or organization ID. | |
| `project_id` | The host project. For a project scope, the project itself. | |
| `push_endpoint` | Maple's receiver for this connection. | |
| `maple_service_account` | Maple's service account. `null` leaves read-only access out. | `null` |
| `logs_enabled` | Forward logs. `false` removes the sink, topic, subscription and push account. | `true` |
| `log_filter` | The sink's inclusion filter. | |
| `enable_apis` | Switch on the APIs the resources need. | `true` |

## Outputs

`push_service_account_email`, `reader_service_account_email`, `sink_writer_identity`.

## Tests

`terraform test` (or `tofu test`) plans every scope against mocked providers: no credentials needed.
