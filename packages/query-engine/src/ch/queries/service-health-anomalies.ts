import { unsafeCompiledQuery, type CompiledQuery } from "../compile"
import { escapeClickHouseString } from "../../sql/sql-fragment"

export type ServiceHealthAnomalySignal = "error_rate" | "p95_latency" | "p99_latency" | "throughput" | "apdex"

export interface ServiceHealthAnomalyQueryParams {
	readonly orgId: string
	readonly startTime: string
	readonly endTime: string
	readonly baselineStartTime: string
	readonly baselineEndTime: string
	readonly currentHourUtc: number
	readonly currentWindowMinutes: number
	readonly signalType: ServiceHealthAnomalySignal
	readonly serviceNames?: readonly string[]
	readonly excludeServiceNames?: readonly string[]
	readonly apdexThresholdMs?: number
}

export interface ServiceHealthAnomalyOutput {
	readonly groupKey: string
	readonly serviceName: string
	readonly deploymentEnv: string
	readonly currentValue: number
	readonly sampleCount: number
	readonly currentErrorCount: number
	readonly baselineMedian: number | null
	readonly baselineLower: number | null
	readonly baselineUpper: number | null
	readonly baselineQ25: number | null
	readonly baselineQ75: number | null
	readonly baselineBucketCount: number
	readonly robustScale: number | null
}

const quote = (value: string): string => `'${escapeClickHouseString(value)}'`

const intLiteral = (value: number, fallback: number): string => {
	if (!Number.isFinite(value)) return String(fallback)
	return String(Math.max(0, Math.trunc(value)))
}

const stringList = (values: readonly string[]): string => values.map(quote).join(", ")

const serviceFilterSql = (
	alias: string,
	serviceNames: readonly string[] | undefined,
	excludeServiceNames: readonly string[] | undefined,
): string => {
	const conditions: string[] = []
	if (serviceNames && serviceNames.length > 0) {
		conditions.push(`${alias}.ServiceName IN (${stringList(serviceNames)})`)
	}
	if (excludeServiceNames && excludeServiceNames.length > 0) {
		conditions.push(`${alias}.ServiceName NOT IN (${stringList(excludeServiceNames)})`)
	}
	return conditions.length > 0 ? `\n    AND ${conditions.join("\n    AND ")}` : ""
}

const metricExpressions = (signalType: ServiceHealthAnomalySignal, apdexThresholdNs: string) => {
	switch (signalType) {
		case "error_rate":
			return {
				current:
					"if(sum(SampleRate) > 0, sumIf(SampleRate, StatusCode = 'Error') / sum(SampleRate), 0)",
				baseline:
					"if(sum(WeightedCount) > 0, sum(WeightedErrorCount) / sum(WeightedCount), 0)",
			}
		case "p95_latency":
			return {
				current:
					"quantileTDigestWeighted(0.95)(Duration, toUInt32(greatest(SampleRate, 1.0))) / 1000000",
				baseline:
					"arrayElement(quantilesTDigestWeightedMerge(0.5, 0.95, 0.99)(DurationQuantiles), 2) / 1000000",
			}
		case "p99_latency":
			return {
				current:
					"quantileTDigestWeighted(0.99)(Duration, toUInt32(greatest(SampleRate, 1.0))) / 1000000",
				baseline:
					"arrayElement(quantilesTDigestWeightedMerge(0.5, 0.95, 0.99)(DurationQuantiles), 3) / 1000000",
			}
		case "throughput":
			return {
				current: "sum(SampleRate) / greatest(1, dateDiff('minute', toDateTime(start_time), toDateTime(end_time)))",
				baseline: "sum(WeightedCount) / 60",
			}
		case "apdex":
			return {
				current: `if(sum(SampleRate) > 0, (sumIf(SampleRate, Duration <= ${apdexThresholdNs}) + sumIf(SampleRate, Duration > ${apdexThresholdNs} AND Duration <= ${Number(apdexThresholdNs) * 4}) / 2) / sum(SampleRate), 0)`,
				baseline:
					"if(sum(WeightedCount) > 0, (sum(ApdexSatisfiedCount) + sum(ApdexToleratingCount) / 2) / sum(WeightedCount), 0)",
			}
	}
}

/**
 * Handwritten SQL for the adaptive service-health detector.
 *
 * The query is intentionally surfaced through the CH module even though it uses
 * `unsafeCompiledQuery`: it is a fixed, org-scoped query shape whose CTE-heavy
 * robust statistics are more readable as SQL than as the lightweight DSL.
 */
