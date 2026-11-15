---
title: "Pulumi"
description: "Manage Maple dashboards, alert rules, notification destinations, uptime monitors, scrape targets and API keys from Pulumi programs in TypeScript or Go."
group: "Infrastructure as Code"
order: 5
icon: "pulumi"
navLabel: "Pulumi"
---

The Maple provider for [Pulumi](https://www.pulumi.com) manages Maple configuration from a Pulumi program: dashboards, alert rules and their destinations, uptime monitors, scrape targets and API keys. It is the [Terraform provider](/docs/iac/terraform) packaged for Pulumi, so it has the same resources, the same validation and talks to the same public [v2 API](/docs/reference/api).

|            |                                                                                 |
| ---------- | ------------------------------------------------------------------------------- |
| TypeScript | [`@maple-dev/pulumi`](https://www.npmjs.com/package/@maple-dev/pulumi)          |
| Go         | `github.com/MapleTechLabs/pulumi-maple/sdk/go/maple`, 0.2.0 or later            |
| Pulumi     | 3.0 or later                                                                    |
| Source     | [MapleTechLabs/pulumi-maple](https://github.com/MapleTechLabs/pulumi-maple)     |
| Fields     | [Terraform resources](/docs/iac/terraform-resources), with names in `camelCase` |

## Quick start

### 1. Create an API key

In Maple, open **Settings → Keys** and create an API key. Alert rules, alert destinations, API keys and ingest keys can only be changed with a key created by an org admin. A key with scopes needs the matching `:write` scope for every resource type it manages, for example `dashboards:write` and `alerts:write`.

### 2. Install the package

```bash
npm install @maple-dev/pulumi
```

Pulumi downloads the provider plugin the first time you run `pulumi preview` or `pulumi up`. For Go, run `go get github.com/MapleTechLabs/pulumi-maple/sdk@latest`.

### 3. Configure the provider

Store the key as a secret in your stack:

```bash
pulumi config set maple:apiKey --secret
```

| Setting        | Environment variable | Default                 |
| -------------- | -------------------- | ----------------------- |
| `maple:apiKey` | `MAPLE_API_KEY`      | Required                |
| `maple:apiUrl` | `MAPLE_API_URL`      | `https://api.maple.dev` |

An organization in the [EU region](/docs/reference/regions) sets `pulumi config set maple:apiUrl https://api.eu.maple.dev`.

### 4. Declare an alert

```typescript
import * as pulumi from "@pulumi/pulumi"
import * as maple from "@maple-dev/pulumi"

const config = new pulumi.Config()

const oncall = new maple.AlertDestination("oncall", {
	type: "pagerduty",
	name: "Primary on-call",
	integrationKey: config.requireSecret("pagerdutyIntegrationKey"),
})

new maple.AlertRule("checkout-errors", {
	name: "Checkout error rate",
	signalType: "error_rate",
	comparator: "gt",
	severity: "critical",
	threshold: 0.05,
	windowMinutes: 5,
	serviceNames: ["checkout"],
	destinationIds: [oncall.id],
})
```

The same program in Go:

```go
package main

import (
	"github.com/MapleTechLabs/pulumi-maple/sdk/go/maple"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi/config"
)

func main() {
	pulumi.Run(func(ctx *pulumi.Context) error {
		cfg := config.New(ctx, "")
		oncall, err := maple.NewAlertDestination(ctx, "oncall", &maple.AlertDestinationArgs{
			Type:           pulumi.String("pagerduty"),
			Name:           pulumi.String("Primary on-call"),
			IntegrationKey: cfg.RequireSecret("pagerdutyIntegrationKey"),
		})
		if err != nil {
			return err
		}
		_, err = maple.NewAlertRule(ctx, "checkout-errors", &maple.AlertRuleArgs{
			Name:           pulumi.String("Checkout error rate"),
			SignalType:     pulumi.String("error_rate"),
			Comparator:     pulumi.String("gt"),
			Severity:       pulumi.String("critical"),
			Threshold:      pulumi.Float64(0.05),
			WindowMinutes:  pulumi.Int(5),
			ServiceNames:   pulumi.StringArray{pulumi.String("checkout")},
			DestinationIds: pulumi.StringArray{oncall.ID()},
		})
		return err
	})
}
```

### 5. Deploy

```bash
pulumi config set --secret pagerdutyIntegrationKey <key>
pulumi up
```

The rule shows up under **Alerts** in Maple. Change it in the program and run `pulumi up` again: Pulumi updates it in place.

## Resources

| Resource                 | Terraform equivalent                                                               |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `maple.Dashboard`        | [`maple_dashboard`](/docs/iac/terraform-resources#maple_dashboard)                 |
| `maple.AlertDestination` | [`maple_alert_destination`](/docs/iac/terraform-resources#maple_alert_destination) |
| `maple.AlertRule`        | [`maple_alert_rule`](/docs/iac/terraform-resources#maple_alert_rule)               |
| `maple.UptimeMonitor`    | [`maple_uptime_monitor`](/docs/iac/terraform-resources#maple_uptime_monitor)       |
| `maple.ScrapeTarget`     | [`maple_scrape_target`](/docs/iac/terraform-resources#maple_scrape_target)         |
| `maple.ApiKey`           | [`maple_api_key`](/docs/iac/terraform-resources#maple_api_key)                     |
| `maple.getIngestKeys`    | [`maple_ingest_keys`](/docs/iac/terraform-resources#maple_ingest_keys) (function)  |

Every field is the Terraform attribute in `camelCase`: `signal_type` is `signalType`, `destination_ids` is `destinationIds`. The [Terraform resource reference](/docs/iac/terraform-resources) lists each one, which are required and which take Maple's default when left out. Your editor shows the same through the SDK's types.

## Bring existing configuration under Pulumi

Every resource can be imported by its ID, which Maple shows in the URL and the API returns as `id`:

```bash
pulumi import maple:index/dashboard:Dashboard checkout dash_2xH8d...
```

Pulumi prints the matching code, including the dashboard's widgets, for you to paste into your program. The next `pulumi preview` shows no changes when the code matches what is in Maple. Imported resources are protected from deletion until you pass `--protect=false` to the import or remove `protect: true` from the code.

## Dashboards, monitors and thresholds are JSON

Dashboard `widgets`, `sections`, `variables` and `timeRange`, an uptime monitor's `config`, and an alert rule's `thresholds`, `queryBuilderDraft` and `notificationTemplate` are JSON strings in the API's wire shape, so the keys inside stay `snake_case`. Write them with `JSON.stringify`:

```typescript
new maple.UptimeMonitor("api", {
	name: "Public API",
	config: JSON.stringify({
		type: "http",
		url: "https://api.example.com/health",
		assertions: [{ type: "status", op: "is", value: "2xx" }],
	}),
})
```

A value Maple fills in that you did not write, such as an HTTP monitor's `method: "GET"`, is not a change. A value you wrote that is different in Maple is, and the next `pulumi up` puts yours back.

The quickest way to get a dashboard's widget documents is to build it in Maple and import it.

## Secrets

`maple:apiKey`, an API key's `secret` and every notification or scrape credential are Pulumi secrets: encrypted in state and masked in output. Credentials are write-only in the API, so Pulumi sends the value from your program on every update but cannot see a credential someone changes in Maple.

`getIngestKeys` returns plain values, because Pulumi strips secret markers from function results. Wrap a key with `pulumi.secret` before you export it or pass it on:

```typescript
const keys = maple.getIngestKeysOutput({})

export const ingestKey = pulumi.secret(keys.privateKey)
```

Reading ingest keys needs a key created by an org admin.

## Rotate API keys

Set `rotate` on an API key to any value and change it to roll the key. Pulumi creates a replacement with the same name and scopes first, then revokes the old key, so anything that reads the key's `secret` picks up the new one in the same `pulumi up`:

```typescript
const grafana = new maple.ApiKey("grafana", {
	name: "grafana-readonly",
	scopes: ["dashboards:read", "traces:read", "metrics:read"],
	rotate: "2026-q4",
})

export const grafanaKey = grafana.secret
```

This is the one difference from Terraform, which rolls the key in place: Pulumi cannot change a resource's ID during an update, so a rotation is a replacement. Changing any other field of a key, such as its scopes, replaces it too.

## Removing things

`pulumi destroy`, or deleting a resource from the program, deletes the dashboard, rule, destination, monitor or scrape target in Maple and revokes an API key. Removing an optional field clears it in Maple, except for the fields marked **default** in the [resource reference](/docs/iac/terraform-resources), which keep their last value.
