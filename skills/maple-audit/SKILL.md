---
name: maple-audit
description: "Audit an already-instrumented project against Maple's OpenTelemetry conventions, report gaps per service, and fix them. Triggers on requests like 'audit my instrumentation', 'check my telemetry', 'review my OTel setup', 'why is my service map missing edges', 'is my Maple instrumentation correct'."
---

# Maple instrumentation audit

Review an existing OpenTelemetry setup against what Maple actually consumes, produce a findings report, then fix the gaps. This is the counterpart to `maple-onboard`. That skill installs telemetry from scratch; this one assumes instrumentation exists and checks whether it is *right*.

Before auditing, read `checks.md` in this skill's directory. It is the full check registry: check ids, severities, and what each gap breaks in Maple. Every finding you report must cite a check id from it. Never invent attribute keys or conventions that aren't in `checks.md` or the upstream OTel semconv.

For *how* to fix what you find, use the companion skills. Don't improvise recipes:

- `maple-onboarding-style` for general OTel taste, VCS attributes, log bridges, metrics, LLM conventions.
- `maple-nextjs-style`, `maple-nodejs-style`, `maple-python-style`, `maple-effect-style`, `maple-go-style`, `maple-rust-style`, `maple-java-style`, `maple-csharp-style`, `maple-kotlin-style` for stack-specific bootstrap shapes.

## Severity

| Severity   | Meaning                                                                                                                                                                                                              |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `critical` | Breaks a Maple feature outright or is a data risk: missing `service.name`, hand-stamped status strings (error analytics read zero rows), logs without trace correlation, outbound calls that can't form a service-map edge (no `Client` span, broken `traceparent`, DB spans without `db.system.name`), PII in attributes. |
| `warn`     | The feature works degraded or work is invisible: missing environment/VCS resource attrs, deprecated semconv keys, double-emission, high-cardinality labels or span names, outbound calls left `Internal`, untraced operations (missing auto-instrumentation for a used framework/driver, business operations and background jobs with no spans). |
| `info`     | Signal-quality improvements: trace-context propagation across async boundaries, span noise, missing metrics, naming style, missing `gen_ai.*` on LLM calls.                                                            |

## Step 1: Enumerate services and classify

Map every app/service in the repo exactly as `maple-onboard` Step 1 does (workspace manifests, `apps/*`, `services/*`, mobile, edge/serverless functions; skip pure type/config packages). For each, find its OTel bootstrap and classify it:

- **instrumented**: has an SDK bootstrap. Gets the full audit below.
- **partial**: some signals wired (e.g. traces but no log bridge). Audit what exists and flag what's absent.
- **not instrumented**: no OTel at all. Report a single `critical` finding pointing the user at `maple-onboard`. Don't run per-check audits against nothing.

Show the user the service list with classifications before auditing, so they can correct it.

## Step 2: Static code audit

Per instrumented service, work through the categories in `checks.md`:

1. **Bootstrap & resource (RES-\*)**: read the SDK init. Is `service.name` explicit? Are `service.version`, `deployment.environment.name`, `vcs.repository.url.full`, `vcs.ref.head.revision` on the resource? Any invented keys?
2. **Status & kind (STAT-\*)**: grep status handling. SDK status enum or hand-stamped strings? Do failure paths record exceptions? Are outbound calls `Client`/`Producer` spans?
3. **Trace coverage (SPAN-\*)**: find what *should* be traced but isn't. Compare the dependency manifest against the instrumentation registered in the bootstrap: a DB driver or queue client with no instrumentation package means that whole category emits nothing. Then read the code for critical business operations, background jobs, and queue consumers with no span in their call path. Ask what an operator would need to see when this service misbehaves that currently emits nothing.
4. **Service-map attribution (MAP-\*)**: for every outbound dependency in the code, check the call produces what the map joins on. Calls to internal services need a `Client`/`Producer` span that propagates `traceparent` to an instrumented callee. DB calls need `db.system.name` (and `db.namespace`). Queue/RPC calls need `messaging.*` / `rpc.*` attributes.
5. **Attribute keys (REN-\*, NAME-\*)**: grep attribute call sites (`setAttribute`, `set_attribute`, `setAttributes`, attribute map literals) for the deprecated/camelCase keys in the REN table and for double-emission of old and new keys.
6. **Logs (LOG-\*)**: is an OTLP log bridge wired under the logger the app actually uses? Do in-span logs carry trace context? Are fields structured?
7. **Metrics (MET-\*)**: instruments at module scope, low-cardinality labels, business coverage.
8. **PII (PII-01)**: scan attribute values for emails, tokens, auth headers, full bodies.
9. **LLM (LLM-\*)**: only if the project calls LLM providers.

