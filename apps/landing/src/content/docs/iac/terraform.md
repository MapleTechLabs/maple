---
title: "Terraform"
description: "Declare Maple dashboards, alert rules, notification destinations, uptime monitors, scrape targets and API keys in Terraform, next to the infrastructure they watch."
group: "Infrastructure as Code"
order: 3
icon: "terraform"
navLabel: "Terraform"
---

The Maple provider for [Terraform](https://developer.hashicorp.com/terraform) manages Maple configuration as code: dashboards, alert rules and their destinations, uptime monitors, scrape targets and API keys. It talks to the public [v2 API](/docs/reference/api), so anything you can do there with a key you can review in a plan first.

|                    |                                                                                                                         |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Provider           | `mapletechlabs/maple`                                                                                                   |
| Terraform          | 1.0 or later; `import` blocks need 1.5                                                                                  |
| Source             | [packages/terraform-provider-maple](https://github.com/MapleTechLabs/maple/tree/main/packages/terraform-provider-maple) |
| Resource reference | [Terraform resources](/docs/iac/terraform-resources)                                                                    |

## Quick start

### 1. Create an API key

In Maple, open **Settings → Keys** and create an API key. Alert rules, alert destinations, API keys and ingest keys can only be changed with a key created by an org admin. A key with scopes needs the matching `:write` scope for every resource type it manages, for example `dashboards:write` and `alerts:write`.

Export it where you run Terraform:

```bash
export MAPLE_API_KEY=maple_ak_...
```

### 2. Configure the provider

```hcl
terraform {
  required_providers {
    maple = {
      source  = "mapletechlabs/maple"
      version = "~> 0.1"
    }
  }
}

provider "maple" {}
```

| Setting   | Environment variable | Default                 |
| --------- | -------------------- | ----------------------- |
| `api_key` | `MAPLE_API_KEY`      | Required                |
| `api_url` | `MAPLE_API_URL`      | `https://api.maple.dev` |

An organization in the [EU region](/docs/reference/regions) sets `api_url = "https://api.eu.maple.dev"`.

### 3. Declare an alert

```hcl
resource "maple_alert_destination" "oncall" {
  type            = "pagerduty"
  name            = "Primary on-call"
  integration_key = var.pagerduty_integration_key
}

resource "maple_alert_rule" "checkout_errors" {
  name            = "Checkout error rate"
  signal_type     = "error_rate"
  comparator      = "gt"
  severity        = "critical"
  threshold       = 0.05
  window_minutes  = 5
  service_names   = ["checkout"]
  destination_ids = [maple_alert_destination.oncall.id]
}
```

### 4. Apply

```bash
terraform init
terraform plan
terraform apply
```

The rule shows up under **Alerts** in Maple. Change it in the file and apply again: Terraform updates it in place.

## Bring existing configuration under Terraform

Every resource can be imported by its ID, which Maple shows in the URL and the API returns as `id`:

```hcl
import {
  to = maple_dashboard.checkout
  id = "dash_2xH8d..."
}
```

Run `terraform plan -generate-config-out=generated.tf` to have Terraform write the matching configuration, including the dashboard's widgets, then move it into your own files. The plan after an import is empty when the configuration matches what is in Maple.

## Dashboards, monitors and thresholds are JSON

Dashboard `widgets`, `sections`, `variables` and `time_range`, an uptime monitor's `config`, and an alert rule's `thresholds`, `query_builder_draft` and `notification_template` are documents in the API's wire shape. Write them with `jsonencode`:

```hcl
resource "maple_uptime_monitor" "api" {
  name = "Public API"
  config = jsonencode({
    type       = "http"
    url        = "https://api.example.com/health"
    assertions = [{ type = "status", op = "is", value = "2xx" }]
  })
}
```

A value Maple fills in that you did not write, such as an HTTP monitor's `method = "GET"`, is not a change. A value you wrote that is different in Maple is, and the next apply puts yours back.

The quickest way to get a dashboard's widget documents is to build it in Maple and import it.

## Secrets and state

Notification credentials (`integration_key`, `webhook_url`, `bot_token`, `signing_secret`) and a scrape target's `auth_credentials` are write-only in the API. Terraform keeps the value you set and sends it on every update, but it cannot see a credential someone changes in Maple.

`maple_api_key` stores the new key's `secret` in state, since Maple only returns it once. The `maple_ingest_keys` data source reads your ingest keys into state too. Keep state in an encrypted backend.

## Rotate API keys

Set `rotate` on an API key to any value and change it to roll the key. Maple revokes the old key and issues a replacement with the same name and scopes, a new ID and a new secret, so anything that reads `maple_api_key.<name>.secret` picks up the new one on the same apply:

```hcl
resource "time_rotating" "quarterly" {
  rotation_days = 90
}

resource "maple_api_key" "grafana" {
  name   = "grafana-readonly"
  scopes = ["dashboards:read", "traces:read", "metrics:read"]
  rotate = time_rotating.quarterly.id
}
```

Changing any other attribute of a key, such as its scopes, revokes it and creates a new key.

## Wire telemetry with the ingest key

`maple_ingest_keys` reads your organization's ingest keys, so a stack can hand the private key to its services without copying it by hand:

```hcl
data "maple_ingest_keys" "this" {}

resource "kubernetes_secret" "otel" {
  metadata { name = "maple-ingest" }
  data = { MAPLE_INGEST_KEY = data.maple_ingest_keys.this.private_key }
}
```

Reading ingest keys needs a key created by an org admin.

## Removing things

`terraform destroy`, or deleting a resource from the configuration, deletes the dashboard, rule, destination, monitor or scrape target in Maple and revokes an API key. Removing an optional attribute from the configuration clears it in Maple, except for the attributes marked **default** in the [resource reference](/docs/iac/terraform-resources), which keep their last value.
