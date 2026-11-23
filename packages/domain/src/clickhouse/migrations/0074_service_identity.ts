/**
 * Migration 0074: service identity on the service map. `service_platforms_hourly` also keeps the
 * service's instrumentation scope names, its SDK self-report (`telemetry.sdk.name`/`language`,
 * `os.name`) and its span-kind mix, which `classifyServiceIdentity` turns into a kind (web app,
 * API, queue consumer...) and a framework (Next.js, Effect, Hono...).
 *
 * Measures, not dimensions: the grain and sorting key are unchanged, so this is additive ALTERs plus
 * the view rebuilt from columns it already reads (no new attribute map). `ClassifiedSpanCount` is the
 * coverage marker: rows sealed before this migration hold 0, so their kind counts mean unknown rather
 * than none, and the classifier falls back to SDK and framework signals. Nothing is backfilled.
 *
 * `requiredForIngest: false`: MV-populated, the gateway never writes it. Frozen v74 DDL.
 */
export const migration_0074_service_identity = {
	version: 74,
	description:
		"Keep instrumentation scopes, SDK self-report and span-kind counts per service-hour for service identity",
	requiredForIngest: false,
	statements: [
		"ALTER TABLE service_platforms_hourly ADD COLUMN IF NOT EXISTS ScopeNames SimpleAggregateFunction(groupUniqArrayArray, Array(String))",
		"ALTER TABLE service_platforms_hourly ADD COLUMN IF NOT EXISTS TelemetrySdkName SimpleAggregateFunction(max, String)",
		"ALTER TABLE service_platforms_hourly ADD COLUMN IF NOT EXISTS TelemetrySdkLanguage SimpleAggregateFunction(max, String)",
		"ALTER TABLE service_platforms_hourly ADD COLUMN IF NOT EXISTS OsName SimpleAggregateFunction(max, String)",
		"ALTER TABLE service_platforms_hourly ADD COLUMN IF NOT EXISTS ClassifiedSpanCount SimpleAggregateFunction(sum, UInt64)",
		"ALTER TABLE service_platforms_hourly ADD COLUMN IF NOT EXISTS ServerSpanCount SimpleAggregateFunction(sum, UInt64)",
		"ALTER TABLE service_platforms_hourly ADD COLUMN IF NOT EXISTS ConsumerSpanCount SimpleAggregateFunction(sum, UInt64)",
		"ALTER TABLE service_platforms_hourly ADD COLUMN IF NOT EXISTS ClientSpanCount SimpleAggregateFunction(sum, UInt64)",
		"ALTER TABLE service_platforms_hourly ADD COLUMN IF NOT EXISTS RootSpanCount SimpleAggregateFunction(sum, UInt64)",
		"DROP VIEW IF EXISTS service_platforms_hourly_mv",
		"CREATE MATERIALIZED VIEW IF NOT EXISTS service_platforms_hourly_mv TO service_platforms_hourly AS\nSELECT\n          OrgId,\n          toStartOfHour(toDateTime(Timestamp)) AS Hour,\n          ServiceName,\n          coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) AS DeploymentEnv,\n          max(ResourceAttributes['k8s.cluster.name']) AS K8sCluster,\n          max(ResourceAttributes['k8s.pod.name']) AS K8sPodName,\n          max(ResourceAttributes['k8s.deployment.name']) AS K8sDeploymentName,\n          max(ResourceAttributes['k8s.statefulset.name']) AS K8sStatefulSetName,\n          max(ResourceAttributes['k8s.daemonset.name']) AS K8sDaemonSetName,\n          max(ResourceAttributes['k8s.namespace.name']) AS K8sNamespaceName,\n          max(ResourceAttributes['cloud.platform']) AS CloudPlatform,\n          max(ResourceAttributes['cloud.provider']) AS CloudProvider,\n          max(ResourceAttributes['faas.name']) AS FaasName,\n          max(ResourceAttributes['maple.sdk.type']) AS MapleSdkType,\n          max(ResourceAttributes['process.runtime.name']) AS ProcessRuntimeName,\n          count() AS SpanCount,\n          -- Scope names are code-defined, not data; 32 per service-hour bounds a pathological one.\n          groupUniqArray(32)(ScopeName) AS ScopeNames,\n          max(ResourceAttributes['telemetry.sdk.name']) AS TelemetrySdkName,\n          max(ResourceAttributes['telemetry.sdk.language']) AS TelemetrySdkLanguage,\n          max(ResourceAttributes['os.name']) AS OsName,\n          count() AS ClassifiedSpanCount,\n          countIf(SpanKind = 'Server') AS ServerSpanCount,\n          countIf(SpanKind = 'Consumer') AS ConsumerSpanCount,\n          countIf(SpanKind IN ('Client', 'Producer')) AS ClientSpanCount,\n          countIf(ParentSpanId = '') AS RootSpanCount\n        FROM traces\n        WHERE ServiceName != ''\n        GROUP BY OrgId, Hour, ServiceName, DeploymentEnv",
	],
} as const
