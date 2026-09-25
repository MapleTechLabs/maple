---
title: "Authentication"
description: "The credentials Maple accepts: public and private ingest keys for sending telemetry, API keys for the REST API and MCP server, OAuth for MCP clients, and which endpoint takes which."
group: "Reference"
order: 4
---

Maple uses two kinds of credential. **Ingest keys** send telemetry. **API keys** read and change your organization through the REST API and the MCP server. An ingest key cannot read anything, and an API key cannot send telemetry.

| Credential | Prefix | Where you get it | What it can do | Safe to ship in client code? |
| --- | --- | --- | --- | --- |
| Public ingest key | `maple_pk_` | **Settings → Ingestion** | Send telemetry | Yes |
| Private ingest key | `maple_sk_` | **Settings → Ingestion** | Send telemetry | No |
| API key | `maple_ak_` | **Settings → API Keys** | REST API and MCP server, limited by its scopes | No |
| MCP key | `maple_ak_` | **Settings → MCP** | MCP server only | No |
| OAuth token | | Issued to an MCP client when you sign in | MCP server only | No |

Every credential belongs to one organization in one [region](/docs/reference/regions). A credential from the US region is rejected by the EU region, and the other way round.

## Which endpoint accepts what

| Endpoint | Accepts |
| --- | --- |
| Ingest, `https://ingest.maple.dev/v1/*` | Public or private ingest key, as `Authorization: Bearer …` or `x-maple-ingest-key: …` |
| REST API, `https://api.maple.dev/v2/*` | API key, or a dashboard session token, as `Authorization: Bearer …` |
| MCP server, `https://api.maple.dev/mcp` | API key, MCP key or OAuth token, as `Authorization: Bearer …` |

Use the EU hosts (`ingest.eu.maple.dev`, `api.eu.maple.dev`) for an EU organization.

## Ingest keys

Each organization has exactly one public key and one private key. Both are shown under **Settings → Ingestion**, and both have the same permission: they can send traces, logs, metrics, product events and session replays to your organization. Neither can read data.

- Use the **public key** (`maple_pk_…`, labeled **Client**) in browsers, mobile apps and anything else you ship to end users. It will be visible to anyone who inspects your app, which is expected. The worst someone can do with it is send data to your organization.
- Use the **private key** (`maple_sk_…`, labeled **Server**) on servers, in the OpenTelemetry Collector and in CI. Keep it out of client bundles, so you can rotate the public key without touching your backend.

Send the key on every request, either as `Authorization: Bearer maple_pk_…` or as `x-maple-ingest-key: maple_pk_…`. The `Bearer` prefix is case-insensitive. The [Ingest API](/docs/reference/ingest#authentication) page has the details.

To rotate a key, click **Regenerate** next to it in **Settings → Ingestion**, or call `POST /v2/ingest_keys/public/roll` or `POST /v2/ingest_keys/private/roll`. The old key stops working immediately, so deploy the new one first where you can.

The literal key `MAPLE_TEST` is accepted and returns `200`, but the data is discarded. Use it in CI or example code.

## API keys

Create API keys under **Settings → API Keys**, or with `POST /v2/api_keys`. When you create one you choose:

| Field | Options |
| --- | --- |
| **Name** and **Description** | Free text, to tell keys apart |
| **Expiration** | Never, 7 days, 30 days, 90 days or 1 year |
| **Access** | **Full access**, or **Restricted** to a set of scopes |

The key is shown once, when it is created. Store it then; Maple keeps only a hash. You can revoke a key or roll it (issue a new secret and revoke the old one) from the same page or with `POST /v2/api_keys/{id}/roll`.

A restricted key carries scopes of the form `<family>:read` or `<family>:write`, where the family is the first path segment under `/v2` (`dashboards`, `alerts`, `traces`, …). `write` implies `read`. The full list of families is in the [API reference](/docs/reference/api#resources). A request outside a key's scopes fails with `403` and `code: "insufficient_scope"`.

`maple auth login` also creates an API key: a full-access key that expires after 90 days, described as "Created by maple auth login". See [Using the CLI with hosted Maple](/docs/reference/cli#using-the-cli-with-hosted-maple).

API requests are limited to 600 per 60 seconds per key. See [Limits](/docs/reference/limits).

## MCP keys and OAuth

An MCP client can authenticate in three ways:

- **An API key** from **Settings → API Keys**, sent as `Authorization: Bearer maple_ak_…`.
- **An MCP key** from **Settings → MCP**. It has full access to the MCP tools and is rejected by the REST API.
- **OAuth**, for clients that support the MCP authorization flow. The client discovers Maple's authorization server from the endpoint URL, registers itself, and opens a browser sign-in. You pick the organization on the consent screen. Access tokens last 1 hour and are refreshed automatically. The client has to sign in again after 30 days without a refresh, and 90 days after the first sign-in at the latest. OAuth tokens only work on the MCP server.

The [MCP server](/docs/reference/mcp#connecting-a-client) page has client configuration examples.

## Dashboard session tokens and `x-maple-org-id`

The dashboard calls the REST API with the signed-in user's session token. You can do the same from a script, but API keys are the supported way to automate.

A user who belongs to several organizations can choose which one a `/v2` request acts on with the `x-maple-org-id` header. Maple checks that the user is a member of that organization and applies the user's role there. If the check fails, the request is rejected with `403`; it is never served under a different organization. With an API key, the header may only name the key's own organization. Any other value is rejected.