Record each finding as you go: service, check id, severity, evidence (`file:line`), and the Maple feature it affects (from `checks.md`).

## Step 3: Live cross-check (only when the Maple MCP is connected)

If `mcp__maple__*` tools are available, verify the static findings against what's actually arriving. If they aren't, say so in one line of the report and move on; the static audit stands alone. Don't ask the user to install the MCP mid-audit.

- **`audit_setup`**: Maple's own live audit of the org. Its findings use the same check ids as `checks.md` (RES, LOG, STAT, MAP, NAME, PII, MET) plus trace-completeness (`TRC-*`) and config (`CFG-*`) checks. Attach its evidence to the matching static findings.
- **`get_instrumentation_recommendations`**: the authoritative list of deprecated, double-emitted, and non-conforming attribute keys, reconciled against the org's live span data, plus resource-attribute coverage gaps. Where it disagrees with your static REN/NAME findings, the live data wins (the code you read may not be deployed, or other emitters exist).
- **`list_services`**: confirm every service you enumerated actually reports. A service instrumented in code but absent here is a `critical` export problem (bootstrap not loaded, wrong key, exporter blocked).
- **`explore_attributes`** (resource scope): confirm environment/VCS/version resource attrs arrive in practice.
- **`service_map`**: a service whose code makes outbound calls but shows no outgoing edges confirms MAP-01/02/04 findings from the data side.
- **`get_service_top_operations`** (or `search_traces` per service): confirm trace-coverage findings. A critical operation you flagged under SPAN-02/03 that never appears as a span name in live data is confirmed untraced. A DB-heavy service whose traces contain no DB client spans confirms SPAN-01.

Annotate existing findings with live evidence rather than duplicating them.

## Step 4: Findings report

Present the report **before making any edit**. Format:

```
## Instrumentation audit: <repo>

### <service-name>  (instrumented | partial | not instrumented)
| Severity | Check  | Finding                                   | Evidence            | Affects                  |
| critical | MAP-01 | billing client call made as Internal span, no traceparent | src/billing.ts:88   | service map edge missing |
| warn     | REN-02 | emits http.status_code                    | live: 12.4k spans/24h | rename to http.response.status_code |
...

### Summary
N critical · N warn · N info across M services. Recommended fix order: …
```

Every row carries a check id and concrete evidence (`file:line` for static, counts or tool output for live). If the MCP wasn't connected, note "live cross-check skipped: Maple MCP not connected" here.

## Step 5: Apply fixes

After the report, fix in severity order (`critical` → `warn` → `info`), following the relevant style skill for each edit. Rules:

- Pure key renames (REN rows of kind *rename*) have two valid routes: rename at the SDK (preferred, fixes it at the source), or accept the matching recommendation in Maple under Settings → Ingestion, which creates an ingest attribute mapping. Tell the user both. Default to the SDK rename when you're already editing that file.
- Double-emission and naming issues can **only** be fixed at the SDK. An ingest mapping can't merge keys.
- Make idempotent edits. Preserve the project's package manager, logger, and formatting.
- Never remove an existing observability vendor (Sentry, Datadog, …). Coexistence is the default.
- Never put PII in attributes. When fixing PII-01, replace the value with an ID or drop the attribute. Don't hash and keep it.
- Never commit, push, or open PRs.

If the user only wants the review, stop after Step 4. The report is a complete deliverable.

## Step 6: Re-verify

For every service you touched, run the same smoke as `maple-onboard` Step 4: the service's own dev/build command starts cleanly, and OTLP POSTs from the running process return 2xx. A fix that breaks startup is a regression. Fix or revert it; don't paper over it.

Then close out. Summarize what changed per service. Tell the user that after deploying, re-running `get_instrumentation_recommendations` (or checking Settings → Ingestion in Maple) shows issues auto-resolving as the offending keys stop arriving. Reconciliation is automatic.

## Hard rules

- No edits before the findings report has been shown (Step 4).
- Every finding cites a check id from `checks.md`. No invented attribute keys or conventions.
- The static audit must work standalone. The Maple MCP is an enhancer, never a requirement.
- Never modify files outside the project root. Never commit or push.
- Fix recipes come from the `maple-*-style` skills, not from memory.
