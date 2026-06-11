---
name: maple-audit
description: "Audit an already-instrumented project against Maple's OpenTelemetry conventions, report gaps per service, and fix them. Triggers on requests like 'audit my instrumentation', 'check my telemetry', 'review my OTel setup', 'why is my service map missing edges', 'is my Maple instrumentation correct'."
---

# Maple instrumentation audit

Review an existing OpenTelemetry setup against what Maple actually consumes, produce a findings report, then fix the gaps. This is the counterpart to `maple-onboard`: that skill installs telemetry from scratch; this one assumes instrumentation exists and asks whether it's *right*.

Before auditing, read `checks.md` in this skill's directory — it is the full check registry (check ids, severities, what each gap breaks in Maple). Every finding you report must cite a check id from there; never invent attribute keys or conventions that aren't in `checks.md` or the upstream OTel semconv.

For *how* to fix what you find, use the companion skills — don't improvise recipes:

- `maple-onboarding-style` for general OTel taste, VCS attributes, log bridges, metrics, LLM conventions.
- `maple-nextjs-style`, `maple-nodejs-style`, `maple-python-style`, `maple-effect-style`, `maple-go-style`, `maple-rust-style`, `maple-java-style`, `maple-csharp-style`, `maple-kotlin-style` for stack-specific bootstrap shapes.

## Severity

| Severity   | Meaning                                                                                                                                                                                                              |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `critical` | Breaks a Maple feature outright or is a data risk: missing `service.name`, hand-stamped status strings (error analytics read zero rows), logs without trace correlation, missing `peer.service`/`db.system` on client spans, PII in attributes. |
| `warn`     | Feature works degraded: missing environment/VCS resource attrs, deprecated semconv keys, double-emission, high-cardinality labels or span names, outbound calls left `Internal`.                                        |
| `info`     | Signal-quality improvements: missing business spans/metrics, naming style, missing `gen_ai.*` on LLM calls.                                                                                                             |

## Step 1 — Enumerate services and classify

Map every app/service in the repo exactly as `maple-onboard` Step 1 does (workspace manifests, `apps/*`, `services/*`, mobile, edge/serverless functions — skip pure type/config packages). For each, find its OTel bootstrap and classify:

- **instrumented** — has an SDK bootstrap; gets the full audit below.
- **partial** — some signals wired (e.g. traces but no log bridge); audit what exists, flag what's absent.
- **not instrumented** — no OTel at all. That is a single `critical` finding pointing the user at `maple-onboard`; don't run per-check audits against nothing.

Show the user the service list with classifications before auditing, so they can correct it.

## Step 2 — Static code audit

Per instrumented service, work through the categories in `checks.md`:

1. **Bootstrap & resource (RES-\*)** — read the SDK init: is `service.name` explicit, are `service.version`, `deployment.environment.name`, `vcs.repository.url.full`, `vcs.ref.head.revision` on the resource? Any invented keys?
2. **Status & kind (STAT-\*)** — grep for status handling: SDK status enum vs hand-stamped strings; failure paths recording exceptions; outbound calls created as `Client`/`Producer` spans.
3. **Service-map attribution (MAP-\*)** — for every outbound dependency in the code (HTTP clients to internal services, DB drivers, queues), check the corresponding spans set `peer.service` (and `db.system` for DBs) consistently.
4. **Attribute keys (REN-\*, NAME-\*)** — grep attribute call sites (`setAttribute`, `set_attribute`, `setAttributes`, attribute map literals) for the deprecated/camelCase keys in the REN table and for double-emission of old+new keys.
5. **Logs (LOG-\*)** — is an OTLP log bridge wired under the logger the app actually uses? Do in-span logs carry trace context? Structured fields?
6. **Metrics (MET-\*)** — instruments at module scope, low-cardinality labels, business coverage.
7. **PII (PII-01)** — scan attribute values for emails, tokens, auth headers, full bodies.
8. **LLM (LLM-\*)** — only if the project calls LLM providers.

Collect findings as you go: service, check id, severity, evidence (`file:line`), and which Maple feature it affects (from `checks.md`).

## Step 3 — Live cross-check (only when the Maple MCP is connected)

If `mcp__maple__*` tools are available, verify the static findings against what's actually arriving. If they're not available, say so in one line of the report and move on — the static audit stands alone. Don't ask the user to install the MCP mid-audit.

- **`get_instrumentation_recommendations`** — the authoritative list of deprecated/double-emitted/non-conforming attribute keys, reconciled against the org's live span data, plus resource-attribute coverage gaps. Where it disagrees with your static REN/NAME findings, the live data wins (the code you read may not be deployed, or other emitters exist).
- **`list_services`** — confirm every service you enumerated actually reports. A service that's instrumented in code but absent here is a `critical` export problem (bootstrap not loaded, key wrong, exporter blocked).
- **`explore_attributes`** (resource scope) — confirm environment/VCS/version resource attrs arrive in practice.
- **`service_map`** — a service whose code makes outbound calls but shows no outgoing edges confirms MAP-01/02/03 findings from the data side.

Annotate existing findings with live evidence rather than duplicating them.

## Step 4 — Findings report

Present the report **before making any edit**. Format:

```
## Instrumentation audit — <repo>

### <service-name>  (instrumented | partial | not instrumented)
| Severity | Check  | Finding                                   | Evidence            | Affects                  |
| critical | MAP-01 | Client spans to billing lack peer.service | src/billing.ts:88   | service map edge missing |
| warn     | REN-02 | emits http.status_code                    | live: 12.4k spans/24h | rename to http.response.status_code |
...

### Summary
N critical · N warn · N info across M services. Recommended fix order: …
```

Every row carries a check id and concrete evidence (file:line for static, counts/tool output for live). If the MCP wasn't connected, note "live cross-check skipped — Maple MCP not connected" here.

## Step 5 — Apply fixes

After the report, fix in severity order (`critical` → `warn` → `info`), following the relevant style skill for each edit. Rules:

- Pure key renames (REN rows of kind *rename*) have two valid routes: rename at the SDK (preferred — fixes it at the source), or accept the matching Recommendation Issue in Maple Settings → Ingestion, which creates an ingest attribute mapping. Tell the user both; default to the SDK rename when you're already editing that file.
- Double-emission and naming issues can **only** be fixed at the SDK — an ingest mapping can't merge keys.
- Idempotent edits; preserve the project's package manager, logger, and formatting.
- Never remove an existing observability vendor (Sentry, Datadog, …) — coexistence is the default.
- Never put PII in attributes; when fixing PII-01, replace the value with an ID or drop the attribute, don't hash-and-keep.
- Never commit, push, or open PRs.

If the user only wants the review, stop after Step 4 — the report is a complete deliverable.

## Step 6 — Re-verify

For every service you touched, run the same smoke as `maple-onboard` Step 4: the service's own dev/build command starts cleanly, and OTLP POSTs from the running process return 2xx. A fix that breaks startup is a regression — fix or revert it, don't paper over it.

Then close out: summarize what changed per service, and tell the user that after deploying, re-running `get_instrumentation_recommendations` (or checking Settings → Ingestion in Maple) will show issues auto-resolving as the offending keys stop arriving — reconciliation is automatic.

## Hard rules

- No edits before the findings report has been shown (Step 4).
- Every finding cites a check id from `checks.md`; no invented attribute keys or conventions.
- The static audit must work standalone — the Maple MCP is an enhancer, never a requirement.
- Never modify files outside the project root; never commit or push.
- Fix recipes come from the `maple-*-style` skills, not from memory.
