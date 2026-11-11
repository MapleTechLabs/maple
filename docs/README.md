# Docs index

Reference docs describe how things work today; read the matching one before changing that area.
Plans and specs carry their own status line at the top. Dated docs are snapshots and are not kept
current.

## Architecture and reference

| Area                   | Doc                                                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Infrastructure, deploy | [infra.md](infra.md), [backup-and-recovery.md](backup-and-recovery.md), [pr-previews.md](pr-previews.md), [tinybird-pr-branches.md](tinybird-pr-branches.md)                           |
| Warehouse              | [warehouse-rollups.md](warehouse-rollups.md), [warehouse-datetime-utc.md](warehouse-datetime-utc.md), [query-benchmarking.md](query-benchmarking.md), [self-hosted-clickhouse.md](self-hosted-clickhouse.md) |
| Postgres               | [persistence.md](persistence.md), [secret-encryption.md](secret-encryption.md), [electric-sync.md](electric-sync.md)                                                                  |
| Ingest                 | [ingest-wal-durability.md](ingest-wal-durability.md), [ingest-rules.md](ingest-rules.md), [sampling-throughput.md](sampling-throughput.md)                                           |
| OpenTelemetry          | [otel-spec/](otel-spec/README.md) (spec digest), [attributes.md](attributes.md), [database-query-observability.md](database-query-observability.md)                                 |
| Errors and issues      | [error-issue-lifecycle.md](error-issue-lifecycle.md)                                                                                                                                 |
| Service map            | [service-map-architecture.md](service-map-architecture.md), [service-map-infrastructure.md](service-map-infrastructure.md)                                                          |
| Dashboard UI           | [design-rules.md](design-rules.md), [dashboard-grid.md](dashboard-grid.md), [views-roadmap.md](views-roadmap.md), [foldkit-decisions/](foldkit-decisions/s1-skeleton.md) (migration spikes) |
| APIs                   | [api-v2.md](api-v2.md), [http-api-migration.md](http-api-migration.md), [mcp-oauth.md](mcp-oauth.md)                                                                                 |
| Eventing               | [signal-to-event-projection.md](signal-to-event-projection.md), [eventing-extension-guide.md](eventing-extension-guide.md)                                                          |
| Maple Local            | [local-mode.md](local-mode.md), [local-event-consumers.md](local-event-consumers.md), [local-projector-modules.md](local-projector-modules.md), [local-telemetry-archives.md](local-telemetry-archives.md), [local-ingest-benchmarking.md](local-ingest-benchmarking.md) |
| AI and agents          | [openrouter-tracing.md](openrouter-tracing.md), [pr-review-agent-evaluation.md](pr-review-agent-evaluation.md)                                                                     |
| Integrations           | [github-app-setup.md](github-app-setup.md), [docker-container-monitoring.md](docker-container-monitoring.md), [browser-sdk.md](browser-sdk.md)                                       |
| Billing                | [billing-orgs.md](billing-orgs.md), [cancellation-reviews.md](cancellation-reviews.md)                                                                                               |
| CI                     | [ci-performance.md](ci-performance.md)                                                                                                                                               |
| Marketing site         | [geo-ai-search.md](geo-ai-search.md)                                                                                                                                                 |

## Plans and specs

[alerting-tier1-spec.md](alerting-tier1-spec.md), [cloud-cost-plan.md](cloud-cost-plan.md),
[eu-region-plan.md](eu-region-plan.md),
[external-data-sources-plan.md](external-data-sources-plan.md), [mcp-hub-plan.md](mcp-hub-plan.md),
[otel-coverage-roadmap.md](otel-coverage-roadmap.md), [pr-review-agent-plan.md](pr-review-agent-plan.md),
[pr-review-merge-checklist-plan.md](pr-review-merge-checklist-plan.md),
[product-events-dashboard-parity.md](product-events-dashboard-parity.md),
[product-events-funnels.md](product-events-funnels.md), [profiling.md](profiling.md),
[security-center-plan.md](security-center-plan.md), [user-pages-plan.md](user-pages-plan.md).

## Dated snapshots and history

Not maintained; file paths in them may have moved.
[infra-history.md](infra-history.md), [api-cpu-investigation-2026-09-12.md](api-cpu-investigation-2026-09-12.md),
[legacy-cleanup-sweep-2026-09-05.md](legacy-cleanup-sweep-2026-09-05.md),
[query-optimization-review-2026-09-05.md](query-optimization-review-2026-09-05.md),
[query-optimization-second-scan-2026-09-05.md](query-optimization-second-scan-2026-09-05.md),
[query-optimization-implementation-2026-09-05.md](query-optimization-implementation-2026-09-05.md),
[pr-review-model-comparison-2026-09-25.md](pr-review-model-comparison-2026-09-25.md),
[drizzle-v1-effect-upgrade-plan.md](drizzle-v1-effect-upgrade-plan.md) (shipped),
[sst-fork-workflow.md](sst-fork-workflow.md) (obsolete), [benchmarks/](benchmarks/) (raw JSON).
