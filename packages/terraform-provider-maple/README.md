# Terraform provider for Maple

Manage Maple dashboards, alert rules, alert destinations, uptime monitors, scrape targets and API keys
as Terraform resources, through the public [v2 API](https://api.maple.dev/v2/docs).

User docs: [maple.dev/docs/iac/terraform](https://maple.dev/docs/iac/terraform). Registry docs are
generated into [`docs/`](docs) from the schema descriptions and [`examples/`](examples).

| Resource                   | API                       |
| -------------------------- | ------------------------- |
| `maple_dashboard`          | `/v2/dashboards`          |
| `maple_alert_destination`  | `/v2/alerts/destinations` |
| `maple_alert_rule`         | `/v2/alerts/rules`        |
| `maple_uptime_monitor`     | `/v2/uptime_monitors`     |
| `maple_scrape_target`      | `/v2/scrape_targets`      |
| `maple_api_key`            | `/v2/api_keys`            |
| `maple_ingest_keys` (data) | `/v2/ingest_keys`         |

## How it works

Every resource is one `resourceDef` in [`internal/provider/resources.go`](internal/provider/resources.go):
a schema, its v2 collection path and a few per-attribute flags. [`generic_resource.go`](internal/provider/generic_resource.go)
does the CRUD for all of them: attribute names are the API's snake_case wire names, so the plan is sent
as the request body and the response is read back into state.

- **JSON documents** (dashboard widgets, uptime `config`, alert `thresholds`) are strings written with
  `jsonencode`. State keeps the user's string while the API's object still contains everything it says,
  so defaults the API adds (an HTTP monitor's `method`) are not drift. Imports read the API's canonical
  form, which is byte-identical to `jsonencode` output.
- **Write-only values** (destination credentials, scrape `auth_credentials`) are never returned by the
  API, so state keeps the configured value and outside changes to them cannot be detected.
- **Removing an optional attribute** clears it: the update sends `null` (or `[]` for lists).
- **`maple_api_key.rotate`** is a keeper. Changing it calls `POST /v2/api_keys/{id}/roll`, which revokes the
  key and returns a replacement with a new ID and secret.

## Develop

```bash
go test ./...                    # real terraform plan/apply/import against an in-process fake API
go generate ./...                # regenerate docs/ after changing a schema or an example
go build -o ~/.terraform.d/plugins/terraform-provider-maple .
```

To run a configuration against a local build, point a CLI config at the binary's directory:

```hcl
# ~/.terraformrc
provider_installation {
  dev_overrides { "mapletechlabs/maple" = "/Users/you/.terraform.d/plugins" }
  direct {}
}
```

then `MAPLE_API_URL=https://api.localhost MAPLE_API_KEY=maple_ak_… terraform plan`.

## Releasing

The Terraform Registry only publishes from a GitHub repository named `terraform-provider-<name>`
with signed release assets. Releases therefore come from `MapleTechLabs/terraform-provider-maple`,
which mirrors this directory: copy it over, tag `vX.Y.Z`, and run goreleaser with the GPG key
whose public half is registered on the Registry namespace:

```bash
GPG_FINGERPRINT=… goreleaser release --clean
```