export function serviceHealthAnomalyQuery(
	params: ServiceHealthAnomalyQueryParams,
): CompiledQuery<ServiceHealthAnomalyOutput> {
	const signalType = params.signalType
	const apdexThresholdNs = intLiteral((params.apdexThresholdMs ?? 500) * 1_000_000, 500_000_000)
	const metric = metricExpressions(signalType, apdexThresholdNs)
	const currentHour = intLiteral(params.currentHourUtc, 0)
	const currentWindowMinutes = intLiteral(params.currentWindowMinutes, 15)
	const currentServiceFilter = serviceFilterSql(
		"s",
		params.serviceNames,
		params.excludeServiceNames,
	)
	const baselineServiceFilter = serviceFilterSql(
		"h",
		params.serviceNames,
		params.excludeServiceNames,
	)

	const sql = `
WITH
  ${quote(params.startTime)} AS start_time,
  ${quote(params.endTime)} AS end_time,
  ${quote(params.baselineStartTime)} AS baseline_start_time,
  ${quote(params.baselineEndTime)} AS baseline_end_time,
  ${currentWindowMinutes} AS current_window_minutes,
  current AS (
    SELECT
      s.ServiceName AS serviceName,
      s.DeploymentEnv AS deploymentEnv,
      if(s.DeploymentEnv = '', s.ServiceName, concat(s.ServiceName, ' env:', s.DeploymentEnv)) AS groupKey,
      ${metric.current} AS currentValue,
      sum(s.SampleRate) AS sampleCount,
      sumIf(s.SampleRate, s.StatusCode = 'Error') AS currentErrorCount
    FROM service_overview_spans AS s
    WHERE s.OrgId = ${quote(params.orgId)}
      AND s.Timestamp >= toDateTime(start_time)
      AND s.Timestamp < toDateTime(end_time)
      ${currentServiceFilter}
    GROUP BY s.ServiceName, s.DeploymentEnv
  ),
  baseline_hourly AS (
    SELECT
      h.ServiceName AS serviceName,
      h.DeploymentEnv AS deploymentEnv,
      h.Hour AS hour,
      ${metric.baseline} AS value
    FROM service_health_hourly AS h
    WHERE h.OrgId = ${quote(params.orgId)}
      AND h.Hour >= toDateTime(baseline_start_time)
      AND h.Hour < toDateTime(baseline_end_time)
      AND least(abs(toHour(h.Hour) - ${currentHour}), 24 - abs(toHour(h.Hour) - ${currentHour})) <= 2
      ${baselineServiceFilter}
    GROUP BY h.ServiceName, h.DeploymentEnv, h.Hour
  ),
  baseline AS (
    SELECT
      serviceName,
      deploymentEnv,
      count() AS baselineBucketCount,
      quantileTDigest(0.5)(value) AS baselineMedian,
      quantileTDigest(0.1)(value) AS baselineLower,
      quantileTDigest(0.9)(value) AS baselineUpper,
      quantileTDigest(0.25)(value) AS baselineQ25,
      quantileTDigest(0.75)(value) AS baselineQ75
    FROM baseline_hourly
    GROUP BY serviceName, deploymentEnv
  )
SELECT
  current.groupKey AS groupKey,
  current.serviceName AS serviceName,
  current.deploymentEnv AS deploymentEnv,
  current.currentValue AS currentValue,
  current.sampleCount AS sampleCount,
  current.currentErrorCount AS currentErrorCount,
  baseline.baselineMedian AS baselineMedian,
  baseline.baselineLower AS baselineLower,
  baseline.baselineUpper AS baselineUpper,
  baseline.baselineQ25 AS baselineQ25,
  baseline.baselineQ75 AS baselineQ75,
  toUInt16(ifNull(baseline.baselineBucketCount, 0)) AS baselineBucketCount,
  if(
    baseline.baselineBucketCount > 0,
    greatest((baseline.baselineQ75 - baseline.baselineQ25) / 1.349, 0.000001),
    NULL
  ) AS robustScale
FROM current
LEFT JOIN baseline
  ON current.serviceName = baseline.serviceName
 AND current.deploymentEnv = baseline.deploymentEnv
ORDER BY current.sampleCount DESC, current.groupKey ASC
FORMAT JSON
`

	return unsafeCompiledQuery<ServiceHealthAnomalyOutput>({ sql })
}
