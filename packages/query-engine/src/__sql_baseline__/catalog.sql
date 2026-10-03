-- builder:activity:activeOrgsByErrorEventsQuery:default  [c251e0c2]
SELECT
          error_events_by_time.OrgId AS orgId
        FROM error_events_by_time
        WHERE error_events_by_time.Timestamp >= '2026-01-01 10:30:00'
        GROUP BY orgId
        FORMAT JSON

-- builder:activity:activeOrgsByLogsQuery:default  [366e775e]
SELECT
          logs_aggregates_hourly.OrgId AS orgId
        FROM logs_aggregates_hourly
        WHERE logs_aggregates_hourly.Hour >= '2026-01-01 10:30:00'
        GROUP BY orgId
        FORMAT JSON

-- builder:activity:activeOrgsByTracesQuery:default  [9669175f]
SELECT
          traces_aggregates_hourly.OrgId AS orgId
        FROM traces_aggregates_hourly
        WHERE traces_aggregates_hourly.Hour >= '2026-01-01 10:30:00'
        GROUP BY orgId
        FORMAT JSON

-- builder:audit-log:auditLogEntriesQuery:default  [e9929192]
SELECT
          audit_log.Id AS id,
          audit_log.OccurredAt AS occurredAt,
          audit_log.RecordedAt AS recordedAt,
          audit_log.ActorType AS actorType,
          audit_log.UserId AS userId,
          audit_log.ApiKeyId AS apiKeyId,
          audit_log.ActorId AS actorId,
          audit_log.ActorLabel AS actorLabel,
          audit_log.AffectedUserId AS affectedUserId,
          audit_log.Source AS source,
          audit_log.Action AS action,
          audit_log.Outcome AS outcome,
          audit_log.DenialReason AS denialReason,
          audit_log.ResourceType AS resourceType,
          audit_log.ResourceId AS resourceId,
          audit_log.ChangedFields AS changedFields,
          audit_log.Changes AS changes,
          audit_log.Metadata AS metadata,
          audit_log.RequestId AS requestId,
          audit_log.OriginIp AS originIp,
          audit_log.OriginCountry AS originCountry
        FROM audit_log
        WHERE audit_log.OrgId = 'org_sql_catalog'
        ORDER BY occurredAt DESC, id DESC
        LIMIT 50
        OFFSET 0
        FORMAT JSON

-- builder:audit-log:auditLogEntriesQuery:filtered  [802d9622]
SELECT
          audit_log.Id AS id,
          audit_log.OccurredAt AS occurredAt,
          audit_log.RecordedAt AS recordedAt,
          audit_log.ActorType AS actorType,
          audit_log.UserId AS userId,
          audit_log.ApiKeyId AS apiKeyId,
          audit_log.ActorId AS actorId,
          audit_log.ActorLabel AS actorLabel,
          audit_log.AffectedUserId AS affectedUserId,
          audit_log.Source AS source,
          audit_log.Action AS action,
          audit_log.Outcome AS outcome,
          audit_log.DenialReason AS denialReason,
          audit_log.ResourceType AS resourceType,
          audit_log.ResourceId AS resourceId,
          audit_log.ChangedFields AS changedFields,
          audit_log.Changes AS changes,
          audit_log.Metadata AS metadata,
          audit_log.RequestId AS requestId,
          audit_log.OriginIp AS originIp,
          audit_log.OriginCountry AS originCountry
        FROM audit_log
        WHERE audit_log.OrgId = 'org_sql_catalog'
          AND audit_log.ActorType = 'user'
          AND audit_log.UserId = 'user_1'
          AND audit_log.ApiKeyId = 'key_1'
          AND audit_log.ActorId = 'actor_1'
          AND audit_log.AffectedUserId = 'user_2'
          AND audit_log.Action = 'dashboard.updated'
          AND audit_log.Outcome = 'allowed'
          AND audit_log.ResourceType = 'dashboard'
          AND audit_log.ResourceId = 'dash_1'
          AND has(ChangedFields, 'name')
          AND audit_log.RequestId = 'ray'
          AND audit_log.OccurredAt >= '2026-01-01 10:30:00'
          AND audit_log.OccurredAt <= '2026-01-03 14:15:00'
        ORDER BY occurredAt DESC, id DESC
        LIMIT 50
        OFFSET 50
        FORMAT JSON

-- builder:containers:containerCountersSummaryQuery:default  [1b4fe1f9]
SELECT
          avg(hosts.memoryBytesAvg) AS memoryBytesAvg,
          max(hosts.memoryLimitBytes) AS memoryLimitBytes,
          sum(hosts.restartsDelta) AS restartsDelta,
          avg(hosts.pidsAvg) AS pidsAvg
        FROM (SELECT
          metrics_sum.ResourceAttributes['host.name'] AS hostName,
          ifNull(ifNotFinite(avgIf(metrics_sum.Value, metrics_sum.MetricName = 'container.memory.usage.total'), 0), 0) AS memoryBytesAvg,
          ifNotFinite(maxIf(metrics_sum.Value, metrics_sum.MetricName = 'container.memory.usage.limit'), 0) AS memoryLimitBytes,
          ifNotFinite(maxIf(metrics_sum.Value, metrics_sum.MetricName = 'container.restarts') - minIf(metrics_sum.Value, metrics_sum.MetricName = 'container.restarts'), 0) AS restartsDelta,
          ifNull(ifNotFinite(avgIf(metrics_sum.Value, metrics_sum.MetricName = 'container.pids.count'), 0), 0) AS pidsAvg
        FROM metrics_sum
        WHERE metrics_sum.OrgId = 'org_sql_catalog'
          AND metrics_sum.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_sum.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_sum.ResourceAttributes['container.name'] = 'api'
          AND metrics_sum.ResourceAttributes['host.name'] = 'ip-10-0-1-42'
          AND metrics_sum.ResourceAttributes['k8s.pod.name'] = ''
          AND metrics_sum.MetricName IN ('container.memory.usage.total', 'container.memory.usage.limit', 'container.restarts', 'container.pids.count')
        GROUP BY hostName) AS hosts
        FORMAT JSON

-- builder:containers:containerDetailSummaryQuery:default  [509c508b]
SELECT
          metrics_gauge.ResourceAttributes['container.name'] AS containerName,
          any(metrics_gauge.ResourceAttributes['host.name']) AS hostName,
          any(metrics_gauge.ResourceAttributes['container.id']) AS containerId,
          any(metrics_gauge.ResourceAttributes['container.image.name']) AS imageName,
          any(metrics_gauge.ResourceAttributes['compose.project']) AS composeProject,
          any(metrics_gauge.ResourceAttributes['compose.service']) AS composeService,
          any(coalesce(nullIf(metrics_gauge.ResourceAttributes['container.runtime.name'], ''), metrics_gauge.ResourceAttributes['container.runtime'])) AS runtime,
          min(metrics_gauge.TimeUnix) AS firstSeen,
          max(metrics_gauge.TimeUnix) AS lastSeen,
          ifNull(ifNotFinite(avgIf(metrics_gauge.Value, metrics_gauge.MetricName = 'container.cpu.utilization'), 0), 0) / 100 AS cpuPct,
          ifNull(ifNotFinite(avgIf(metrics_gauge.Value, metrics_gauge.MetricName = 'container.memory.percent'), 0), 0) / 100 AS memoryPct,
          ifNull(ifNotFinite(avgIf(metrics_gauge.Value, metrics_gauge.MetricName = 'container.cpu.limit'), 0), 0) AS cpuLimitCores,
          ifNotFinite(maxIf(metrics_gauge.Value, metrics_gauge.MetricName = 'container.uptime'), 0) AS uptimeSeconds
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_gauge.ResourceAttributes['container.name'] = 'api'
          AND metrics_gauge.ResourceAttributes['host.name'] = 'ip-10-0-1-42'
          AND metrics_gauge.ResourceAttributes['k8s.pod.name'] = ''
          AND metrics_gauge.MetricName IN ('container.cpu.utilization', 'container.memory.percent', 'container.uptime', 'container.cpu.limit')
        GROUP BY containerName
        FORMAT JSON

-- builder:containers:containerFacetsQuery:default  [07e48cae]
SELECT
          metrics_gauge.ResourceAttributes['container.name'] AS name,
          uniq(metrics_gauge.ResourceAttributes['container.id']) AS count,
          'container' AS facetType
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_gauge.ResourceAttributes['container.name'] != ''
          AND metrics_gauge.ResourceAttributes['k8s.pod.name'] = ''
          AND metrics_gauge.MetricName IN ('container.cpu.utilization')
          AND metrics_gauge.ResourceAttributes['container.name'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 200
UNION ALL
SELECT
          metrics_gauge.ResourceAttributes['host.name'] AS name,
          uniq(metrics_gauge.ResourceAttributes['container.id']) AS count,
          'host' AS facetType
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_gauge.ResourceAttributes['container.name'] != ''
          AND metrics_gauge.ResourceAttributes['k8s.pod.name'] = ''
          AND metrics_gauge.MetricName IN ('container.cpu.utilization')
          AND metrics_gauge.ResourceAttributes['host.name'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 100
UNION ALL
SELECT
          metrics_gauge.ResourceAttributes['container.image.name'] AS name,
          uniq(metrics_gauge.ResourceAttributes['container.id']) AS count,
          'image' AS facetType
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_gauge.ResourceAttributes['container.name'] != ''
          AND metrics_gauge.ResourceAttributes['k8s.pod.name'] = ''
          AND metrics_gauge.MetricName IN ('container.cpu.utilization')
          AND metrics_gauge.ResourceAttributes['container.image.name'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 100
UNION ALL
SELECT
          metrics_gauge.ResourceAttributes['compose.project'] AS name,
          uniq(metrics_gauge.ResourceAttributes['container.id']) AS count,
          'composeProject' AS facetType
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_gauge.ResourceAttributes['container.name'] != ''
          AND metrics_gauge.ResourceAttributes['k8s.pod.name'] = ''
          AND metrics_gauge.MetricName IN ('container.cpu.utilization')
          AND metrics_gauge.ResourceAttributes['compose.project'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 100
UNION ALL
SELECT
          metrics_gauge.ResourceAttributes['compose.service'] AS name,
          uniq(metrics_gauge.ResourceAttributes['container.id']) AS count,
          'composeService' AS facetType
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_gauge.ResourceAttributes['container.name'] != ''
          AND metrics_gauge.ResourceAttributes['k8s.pod.name'] = ''
          AND metrics_gauge.MetricName IN ('container.cpu.utilization')
          AND metrics_gauge.ResourceAttributes['compose.service'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 100
UNION ALL
SELECT
          coalesce(nullIf(metrics_gauge.ResourceAttributes['deployment.environment.name'], ''), metrics_gauge.ResourceAttributes['deployment.environment']) AS name,
          uniq(metrics_gauge.ResourceAttributes['container.id']) AS count,
          'environment' AS facetType
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_gauge.ResourceAttributes['container.name'] != ''
          AND metrics_gauge.ResourceAttributes['k8s.pod.name'] = ''
          AND metrics_gauge.MetricName IN ('container.cpu.utilization')
          AND coalesce(nullIf(metrics_gauge.ResourceAttributes['deployment.environment.name'], ''), metrics_gauge.ResourceAttributes['deployment.environment']) != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
FORMAT JSON

-- builder:containers:containerGaugeTimeseriesQuery:percent  [edd6f82f]
SELECT
          toStartOfInterval(metrics_gauge.TimeUnix, INTERVAL 300 SECOND) AS bucket,
          '' AS attributeValue,
          avg(metrics_gauge.Value) / 100 AS avgValue
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_gauge.ResourceAttributes['container.name'] = 'api'
          AND metrics_gauge.ResourceAttributes['host.name'] = 'ip-10-0-1-42'
          AND metrics_gauge.ResourceAttributes['k8s.pod.name'] = ''
          AND metrics_gauge.MetricName = 'container.cpu.utilization'
        GROUP BY bucket
        ORDER BY bucket ASC
        FORMAT JSON

-- builder:containers:containerGaugeTimeseriesQuery:unscaled  [17477b3b]
SELECT
          toStartOfInterval(metrics_gauge.TimeUnix, INTERVAL 300 SECOND) AS bucket,
          '' AS attributeValue,
          avg(metrics_gauge.Value) AS avgValue
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_gauge.ResourceAttributes['container.name'] = 'api'
          AND metrics_gauge.ResourceAttributes['k8s.pod.name'] = ''
          AND metrics_gauge.MetricName = 'container.uptime'
        GROUP BY bucket
        ORDER BY bucket ASC
        FORMAT JSON

-- builder:containers:containerSumTimeseriesQuery:blockio  [0408706f]
SELECT
          toStartOfInterval(metrics_sum.TimeUnix, INTERVAL 300 SECOND) AS bucket,
          metrics_sum.Attributes['operation'] AS attributeValue,
          sum(metrics_sum.Value) AS sumValue
        FROM metrics_sum
        WHERE metrics_sum.OrgId = 'org_sql_catalog'
          AND metrics_sum.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_sum.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_sum.ResourceAttributes['container.name'] = 'api'
          AND metrics_sum.ResourceAttributes['k8s.pod.name'] = ''
          AND metrics_sum.MetricName IN ('container.blockio.io_service_bytes_recursive')
        GROUP BY bucket, attributeValue
        ORDER BY bucket ASC
        FORMAT JSON

-- builder:containers:containerSumTimeseriesQuery:memory-average  [40d16060]
SELECT
          toStartOfInterval(metrics_sum.TimeUnix, INTERVAL 300 SECOND) AS bucket,
          '' AS attributeValue,
          avg(metrics_sum.Value) AS sumValue
        FROM metrics_sum
        WHERE metrics_sum.OrgId = 'org_sql_catalog'
          AND metrics_sum.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_sum.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_sum.ResourceAttributes['container.name'] = 'api'
          AND metrics_sum.ResourceAttributes['k8s.pod.name'] = ''
          AND metrics_sum.MetricName IN ('container.memory.usage.total')
        GROUP BY bucket, attributeValue
        ORDER BY bucket ASC
        FORMAT JSON

-- builder:containers:containerSumTimeseriesQuery:network  [45d4d8c9]
SELECT
          toStartOfInterval(metrics_sum.TimeUnix, INTERVAL 300 SECOND) AS bucket,
          multiIf(metrics_sum.MetricName = 'container.network.io.usage.rx_bytes', 'receive', metrics_sum.MetricName = 'container.network.io.usage.tx_bytes', 'transmit', '') AS attributeValue,
          sum(metrics_sum.Value) AS sumValue
        FROM metrics_sum
        WHERE metrics_sum.OrgId = 'org_sql_catalog'
          AND metrics_sum.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_sum.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_sum.ResourceAttributes['container.name'] = 'api'
          AND metrics_sum.ResourceAttributes['k8s.pod.name'] = ''
          AND metrics_sum.MetricName IN ('container.network.io.usage.rx_bytes', 'container.network.io.usage.tx_bytes')
        GROUP BY bucket, attributeValue
        ORDER BY bucket ASC
        FORMAT JSON

-- builder:containers:listContainersQuery:default  [ffaf0554]
SELECT
          containers.containerName AS containerName,
          containers.hostName AS hostName,
          containers.containerId AS containerId,
          containers.imageName AS imageName,
          containers.composeProject AS composeProject,
          containers.composeService AS composeService,
          containers.runtime AS runtime,
          containers.environment AS environment,
          containers.lastSeen AS lastSeen,
          containers.cpuPct AS cpuPct,
          containers.memoryPct AS memoryPct,
          containers.cpuPctPeak AS cpuPctPeak,
          containers.memoryPctPeak AS memoryPctPeak,
          containers.cpuLimitCores AS cpuLimitCores,
          containers.uptimeSeconds AS uptimeSeconds,
          containers.saturation AS saturation
        FROM (SELECT
          metrics_gauge.ResourceAttributes['container.name'] AS containerName,
          metrics_gauge.ResourceAttributes['host.name'] AS hostName,
          any(metrics_gauge.ResourceAttributes['container.id']) AS containerId,
          any(metrics_gauge.ResourceAttributes['container.image.name']) AS imageName,
          any(metrics_gauge.ResourceAttributes['compose.project']) AS composeProject,
          any(metrics_gauge.ResourceAttributes['compose.service']) AS composeService,
          any(coalesce(nullIf(metrics_gauge.ResourceAttributes['container.runtime.name'], ''), metrics_gauge.ResourceAttributes['container.runtime'])) AS runtime,
          any(coalesce(nullIf(metrics_gauge.ResourceAttributes['deployment.environment.name'], ''), metrics_gauge.ResourceAttributes['deployment.environment'])) AS environment,
          max(metrics_gauge.TimeUnix) AS lastSeen,
          ifNull(ifNotFinite(avgIf(metrics_gauge.Value, metrics_gauge.MetricName = 'container.cpu.utilization'), 0), 0) / 100 AS cpuPct,
          ifNull(ifNotFinite(avgIf(metrics_gauge.Value, metrics_gauge.MetricName = 'container.memory.percent'), 0), 0) / 100 AS memoryPct,
          ifNotFinite(maxIf(metrics_gauge.Value, metrics_gauge.MetricName = 'container.cpu.utilization'), 0) / 100 AS cpuPctPeak,
          ifNotFinite(maxIf(metrics_gauge.Value, metrics_gauge.MetricName = 'container.memory.percent'), 0) / 100 AS memoryPctPeak,
          ifNull(ifNotFinite(avgIf(metrics_gauge.Value, metrics_gauge.MetricName = 'container.cpu.limit'), 0), 0) AS cpuLimitCores,
          ifNotFinite(maxIf(metrics_gauge.Value, metrics_gauge.MetricName = 'container.uptime'), 0) AS uptimeSeconds,
          greatest(ifNotFinite(maxIf(metrics_gauge.Value, metrics_gauge.MetricName = 'container.cpu.utilization'), 0) / 100, ifNotFinite(maxIf(metrics_gauge.Value, metrics_gauge.MetricName = 'container.memory.percent'), 0) / 100) AS saturation
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_gauge.ResourceAttributes['container.name'] != ''
          AND metrics_gauge.ResourceAttributes['k8s.pod.name'] = ''
          AND metrics_gauge.MetricName IN ('container.cpu.utilization', 'container.memory.percent', 'container.uptime', 'container.cpu.limit')
        GROUP BY containerName, hostName) AS containers
        ORDER BY saturation DESC, cpuPctPeak DESC, containerName ASC
        LIMIT 50
        OFFSET 0
        FORMAT JSON

-- builder:containers:listContainersQuery:filtered  [f3f0fa49]
SELECT
          containers.containerName AS containerName,
          containers.hostName AS hostName,
          containers.containerId AS containerId,
          containers.imageName AS imageName,
          containers.composeProject AS composeProject,
          containers.composeService AS composeService,
          containers.runtime AS runtime,
          containers.environment AS environment,
          containers.lastSeen AS lastSeen,
          containers.cpuPct AS cpuPct,
          containers.memoryPct AS memoryPct,
          containers.cpuPctPeak AS cpuPctPeak,
          containers.memoryPctPeak AS memoryPctPeak,
          containers.cpuLimitCores AS cpuLimitCores,
          containers.uptimeSeconds AS uptimeSeconds,
          containers.saturation AS saturation
        FROM (SELECT
          metrics_gauge.ResourceAttributes['container.name'] AS containerName,
          metrics_gauge.ResourceAttributes['host.name'] AS hostName,
          any(metrics_gauge.ResourceAttributes['container.id']) AS containerId,
          any(metrics_gauge.ResourceAttributes['container.image.name']) AS imageName,
          any(metrics_gauge.ResourceAttributes['compose.project']) AS composeProject,
          any(metrics_gauge.ResourceAttributes['compose.service']) AS composeService,
          any(coalesce(nullIf(metrics_gauge.ResourceAttributes['container.runtime.name'], ''), metrics_gauge.ResourceAttributes['container.runtime'])) AS runtime,
          any(coalesce(nullIf(metrics_gauge.ResourceAttributes['deployment.environment.name'], ''), metrics_gauge.ResourceAttributes['deployment.environment'])) AS environment,
          max(metrics_gauge.TimeUnix) AS lastSeen,
          ifNull(ifNotFinite(avgIf(metrics_gauge.Value, metrics_gauge.MetricName = 'container.cpu.utilization'), 0), 0) / 100 AS cpuPct,
          ifNull(ifNotFinite(avgIf(metrics_gauge.Value, metrics_gauge.MetricName = 'container.memory.percent'), 0), 0) / 100 AS memoryPct,
          ifNotFinite(maxIf(metrics_gauge.Value, metrics_gauge.MetricName = 'container.cpu.utilization'), 0) / 100 AS cpuPctPeak,
          ifNotFinite(maxIf(metrics_gauge.Value, metrics_gauge.MetricName = 'container.memory.percent'), 0) / 100 AS memoryPctPeak,
          ifNull(ifNotFinite(avgIf(metrics_gauge.Value, metrics_gauge.MetricName = 'container.cpu.limit'), 0), 0) AS cpuLimitCores,
          ifNotFinite(maxIf(metrics_gauge.Value, metrics_gauge.MetricName = 'container.uptime'), 0) AS uptimeSeconds,
          greatest(ifNotFinite(maxIf(metrics_gauge.Value, metrics_gauge.MetricName = 'container.cpu.utilization'), 0) / 100, ifNotFinite(maxIf(metrics_gauge.Value, metrics_gauge.MetricName = 'container.memory.percent'), 0) / 100) AS saturation
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_gauge.ResourceAttributes['container.name'] != ''
          AND metrics_gauge.ResourceAttributes['k8s.pod.name'] = ''
          AND metrics_gauge.MetricName IN ('container.cpu.utilization', 'container.memory.percent', 'container.uptime', 'container.cpu.limit')
          AND positionCaseInsensitive(metrics_gauge.ResourceAttributes['container.name'], 'api') > 0
          AND metrics_gauge.ResourceAttributes['container.name'] NOT IN ('buildkitd')
          AND metrics_gauge.ResourceAttributes['host.name'] IN ('ip-10-0-1-42')
          AND metrics_gauge.ResourceAttributes['container.image.name'] IN ('ghcr.io/acme/api:1.4.2')
          AND metrics_gauge.ResourceAttributes['compose.project'] IN ('shop')
        GROUP BY containerName, hostName) AS containers
        ORDER BY cpuPct DESC, cpuPctPeak DESC, containerName ASC
        LIMIT 50
        OFFSET 0
        FORMAT JSON

-- builder:containers:listContainersQuery:scoped  [c10d69b4]
SELECT
          containers.containerName AS containerName,
          containers.hostName AS hostName,
          containers.containerId AS containerId,
          containers.imageName AS imageName,
          containers.composeProject AS composeProject,
          containers.composeService AS composeService,
          containers.runtime AS runtime,
          containers.environment AS environment,
          containers.lastSeen AS lastSeen,
          containers.cpuPct AS cpuPct,
          containers.memoryPct AS memoryPct,
          containers.cpuPctPeak AS cpuPctPeak,
          containers.memoryPctPeak AS memoryPctPeak,
          containers.cpuLimitCores AS cpuLimitCores,
          containers.uptimeSeconds AS uptimeSeconds,
          containers.saturation AS saturation
        FROM (SELECT
          metrics_gauge.ResourceAttributes['container.name'] AS containerName,
          metrics_gauge.ResourceAttributes['host.name'] AS hostName,
          any(metrics_gauge.ResourceAttributes['container.id']) AS containerId,
          any(metrics_gauge.ResourceAttributes['container.image.name']) AS imageName,
          any(metrics_gauge.ResourceAttributes['compose.project']) AS composeProject,
          any(metrics_gauge.ResourceAttributes['compose.service']) AS composeService,
          any(coalesce(nullIf(metrics_gauge.ResourceAttributes['container.runtime.name'], ''), metrics_gauge.ResourceAttributes['container.runtime'])) AS runtime,
          any(coalesce(nullIf(metrics_gauge.ResourceAttributes['deployment.environment.name'], ''), metrics_gauge.ResourceAttributes['deployment.environment'])) AS environment,
          max(metrics_gauge.TimeUnix) AS lastSeen,
          ifNull(ifNotFinite(avgIf(metrics_gauge.Value, metrics_gauge.MetricName = 'container.cpu.utilization'), 0), 0) / 100 AS cpuPct,
          ifNull(ifNotFinite(avgIf(metrics_gauge.Value, metrics_gauge.MetricName = 'container.memory.percent'), 0), 0) / 100 AS memoryPct,
          ifNotFinite(maxIf(metrics_gauge.Value, metrics_gauge.MetricName = 'container.cpu.utilization'), 0) / 100 AS cpuPctPeak,
          ifNotFinite(maxIf(metrics_gauge.Value, metrics_gauge.MetricName = 'container.memory.percent'), 0) / 100 AS memoryPctPeak,
          ifNull(ifNotFinite(avgIf(metrics_gauge.Value, metrics_gauge.MetricName = 'container.cpu.limit'), 0), 0) AS cpuLimitCores,
          ifNotFinite(maxIf(metrics_gauge.Value, metrics_gauge.MetricName = 'container.uptime'), 0) AS uptimeSeconds,
          greatest(ifNotFinite(maxIf(metrics_gauge.Value, metrics_gauge.MetricName = 'container.cpu.utilization'), 0) / 100, ifNotFinite(maxIf(metrics_gauge.Value, metrics_gauge.MetricName = 'container.memory.percent'), 0) / 100) AS saturation
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_gauge.ResourceAttributes['container.name'] != ''
          AND metrics_gauge.ResourceAttributes['k8s.pod.name'] = ''
          AND metrics_gauge.MetricName IN ('container.cpu.utilization', 'container.memory.percent', 'container.uptime', 'container.cpu.limit')
        GROUP BY containerName, hostName) AS containers
        WHERE containers.saturation >= 0.9
        ORDER BY saturation DESC, cpuPctPeak DESC, containerName ASC
        LIMIT 50
        OFFSET 0
        FORMAT JSON

-- builder:containers:listContainersSummaryQuery:default  [858e9b35]
SELECT
          count() AS totalContainers,
          countIf(containers.saturation >= 0.9) AS saturatedContainers,
          countIf((containers.saturation >= 0.6 AND containers.saturation < 0.9)) AS elevatedContainers,
          countIf(containers.lastSeen < '2026-01-03 14:15:00' - INTERVAL 300 SECOND) AS staleContainers
        FROM (SELECT
          metrics_gauge.ResourceAttributes['container.name'] AS containerName,
          metrics_gauge.ResourceAttributes['host.name'] AS hostName,
          max(metrics_gauge.TimeUnix) AS lastSeen,
          greatest(ifNotFinite(maxIf(metrics_gauge.Value, metrics_gauge.MetricName = 'container.cpu.utilization'), 0) / 100, ifNotFinite(maxIf(metrics_gauge.Value, metrics_gauge.MetricName = 'container.memory.percent'), 0) / 100) AS saturation
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_gauge.ResourceAttributes['container.name'] != ''
          AND metrics_gauge.ResourceAttributes['k8s.pod.name'] = ''
          AND metrics_gauge.MetricName IN ('container.cpu.utilization', 'container.memory.percent')
        GROUP BY containerName, hostName) AS containers
        FORMAT JSON

-- builder:errors:errorFingerprintsQuery:envFiltered  [5954d669]
SELECT
          toString(error_events_by_time.FingerprintHash) AS fingerprintHash
        FROM error_events_by_time
        WHERE error_events_by_time.OrgId = 'org_sql_catalog'
          AND error_events_by_time.Timestamp >= '2026-01-01 10:30:00'
          AND error_events_by_time.Timestamp <= '2026-01-03 14:15:00'
          AND error_events_by_time.ServiceName IN ('api')
          AND error_events_by_time.DeploymentEnv IN ('production')
        GROUP BY fingerprintHash
        LIMIT 1000
        FORMAT JSON

-- builder:errors:errorIssueEnvironmentsQuery:default  [ac20faf3]
SELECT
          error_events.DeploymentEnv AS name,
          count() AS count
        FROM error_events
        WHERE error_events.OrgId = 'org_sql_catalog'
          AND error_events.FingerprintHash = toUInt64('11640393269246331608')
          AND error_events.Timestamp >= '2026-01-01 10:30:00'
          AND error_events.Timestamp <= '2026-01-03 14:15:00'
          AND error_events.DeploymentEnv != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
        FORMAT JSON

-- builder:errors:errorIssueSampleTracesQuery:default  [2974a216]
SELECT
          error_events.TraceId AS traceId,
          error_events.SpanId AS spanId,
          error_events.ServiceName AS serviceName,
          error_events.Timestamp AS timestamp,
          error_events.ExceptionMessage AS exceptionMessage,
          intDiv(error_events.Duration, 1000) AS durationMicros
        FROM error_events
        WHERE error_events.OrgId = 'org_sql_catalog'
          AND error_events.FingerprintHash = toUInt64('11640393269246331608')
          AND error_events.Timestamp >= '2026-01-01 10:30:00'
          AND error_events.Timestamp <= '2026-01-03 14:15:00'
        ORDER BY timestamp DESC
        LIMIT 5
        FORMAT JSON

-- builder:errors:errorIssuesQuery:scan  [9440ec9b]
SELECT
          toString(error_events_by_time.FingerprintHash) AS fingerprintHash,
          any(error_events_by_time.ServiceName) AS serviceName,
          any(error_events_by_time.ExceptionType) AS exceptionType,
          any(error_events_by_time.ExceptionMessage) AS exceptionMessage,
          any(error_events_by_time.ErrorLabel) AS errorLabel,
          any(error_events_by_time.TopFrame) AS topFrame,
          count() AS count,
          uniq(error_events_by_time.ServiceName) AS affectedServicesCount,
          min(error_events_by_time.Timestamp) AS firstSeen,
          max(error_events_by_time.Timestamp) AS lastSeen
        FROM error_events_by_time
        WHERE error_events_by_time.OrgId = 'org_sql_catalog'
          AND error_events_by_time.Timestamp >= '2026-01-01 10:30:00'
          AND error_events_by_time.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY fingerprintHash
        ORDER BY count DESC
        LIMIT 500
        FORMAT JSON

-- builder:errors:errorIssueTimeseriesQuery:default  [6e698308]
SELECT
          toStartOfInterval(error_events.Timestamp, INTERVAL 300 SECOND) AS bucket,
          count() AS count
        FROM error_events
        WHERE error_events.OrgId = 'org_sql_catalog'
          AND error_events.FingerprintHash = toUInt64('11640393269246331608')
          AND error_events.Timestamp >= '2026-01-01 10:30:00'
          AND error_events.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY bucket
        ORDER BY bucket ASC
        FORMAT JSON

-- builder:errors:errorIssueVersionsSinceQuery:default  [df2788f2]
SELECT
          error_events.ServiceVersion AS serviceVersion,
          count() AS count
        FROM error_events
        WHERE error_events.OrgId = 'org_sql_catalog'
          AND error_events.FingerprintHash = toUInt64('11640393269246331608')
          AND error_events.Timestamp >= '2026-01-01 10:30:00'
          AND error_events.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY serviceVersion
        ORDER BY count DESC
        LIMIT 100
        FORMAT JSON

-- builder:errors:errorsSparkQuery:default  [b1229d72]
SELECT
          toString(error_events.FingerprintHash) AS fingerprintHash,
          toStartOfInterval(error_events.Timestamp, INTERVAL 300 SECOND) AS bucket,
          count() AS count
        FROM error_events
        WHERE error_events.OrgId = 'org_sql_catalog'
          AND error_events.FingerprintHash IN (toUInt64('11640393269246331608'))
          AND error_events.Timestamp >= '2026-01-01 10:30:00'
          AND error_events.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY fingerprintHash, bucket
        ORDER BY bucket ASC
        FORMAT JSON

-- builder:errors:errorTickBootstrapIssuesQuery:bootstrap-window  [43b589c9]
SELECT
          toString(error_events_by_time.FingerprintHash) AS fingerprintHash,
          any(error_events_by_time.ServiceName) AS serviceName,
          any(error_events_by_time.ExceptionType) AS exceptionType,
          any(error_events_by_time.ExceptionMessage) AS exceptionMessage,
          any(error_events_by_time.ErrorLabel) AS errorLabel,
          any(error_events_by_time.TopFrame) AS topFrame,
          groupUniqArray(error_events_by_time.ServiceVersion) AS serviceVersions,
          count() AS count,
          min(error_events_by_time.Timestamp) AS firstSeen,
          max(error_events_by_time.Timestamp) AS lastSeen
        FROM error_events_by_time
        WHERE error_events_by_time.OrgId = 'org_sql_catalog'
          AND error_events_by_time.Timestamp >= '2026-01-01 10:30:00'
          AND error_events_by_time.Timestamp < '2026-01-03 14:15:00'
        GROUP BY fingerprintHash
        FORMAT JSON

-- builder:errors:errorTickIssuesQuery:cursor-window  [55871f3d]
SELECT
          toString(error_fingerprints_minutely.FingerprintHash) AS fingerprintHash,
          any(error_fingerprints_minutely.ServiceName) AS serviceName,
          any(error_fingerprints_minutely.ExceptionType) AS exceptionType,
          any(error_fingerprints_minutely.ExceptionMessage) AS exceptionMessage,
          any(error_fingerprints_minutely.ErrorLabel) AS errorLabel,
          any(error_fingerprints_minutely.TopFrame) AS topFrame,
          groupUniqArrayArray(error_fingerprints_minutely.ServiceVersions) AS serviceVersions,
          sum(error_fingerprints_minutely.OccurrenceCount) AS count,
          min(error_fingerprints_minutely.FirstSeen) AS firstSeen,
          max(error_fingerprints_minutely.LastSeen) AS lastSeen
        FROM error_fingerprints_minutely
        WHERE error_fingerprints_minutely.OrgId = 'org_sql_catalog'
          AND error_fingerprints_minutely.Minute >= '2026-01-01 10:30:00'
          AND error_fingerprints_minutely.Minute < '2026-01-03 14:15:00'
        GROUP BY fingerprintHash
        FORMAT JSON

-- builder:errors:spanDetailQuery:default  [02aceae6]
SELECT
          trace_detail_spans.TraceId AS traceId,
          trace_detail_spans.SpanId AS spanId,
          trace_detail_spans.ParentSpanId AS parentSpanId,
          if(((trace_detail_spans.SpanName LIKE 'http.server %' OR trace_detail_spans.SpanName IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')) AND (trace_detail_spans.SpanAttributes['http.route'] != '' OR trace_detail_spans.SpanAttributes['url.path'] != '')), concat(if(trace_detail_spans.SpanName LIKE 'http.server %', replaceOne(trace_detail_spans.SpanName, 'http.server ', ''), trace_detail_spans.SpanName), ' ', if(trace_detail_spans.SpanAttributes['http.route'] != '', trace_detail_spans.SpanAttributes['http.route'], trace_detail_spans.SpanAttributes['url.path'])), trace_detail_spans.SpanName) AS spanName,
          trace_detail_spans.ServiceName AS serviceName,
          trace_detail_spans.SpanKind AS spanKind,
          trace_detail_spans.Duration / 1000000 AS durationMs,
          trace_detail_spans.Timestamp AS startTime,
          trace_detail_spans.StatusCode AS statusCode,
          trace_detail_spans.StatusMessage AS statusMessage,
          toJSONString(trace_detail_spans.SpanAttributes) AS spanAttributes,
          toJSONString(trace_detail_spans.ResourceAttributes) AS resourceAttributes
        FROM trace_detail_spans
        WHERE trace_detail_spans.TraceId = '0af7651916cd43dd8448eb211c80319c'
          AND trace_detail_spans.SpanId = 'b7ad6b7169203331'
          AND trace_detail_spans.OrgId = 'org_sql_catalog'
        LIMIT 1
        FORMAT JSON

-- builder:errors:spanDetailQuery:narrowByTime  [39008ef8]
SELECT
          trace_detail_spans.TraceId AS traceId,
          trace_detail_spans.SpanId AS spanId,
          trace_detail_spans.ParentSpanId AS parentSpanId,
          if(((trace_detail_spans.SpanName LIKE 'http.server %' OR trace_detail_spans.SpanName IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')) AND (trace_detail_spans.SpanAttributes['http.route'] != '' OR trace_detail_spans.SpanAttributes['url.path'] != '')), concat(if(trace_detail_spans.SpanName LIKE 'http.server %', replaceOne(trace_detail_spans.SpanName, 'http.server ', ''), trace_detail_spans.SpanName), ' ', if(trace_detail_spans.SpanAttributes['http.route'] != '', trace_detail_spans.SpanAttributes['http.route'], trace_detail_spans.SpanAttributes['url.path'])), trace_detail_spans.SpanName) AS spanName,
          trace_detail_spans.ServiceName AS serviceName,
          trace_detail_spans.SpanKind AS spanKind,
          trace_detail_spans.Duration / 1000000 AS durationMs,
          trace_detail_spans.Timestamp AS startTime,
          trace_detail_spans.StatusCode AS statusCode,
          trace_detail_spans.StatusMessage AS statusMessage,
          toJSONString(trace_detail_spans.SpanAttributes) AS spanAttributes,
          toJSONString(trace_detail_spans.ResourceAttributes) AS resourceAttributes
        FROM trace_detail_spans
        WHERE trace_detail_spans.TraceId = '0af7651916cd43dd8448eb211c80319c'
          AND trace_detail_spans.SpanId = 'b7ad6b7169203331'
          AND trace_detail_spans.OrgId = 'org_sql_catalog'
          AND trace_detail_spans.Timestamp >= '2026-01-01 10:30:00'
          AND trace_detail_spans.Timestamp <= '2026-01-03 14:15:00'
        LIMIT 1
        FORMAT JSON

-- builder:errors:tracesDurationStatsQuery:rollup  [b66532bf]
SELECT
          minIf(durationMin, traceCount > 0) / 1000000 AS minDurationMs,
          maxIf(durationMax, traceCount > 0) / 1000000 AS maxDurationMs,
          ifNull(ifNotFinite(arrayElement(quantilesTDigestMerge(0.5, 0.95)(durationQuantiles), 1) / 1000000, 0), 0) AS p50DurationMs,
          ifNull(ifNotFinite(arrayElement(quantilesTDigestMerge(0.5, 0.95)(durationQuantiles), 2) / 1000000, 0), 0) AS p95DurationMs
        FROM (
SELECT
          count() AS traceCount,
          min(trace_list_mv.Duration) AS durationMin,
          max(trace_list_mv.Duration) AS durationMax,
          quantilesTDigestState(0.5, 0.95)(Duration) AS durationQuantiles
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.ServiceName = 'api'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
UNION ALL
SELECT
          sum(trace_facets_hourly.TraceCount) AS traceCount,
          min(trace_facets_hourly.DurationMin) AS durationMin,
          max(trace_facets_hourly.DurationMax) AS durationMax,
          quantilesTDigestMergeState(0.5, 0.95)(DurationQuantiles) AS durationQuantiles
        FROM trace_facets_hourly
        WHERE trace_facets_hourly.OrgId = 'org_sql_catalog'
          AND trace_facets_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND trace_facets_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND trace_facets_hourly.ServiceName = 'api'
) AS duration_tiers
        FORMAT JSON

-- builder:errors:tracesFacetsQuery:rollup  [afb9c0ed]
SELECT
          service_tiers.name AS name,
          sum(service_tiers.count) AS count,
          'service' AS facetType
        FROM (
SELECT
          trace_list_mv.ServiceName AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.ServiceName = 'api'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
        GROUP BY name
UNION ALL
SELECT
          trace_facets_hourly.ServiceName AS name,
          sum(trace_facets_hourly.TraceCount) AS count
        FROM trace_facets_hourly
        WHERE trace_facets_hourly.OrgId = 'org_sql_catalog'
          AND trace_facets_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND trace_facets_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND trace_facets_hourly.ServiceName = 'api'
        GROUP BY name
) AS service_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          spanName_tiers.name AS name,
          sum(spanName_tiers.count) AS count,
          'spanName' AS facetType
        FROM (
SELECT
          trace_list_mv.SpanName AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.ServiceName = 'api'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND trace_list_mv.SpanName != ''
        GROUP BY name
UNION ALL
SELECT
          trace_facets_hourly.SpanName AS name,
          sum(trace_facets_hourly.TraceCount) AS count
        FROM trace_facets_hourly
        WHERE trace_facets_hourly.OrgId = 'org_sql_catalog'
          AND trace_facets_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND trace_facets_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND trace_facets_hourly.ServiceName = 'api'
          AND trace_facets_hourly.SpanName != ''
        GROUP BY name
) AS spanName_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          httpMethod_tiers.name AS name,
          sum(httpMethod_tiers.count) AS count,
          'httpMethod' AS facetType
        FROM (
SELECT
          trace_list_mv.HttpMethod AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.ServiceName = 'api'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND trace_list_mv.HttpMethod != ''
        GROUP BY name
UNION ALL
SELECT
          trace_facets_hourly.HttpMethod AS name,
          sum(trace_facets_hourly.TraceCount) AS count
        FROM trace_facets_hourly
        WHERE trace_facets_hourly.OrgId = 'org_sql_catalog'
          AND trace_facets_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND trace_facets_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND trace_facets_hourly.ServiceName = 'api'
          AND trace_facets_hourly.HttpMethod != ''
        GROUP BY name
) AS httpMethod_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          httpStatus_tiers.name AS name,
          sum(httpStatus_tiers.count) AS count,
          'httpStatus' AS facetType
        FROM (
SELECT
          trace_list_mv.HttpStatusCode AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.ServiceName = 'api'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND trace_list_mv.HttpStatusCode != ''
        GROUP BY name
UNION ALL
SELECT
          trace_facets_hourly.HttpStatusCode AS name,
          sum(trace_facets_hourly.TraceCount) AS count
        FROM trace_facets_hourly
        WHERE trace_facets_hourly.OrgId = 'org_sql_catalog'
          AND trace_facets_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND trace_facets_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND trace_facets_hourly.ServiceName = 'api'
          AND trace_facets_hourly.HttpStatusCode != ''
        GROUP BY name
) AS httpStatus_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          deploymentEnv_tiers.name AS name,
          sum(deploymentEnv_tiers.count) AS count,
          'deploymentEnv' AS facetType
        FROM (
SELECT
          trace_list_mv.DeploymentEnv AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.ServiceName = 'api'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND trace_list_mv.DeploymentEnv != ''
        GROUP BY name
UNION ALL
SELECT
          trace_facets_hourly.DeploymentEnv AS name,
          sum(trace_facets_hourly.TraceCount) AS count
        FROM trace_facets_hourly
        WHERE trace_facets_hourly.OrgId = 'org_sql_catalog'
          AND trace_facets_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND trace_facets_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND trace_facets_hourly.ServiceName = 'api'
          AND trace_facets_hourly.DeploymentEnv != ''
        GROUP BY name
) AS deploymentEnv_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          serviceNamespace_tiers.name AS name,
          sum(serviceNamespace_tiers.count) AS count,
          'serviceNamespace' AS facetType
        FROM (
SELECT
          trace_list_mv.ServiceNamespace AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.ServiceName = 'api'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND trace_list_mv.ServiceNamespace != ''
        GROUP BY name
UNION ALL
SELECT
          trace_facets_hourly.ServiceNamespace AS name,
          sum(trace_facets_hourly.TraceCount) AS count
        FROM trace_facets_hourly
        WHERE trace_facets_hourly.OrgId = 'org_sql_catalog'
          AND trace_facets_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND trace_facets_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND trace_facets_hourly.ServiceName = 'api'
          AND trace_facets_hourly.ServiceNamespace != ''
        GROUP BY name
) AS serviceNamespace_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          'error' AS name,
          sum(errorCount_tiers.count) AS count,
          'errorCount' AS facetType
        FROM (
SELECT
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.ServiceName = 'api'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND trace_list_mv.HasError = 1
UNION ALL
SELECT
          sum(trace_facets_hourly.TraceCount) AS count
        FROM trace_facets_hourly
        WHERE trace_facets_hourly.OrgId = 'org_sql_catalog'
          AND trace_facets_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND trace_facets_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND trace_facets_hourly.ServiceName = 'api'
          AND trace_facets_hourly.HasError = 1
) AS errorCount_tiers
FORMAT JSON

-- builder:infra:hostGaugeTimeseriesQuery:default  [b4ba966f]
SELECT
          toStartOfInterval(metrics_gauge.TimeUnix, INTERVAL 300 SECOND) AS bucket,
          '' AS attributeValue,
          avg(metrics_gauge.Value) AS avgValue
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_gauge.ResourceAttributes['host.name'] = 'ip-10-0-1-42'
          AND metrics_gauge.MetricName = 'system.cpu.utilization'
        GROUP BY bucket
        ORDER BY bucket ASC
        FORMAT JSON

-- builder:infra:hostGaugeTimeseriesQuery:grouped  [f4872e0e]
SELECT
          toStartOfInterval(metrics_gauge.TimeUnix, INTERVAL 300 SECOND) AS bucket,
          metrics_gauge.Attributes['cpu'] AS attributeValue,
          avg(metrics_gauge.Value) AS avgValue
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_gauge.ResourceAttributes['host.name'] = 'ip-10-0-1-42'
          AND metrics_gauge.MetricName = 'system.cpu.utilization'
        GROUP BY bucket, attributeValue
        ORDER BY bucket ASC
        FORMAT JSON

-- builder:infra:infraPresenceQuery:default  [efbcb230]
SELECT
          'hosts' AS surface
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_gauge.MetricName = 'system.cpu.utilization'
          AND metrics_gauge.ResourceAttributes['host.name'] != ''
        LIMIT 1
UNION ALL
SELECT
          'containers' AS surface
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_gauge.MetricName = 'container.cpu.utilization'
          AND metrics_gauge.ResourceAttributes['container.name'] != ''
        LIMIT 1
UNION ALL
SELECT
          'k8sPods' AS surface
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_gauge.MetricName = 'k8s.pod.cpu.usage'
          AND metrics_gauge.ResourceAttributes['k8s.pod.name'] != ''
        LIMIT 1
UNION ALL
SELECT
          'k8sNodes' AS surface
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_gauge.MetricName = 'k8s.node.cpu.usage'
          AND metrics_gauge.ResourceAttributes['k8s.node.name'] != ''
        LIMIT 1
UNION ALL
SELECT
          'k8sWorkloads' AS surface
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_gauge.MetricName = 'k8s.pod.cpu.usage'
          AND ((metrics_gauge.ResourceAttributes['k8s.deployment.name'] != '' OR metrics_gauge.ResourceAttributes['k8s.statefulset.name'] != '') OR metrics_gauge.ResourceAttributes['k8s.daemonset.name'] != '')
        LIMIT 1
FORMAT JSON

-- builder:infra:nodeFacetsQuery:default  [0dff8530]
SELECT
          metrics_gauge.ResourceAttributes['k8s.node.name'] AS name,
          uniq(metrics_gauge.ResourceAttributes['k8s.node.name']) AS count,
          'node' AS facetType
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_gauge.ResourceAttributes['k8s.node.name'] != ''
          AND metrics_gauge.ResourceAttributes['k8s.pod.name'] = ''
          AND metrics_gauge.MetricName IN ('k8s.node.cpu.usage')
          AND metrics_gauge.ResourceAttributes['k8s.node.name'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 200
UNION ALL
SELECT
          metrics_gauge.ResourceAttributes['k8s.cluster.name'] AS name,
          uniq(metrics_gauge.ResourceAttributes['k8s.node.name']) AS count,
          'cluster' AS facetType
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_gauge.ResourceAttributes['k8s.node.name'] != ''
          AND metrics_gauge.ResourceAttributes['k8s.pod.name'] = ''
          AND metrics_gauge.MetricName IN ('k8s.node.cpu.usage')
          AND metrics_gauge.ResourceAttributes['k8s.cluster.name'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          coalesce(nullIf(metrics_gauge.ResourceAttributes['deployment.environment.name'], ''), metrics_gauge.ResourceAttributes['deployment.environment']) AS name,
          uniq(metrics_gauge.ResourceAttributes['k8s.node.name']) AS count,
          'environment' AS facetType
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_gauge.ResourceAttributes['k8s.node.name'] != ''
          AND metrics_gauge.ResourceAttributes['k8s.pod.name'] = ''
          AND metrics_gauge.MetricName IN ('k8s.node.cpu.usage')
          AND coalesce(nullIf(metrics_gauge.ResourceAttributes['deployment.environment.name'], ''), metrics_gauge.ResourceAttributes['deployment.environment']) != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
FORMAT JSON

-- builder:infra:nodeGaugeTimeseriesQuery:default  [17477b3b]
SELECT
          toStartOfInterval(metrics_gauge.TimeUnix, INTERVAL 300 SECOND) AS bucket,
          '' AS attributeValue,
          avg(metrics_gauge.Value) AS avgValue
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_gauge.ResourceAttributes['k8s.node.name'] = 'ip-10-0-1-42.ec2.internal'
          AND metrics_gauge.ResourceAttributes['k8s.pod.name'] = ''
          AND metrics_gauge.MetricName = 'k8s.node.cpu.utilization'
        GROUP BY bucket
        ORDER BY bucket ASC
        FORMAT JSON

-- builder:infra:podFacetsQuery:default  [cc0c4122]
SELECT
          metrics_gauge.ResourceAttributes['k8s.pod.name'] AS name,
          uniq(metrics_gauge.ResourceAttributes['k8s.pod.uid']) AS count,
          'pod' AS facetType
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_gauge.ResourceAttributes['k8s.pod.name'] != ''
          AND metrics_gauge.MetricName IN ('k8s.pod.cpu.usage')
          AND metrics_gauge.ResourceAttributes['k8s.pod.name'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 200
UNION ALL
SELECT
          metrics_gauge.ResourceAttributes['k8s.namespace.name'] AS name,
          uniq(metrics_gauge.ResourceAttributes['k8s.pod.uid']) AS count,
          'namespace' AS facetType
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_gauge.ResourceAttributes['k8s.pod.name'] != ''
          AND metrics_gauge.MetricName IN ('k8s.pod.cpu.usage')
          AND metrics_gauge.ResourceAttributes['k8s.namespace.name'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 100
UNION ALL
SELECT
          metrics_gauge.ResourceAttributes['k8s.node.name'] AS name,
          uniq(metrics_gauge.ResourceAttributes['k8s.pod.uid']) AS count,
          'node' AS facetType
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_gauge.ResourceAttributes['k8s.pod.name'] != ''
          AND metrics_gauge.MetricName IN ('k8s.pod.cpu.usage')
          AND metrics_gauge.ResourceAttributes['k8s.node.name'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 100
UNION ALL
SELECT
          metrics_gauge.ResourceAttributes['k8s.cluster.name'] AS name,
          uniq(metrics_gauge.ResourceAttributes['k8s.pod.uid']) AS count,
          'cluster' AS facetType
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_gauge.ResourceAttributes['k8s.pod.name'] != ''
          AND metrics_gauge.MetricName IN ('k8s.pod.cpu.usage')
          AND metrics_gauge.ResourceAttributes['k8s.cluster.name'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          metrics_gauge.ResourceAttributes['k8s.deployment.name'] AS name,
          uniq(metrics_gauge.ResourceAttributes['k8s.pod.uid']) AS count,
          'deployment' AS facetType
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_gauge.ResourceAttributes['k8s.pod.name'] != ''
          AND metrics_gauge.MetricName IN ('k8s.pod.cpu.usage')
          AND metrics_gauge.ResourceAttributes['k8s.deployment.name'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 100
UNION ALL
SELECT
          metrics_gauge.ResourceAttributes['k8s.statefulset.name'] AS name,
          uniq(metrics_gauge.ResourceAttributes['k8s.pod.uid']) AS count,
          'statefulset' AS facetType
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_gauge.ResourceAttributes['k8s.pod.name'] != ''
          AND metrics_gauge.MetricName IN ('k8s.pod.cpu.usage')
          AND metrics_gauge.ResourceAttributes['k8s.statefulset.name'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 100
UNION ALL
SELECT
          metrics_gauge.ResourceAttributes['k8s.daemonset.name'] AS name,
          uniq(metrics_gauge.ResourceAttributes['k8s.pod.uid']) AS count,
          'daemonset' AS facetType
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_gauge.ResourceAttributes['k8s.pod.name'] != ''
          AND metrics_gauge.MetricName IN ('k8s.pod.cpu.usage')
          AND metrics_gauge.ResourceAttributes['k8s.daemonset.name'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 100
UNION ALL
SELECT
          metrics_gauge.ResourceAttributes['k8s.job.name'] AS name,
          uniq(metrics_gauge.ResourceAttributes['k8s.pod.uid']) AS count,
          'job' AS facetType
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_gauge.ResourceAttributes['k8s.pod.name'] != ''
          AND metrics_gauge.MetricName IN ('k8s.pod.cpu.usage')
          AND metrics_gauge.ResourceAttributes['k8s.job.name'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 100
UNION ALL
SELECT
          coalesce(nullIf(metrics_gauge.ResourceAttributes['deployment.environment.name'], ''), metrics_gauge.ResourceAttributes['deployment.environment']) AS name,
          uniq(metrics_gauge.ResourceAttributes['k8s.pod.uid']) AS count,
          'environment' AS facetType
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_gauge.ResourceAttributes['k8s.pod.name'] != ''
          AND metrics_gauge.MetricName IN ('k8s.pod.cpu.usage')
          AND coalesce(nullIf(metrics_gauge.ResourceAttributes['deployment.environment.name'], ''), metrics_gauge.ResourceAttributes['deployment.environment']) != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          metrics_gauge.ResourceAttributes['eks.amazonaws.com/compute-type'] AS name,
          uniq(metrics_gauge.ResourceAttributes['k8s.pod.uid']) AS count,
          'computeType' AS facetType
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_gauge.ResourceAttributes['k8s.pod.name'] != ''
          AND metrics_gauge.MetricName IN ('k8s.pod.cpu.usage')
          AND metrics_gauge.ResourceAttributes['eks.amazonaws.com/compute-type'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 10
FORMAT JSON

-- builder:infra:podGaugeTimeseriesQuery:default  [17477b3b]
SELECT
          toStartOfInterval(metrics_gauge.TimeUnix, INTERVAL 300 SECOND) AS bucket,
          '' AS attributeValue,
          avg(metrics_gauge.Value) AS avgValue
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_gauge.ResourceAttributes['k8s.pod.name'] = 'api-7d9f8b6c5-x2n4k'
          AND metrics_gauge.ResourceAttributes['k8s.namespace.name'] = 'backend'
          AND metrics_gauge.MetricName = 'k8s.pod.cpu.utilization'
        GROUP BY bucket
        ORDER BY bucket ASC
        FORMAT JSON

-- builder:infra:workloadFacetsQuery:default  [39bce5d0]
SELECT
          metrics_gauge.ResourceAttributes['k8s.deployment.name'] AS name,
          uniq(metrics_gauge.ResourceAttributes['k8s.deployment.name']) AS count,
          'workload' AS facetType
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_gauge.ResourceAttributes['k8s.deployment.name'] != ''
          AND metrics_gauge.MetricName IN ('k8s.pod.cpu.usage')
          AND metrics_gauge.ResourceAttributes['k8s.deployment.name'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 200
UNION ALL
SELECT
          metrics_gauge.ResourceAttributes['k8s.namespace.name'] AS name,
          uniq(metrics_gauge.ResourceAttributes['k8s.deployment.name']) AS count,
          'namespace' AS facetType
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_gauge.ResourceAttributes['k8s.deployment.name'] != ''
          AND metrics_gauge.MetricName IN ('k8s.pod.cpu.usage')
          AND metrics_gauge.ResourceAttributes['k8s.namespace.name'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 100
UNION ALL
SELECT
          metrics_gauge.ResourceAttributes['k8s.cluster.name'] AS name,
          uniq(metrics_gauge.ResourceAttributes['k8s.deployment.name']) AS count,
          'cluster' AS facetType
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_gauge.ResourceAttributes['k8s.deployment.name'] != ''
          AND metrics_gauge.MetricName IN ('k8s.pod.cpu.usage')
          AND metrics_gauge.ResourceAttributes['k8s.cluster.name'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          coalesce(nullIf(metrics_gauge.ResourceAttributes['deployment.environment.name'], ''), metrics_gauge.ResourceAttributes['deployment.environment']) AS name,
          uniq(metrics_gauge.ResourceAttributes['k8s.deployment.name']) AS count,
          'environment' AS facetType
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_gauge.ResourceAttributes['k8s.deployment.name'] != ''
          AND metrics_gauge.MetricName IN ('k8s.pod.cpu.usage')
          AND coalesce(nullIf(metrics_gauge.ResourceAttributes['deployment.environment.name'], ''), metrics_gauge.ResourceAttributes['deployment.environment']) != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          metrics_gauge.ResourceAttributes['eks.amazonaws.com/compute-type'] AS name,
          uniq(metrics_gauge.ResourceAttributes['k8s.deployment.name']) AS count,
          'computeType' AS facetType
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_gauge.ResourceAttributes['k8s.deployment.name'] != ''
          AND metrics_gauge.MetricName IN ('k8s.pod.cpu.usage')
          AND metrics_gauge.ResourceAttributes['eks.amazonaws.com/compute-type'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 10
FORMAT JSON

-- builder:infra:workloadGaugeTimeseriesQuery:default  [17477b3b]
SELECT
          toStartOfInterval(metrics_gauge.TimeUnix, INTERVAL 300 SECOND) AS bucket,
          '' AS attributeValue,
          avg(metrics_gauge.Value) AS avgValue
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_gauge.ResourceAttributes['k8s.deployment.name'] = 'api'
          AND metrics_gauge.ResourceAttributes['k8s.namespace.name'] = 'backend'
          AND metrics_gauge.MetricName = 'k8s.pod.cpu.utilization'
        GROUP BY bucket
        ORDER BY bucket ASC
        FORMAT JSON

-- builder:infra:workloadGaugeTimeseriesQuery:groupedByPod  [c5c669fe]
SELECT
          toStartOfInterval(metrics_gauge.TimeUnix, INTERVAL 300 SECOND) AS bucket,
          metrics_gauge.ResourceAttributes['k8s.pod.name'] AS attributeValue,
          avg(metrics_gauge.Value) AS avgValue
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_gauge.ResourceAttributes['k8s.statefulset.name'] = 'clickhouse'
          AND metrics_gauge.ResourceAttributes['k8s.namespace.name'] = 'data'
          AND metrics_gauge.MetricName = 'k8s.pod.memory.usage'
        GROUP BY bucket, attributeValue
        ORDER BY bucket ASC
        FORMAT JSON

-- builder:product-events-explore:productEventAttributeKeysQuery:default  [30a1e945]
SELECT
          arrayJoin(mapKeys(product_events.Attributes)) AS attributeKey,
          count() AS usageCount
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY attributeKey
        ORDER BY usageCount DESC
        LIMIT 200
        FORMAT JSON

-- builder:product-events-explore:productEventAttributeValuesQuery:default  [0dd2a379]
SELECT
          product_events.Attributes['plan'] AS attributeValue,
          count() AS usageCount
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND has(mapKeys(product_events.Attributes), 'plan')
        GROUP BY attributeValue
        ORDER BY usageCount DESC
        LIMIT 50
        FORMAT JSON

-- builder:product-events-explore:productEventsBreakdownQuery:sessions-by-page  [18d4c17c]
SELECT
          product_events.PagePath AS name,
          uniqIf(product_events.SessionId, product_events.SessionId != '') AS value
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Host IN ('maple.dev')
        GROUP BY name
        ORDER BY value DESC, name ASC
        LIMIT 10
        FORMAT JSON

-- builder:product-events-explore:productEventsListQuery:default  [e62f8b65]
SELECT
          product_events.Timestamp AS timestamp,
          product_events.EventName AS eventName,
          product_events.Kind AS kind,
          product_events.Source AS source,
          product_events.Host AS host,
          product_events.PagePath AS pagePath,
          product_events.Url AS url,
          product_events.ServiceName AS serviceName,
          product_events.UserId AS userId,
          product_events.GroupId AS groupId,
          product_events.VisitorId AS visitorId,
          product_events.SessionId AS sessionId,
          product_events.TraceId AS traceId,
          product_events.SpanId AS spanId,
          product_events.Attributes AS attributes,
          product_events.Seq AS seq
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind IN ('custom')
        ORDER BY timestamp DESC, seq DESC
        LIMIT 50
        FORMAT JSON

-- builder:product-events-explore:productEventsTimeseriesQuery:count  [c5a841d3]
SELECT
          toStartOfInterval(product_events.Timestamp, INTERVAL 3600 SECOND) AS bucket,
          'all' AS groupName,
          count() AS value,
          count() AS eventCount
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- builder:product-events-explore:productEventsTimeseriesQuery:persons-grouped-filtered  [a3692859]
SELECT
          bucket AS bucket,
          groupName AS groupName,
          value AS value,
          eventCount AS eventCount
        FROM (SELECT
          bucket AS bucket,
          groupName AS groupName,
          value AS value,
          eventCount AS eventCount,
          dense_rank() OVER (ORDER BY __series_peak DESC, groupName ASC) AS __series_rank
        FROM (SELECT
          bucket AS bucket,
          groupName AS groupName,
          value AS value,
          eventCount AS eventCount,
          max(value) OVER (PARTITION BY groupName) AS __series_peak
        FROM (SELECT
          toStartOfInterval(product_events.Timestamp, INTERVAL 3600 SECOND) AS bucket,
          arrayStringConcat([coalesce(nullIf(product_events.EventName, ''), '(none)'), coalesce(nullIf(product_events.Attributes['plan'], ''), '(none)')], ' · ') AS groupName,
          uniqIf(if(product_events.UserId != '', product_events.UserId, product_events.VisitorId), (product_events.UserId != '' OR product_events.VisitorId != '')) AS value,
          count() AS eventCount
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.EventName IN ('signup_completed')
          AND Attributes['plan'] = 'startup'
          AND product_events.SessionId IN (SELECT
          session_replays.SessionId AS sessionId
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.Country = 'DE'
        GROUP BY sessionId)
        GROUP BY bucket, groupName) AS __series_base) AS __series_peaks) AS __series_ranked
        WHERE __series_rank <= 5
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- builder:product-events-paths:productEventsPathsQuery:after-person  [ca42de6b]
SELECT
          mapped.hop AS hop,
          mapped.fromNode AS fromNode,
          mapped.toNode AS toNode,
          mapped.count AS count
        FROM (WITH path_hops AS (
SELECT
          edges.key AS key,
          tupleElement(edge, 1) AS hop,
          tupleElement(edge, 2) AS fromNode,
          tupleElement(edge, 3) AS toNode
        FROM (SELECT
          sequences.key AS key,
          arrayJoin(arrayMap(i -> tuple(i, arrayElement(seq, i), if(i < length(seq), arrayElement(seq, i + 1), '')), arrayEnumerate(seq))) AS edge
        FROM (SELECT
          per_person.key AS key,
          arrayFirstIndex(x -> x.4 = 1, evs) AS anchorIdx,
          arraySlice(arrayCompact(arrayMap(x -> x.3, arraySlice(evs, anchorIdx))), 1, 4) AS seq
        FROM (SELECT
          path_events.key AS key,
          arraySort(x -> (x.1, x.2), groupArray(tuple(ts, seq, name, isAnchor))) AS evs
        FROM (SELECT
          r.key AS key,
          r.ts AS ts,
          r.seq AS seq,
          r.name AS name,
          r.isAnchor AS isAnchor
        FROM (SELECT
          multiIf(e.UserId != '', e.UserId, coalesce(link.UserId, '') != '', coalesce(link.UserId, ''), e.VisitorId) AS key,
          toUInt64(toUnixTimestamp64Milli(e.Timestamp)) AS ts,
          e.Seq AS seq,
          e.Kind AS kind,
          if(e.Kind = 'navigation', e.PagePath, e.EventName) AS name,
          toUInt8(e.EventName = 'signup_completed') AS isAnchor
        FROM product_events AS e
        LEFT JOIN (SELECT
          pair_links.VisitorId AS VisitorId,
          argMin(pair_links.UserId, pair_links.FirstSeen) AS UserId
        FROM (SELECT
          identity_links.VisitorId AS VisitorId,
          identity_links.UserId AS UserId,
          min(identity_links.FirstSeen) AS FirstSeen
        FROM identity_links
        WHERE identity_links.OrgId = 'org_sql_catalog'
        GROUP BY VisitorId, UserId) AS pair_links
        GROUP BY VisitorId) AS link ON e.VisitorId = link.VisitorId
        WHERE e.OrgId = 'org_sql_catalog'
          AND e.Timestamp >= '2026-01-01 10:30:00'
          AND e.Timestamp <= '2026-01-03 14:15:00'
          AND multiIf(e.UserId != '', e.UserId, coalesce(link.UserId, '') != '', coalesce(link.UserId, ''), e.VisitorId) != '') AS r
        INNER JOIN (SELECT
          multiIf(e.UserId != '', e.UserId, coalesce(link.UserId, '') != '', coalesce(link.UserId, ''), e.VisitorId) AS key,
          min(toUInt64(toUnixTimestamp64Milli(e.Timestamp))) AS anchorTs
        FROM product_events AS e
        LEFT JOIN (SELECT
          pair_links.VisitorId AS VisitorId,
          argMin(pair_links.UserId, pair_links.FirstSeen) AS UserId
        FROM (SELECT
          identity_links.VisitorId AS VisitorId,
          identity_links.UserId AS UserId,
          min(identity_links.FirstSeen) AS FirstSeen
        FROM identity_links
        WHERE identity_links.OrgId = 'org_sql_catalog'
        GROUP BY VisitorId, UserId) AS pair_links
        GROUP BY VisitorId) AS link ON e.VisitorId = link.VisitorId
        WHERE e.OrgId = 'org_sql_catalog'
          AND e.Timestamp >= '2026-01-01 10:30:00'
          AND e.Timestamp <= '2026-01-03 14:15:00'
          AND multiIf(e.UserId != '', e.UserId, coalesce(link.UserId, '') != '', coalesce(link.UserId, ''), e.VisitorId) != ''
          AND e.EventName = 'signup_completed'
        GROUP BY key) AS a ON r.key = a.key
        WHERE r.ts >= a.anchorTs
          AND r.ts <= a.anchorTs + 86400000
          AND (r.isAnchor = 1 OR r.name NOT IN ('heartbeat', '/'))) AS path_events
        GROUP BY key) AS per_person
        WHERE anchorIdx > 0) AS sequences) AS edges
        WHERE tupleElement(edge, 1) <= 3
)
SELECT
          h.hop AS hop,
          multiIf(h.hop = 1, h.fromNode, coalesce(kf.name, '') != '', h.fromNode, '$other') AS fromNode,
          multiIf(h.toNode = '', '', coalesce(kt.name, '') != '', h.toNode, '$other') AS toNode,
          count() AS count
        FROM path_hops AS h
        LEFT JOIN (SELECT
          kept_entries.hop AS hop,
          kept_entries.hop + 1 AS nextHop,
          tupleElement(entry, 1) AS name
        FROM (SELECT
          ranked.hop AS hop,
          arrayJoin(head) AS entry
        FROM (SELECT
          node_counts.hop AS hop,
          arraySlice(arrayReverseSort(x -> x.2, groupArray(tuple(name, n))), 1, 4) AS head
        FROM (SELECT
          path_hops.hop AS hop,
          path_hops.toNode AS name,
          count() AS n
        FROM path_hops
        WHERE path_hops.toNode != ''
        GROUP BY hop, name) AS node_counts
        GROUP BY hop) AS ranked) AS kept_entries) AS kf ON (h.hop = kf.nextHop AND h.fromNode = kf.name)
        LEFT JOIN (SELECT
          kept_entries.hop AS hop,
          kept_entries.hop + 1 AS nextHop,
          tupleElement(entry, 1) AS name
        FROM (SELECT
          ranked.hop AS hop,
          arrayJoin(head) AS entry
        FROM (SELECT
          node_counts.hop AS hop,
          arraySlice(arrayReverseSort(x -> x.2, groupArray(tuple(name, n))), 1, 4) AS head
        FROM (SELECT
          path_hops.hop AS hop,
          path_hops.toNode AS name,
          count() AS n
        FROM path_hops
        WHERE path_hops.toNode != ''
        GROUP BY hop, name) AS node_counts
        GROUP BY hop) AS ranked) AS kept_entries) AS kt ON (h.hop = kt.hop AND h.toNode = kt.name)
        GROUP BY hop, fromNode, toNode) AS mapped
        ORDER BY hop ASC, count DESC, fromNode ASC, toNode ASC
        FORMAT JSON

-- builder:product-events-paths:productEventsPathsQuery:before-session-pages-filtered  [59eef311]
SELECT
          mapped.hop AS hop,
          mapped.fromNode AS fromNode,
          mapped.toNode AS toNode,
          mapped.count AS count
        FROM (WITH path_hops AS (
SELECT
          edges.key AS key,
          tupleElement(edge, 1) AS hop,
          tupleElement(edge, 2) AS fromNode,
          tupleElement(edge, 3) AS toNode
        FROM (SELECT
          sequences.key AS key,
          arrayJoin(arrayMap(i -> tuple(i, arrayElement(seq, i), if(i < length(seq), arrayElement(seq, i + 1), '')), arrayEnumerate(seq))) AS edge
        FROM (SELECT
          per_person.key AS key,
          arrayFirstIndex(x -> x.4 = 1, arrayReverse(evs)) AS anchorIdx,
          arraySlice(arrayCompact(arrayMap(x -> x.3, arraySlice(arrayReverse(evs), anchorIdx))), 1, 3) AS seq
        FROM (SELECT
          path_events.key AS key,
          arraySort(x -> (x.1, x.2), groupArray(tuple(ts, seq, name, isAnchor))) AS evs
        FROM (SELECT
          r.key AS key,
          r.ts AS ts,
          r.seq AS seq,
          r.name AS name,
          r.isAnchor AS isAnchor
        FROM (SELECT
          e.SessionId AS key,
          toUInt64(toUnixTimestamp64Milli(e.Timestamp)) AS ts,
          e.Seq AS seq,
          e.Kind AS kind,
          if(e.Kind = 'navigation', e.PagePath, e.EventName) AS name,
          toUInt8(((e.Kind = 'navigation' AND e.PagePath = '/pricing') AND e.Host = 'maple.dev')) AS isAnchor
        FROM product_events AS e
        WHERE e.OrgId = 'org_sql_catalog'
          AND e.Timestamp >= '2026-01-01 10:30:00'
          AND e.Timestamp <= '2026-01-03 14:15:00'
          AND e.SessionId != ''
          AND e.SessionId IN (SELECT
          session_replays.SessionId AS key
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS sessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'navigation'
          AND product_events.Host = 'maple.dev'
          AND product_events.PagePath = '/pricing'
        GROUP BY sessionId)
          AND session_replays.ReferrerHost = 't.co'
          AND session_replays.Country = 'DE'
          AND session_replays.DeviceType = 'desktop'
          AND session_replays.BrowserName = 'Chrome'
          AND session_replays.OsName = 'macOS'
          AND session_replays.Language = 'en-US'
          AND session_replays.UtmSource = 'twitter'
          AND session_replays.UtmMedium = 'social'
          AND session_replays.UtmCampaign = 'launch'
          AND session_replays.VisitorIsNew = 1
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS sessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'custom'
          AND product_events.EventName = 'signup_started'
        GROUP BY sessionId)
        GROUP BY key)) AS r
        INNER JOIN (SELECT
          e.SessionId AS key,
          max(toUInt64(toUnixTimestamp64Milli(e.Timestamp))) AS anchorTs
        FROM product_events AS e
        WHERE e.OrgId = 'org_sql_catalog'
          AND e.Timestamp >= '2026-01-01 10:30:00'
          AND e.Timestamp <= '2026-01-03 14:15:00'
          AND e.SessionId != ''
          AND e.SessionId IN (SELECT
          session_replays.SessionId AS key
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS sessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'navigation'
          AND product_events.Host = 'maple.dev'
          AND product_events.PagePath = '/pricing'
        GROUP BY sessionId)
          AND session_replays.ReferrerHost = 't.co'
          AND session_replays.Country = 'DE'
          AND session_replays.DeviceType = 'desktop'
          AND session_replays.BrowserName = 'Chrome'
          AND session_replays.OsName = 'macOS'
          AND session_replays.Language = 'en-US'
          AND session_replays.UtmSource = 'twitter'
          AND session_replays.UtmMedium = 'social'
          AND session_replays.UtmCampaign = 'launch'
          AND session_replays.VisitorIsNew = 1
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS sessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'custom'
          AND product_events.EventName = 'signup_started'
        GROUP BY sessionId)
        GROUP BY key)
          AND ((e.Kind = 'navigation' AND e.PagePath = '/pricing') AND e.Host = 'maple.dev')
        GROUP BY key) AS a ON r.key = a.key
        WHERE r.ts <= a.anchorTs
          AND r.ts >= a.anchorTs - 3600000
          AND (r.isAnchor = 1 OR r.kind = 'navigation')) AS path_events
        GROUP BY key) AS per_person
        WHERE anchorIdx > 0) AS sequences) AS edges
        WHERE tupleElement(edge, 1) <= 2
)
SELECT
          h.hop AS hop,
          multiIf(h.hop = 1, h.fromNode, coalesce(kf.name, '') != '', h.fromNode, '$other') AS fromNode,
          multiIf(h.toNode = '', '', coalesce(kt.name, '') != '', h.toNode, '$other') AS toNode,
          count() AS count
        FROM path_hops AS h
        LEFT JOIN (SELECT
          kept_entries.hop AS hop,
          kept_entries.hop + 1 AS nextHop,
          tupleElement(entry, 1) AS name
        FROM (SELECT
          ranked.hop AS hop,
          arrayJoin(head) AS entry
        FROM (SELECT
          node_counts.hop AS hop,
          arraySlice(arrayReverseSort(x -> x.2, groupArray(tuple(name, n))), 1, 3) AS head
        FROM (SELECT
          path_hops.hop AS hop,
          path_hops.toNode AS name,
          count() AS n
        FROM path_hops
        WHERE path_hops.toNode != ''
        GROUP BY hop, name) AS node_counts
        GROUP BY hop) AS ranked) AS kept_entries) AS kf ON (h.hop = kf.nextHop AND h.fromNode = kf.name)
        LEFT JOIN (SELECT
          kept_entries.hop AS hop,
          kept_entries.hop + 1 AS nextHop,
          tupleElement(entry, 1) AS name
        FROM (SELECT
          ranked.hop AS hop,
          arrayJoin(head) AS entry
        FROM (SELECT
          node_counts.hop AS hop,
          arraySlice(arrayReverseSort(x -> x.2, groupArray(tuple(name, n))), 1, 3) AS head
        FROM (SELECT
          path_hops.hop AS hop,
          path_hops.toNode AS name,
          count() AS n
        FROM path_hops
        WHERE path_hops.toNode != ''
        GROUP BY hop, name) AS node_counts
        GROUP BY hop) AS ranked) AS kept_entries) AS kt ON (h.hop = kt.hop AND h.toNode = kt.name)
        GROUP BY hop, fromNode, toNode) AS mapped
        ORDER BY hop ASC, count DESC, fromNode ASC, toNode ASC
        FORMAT JSON

-- builder:product-events:productEventNamesQuery:default  [1562ead5]
SELECT
          product_events.EventName AS eventName,
          product_events.Kind AS kind,
          count() AS count,
          uniqIf(product_events.SessionId, product_events.SessionId != '') AS sessions,
          uniq(if(product_events.UserId != '', product_events.UserId, product_events.VisitorId)) AS persons
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY eventName, kind
        ORDER BY count DESC, eventName ASC
        LIMIT 100
        FORMAT JSON

-- builder:product-events:productEventNamesQuery:filtered  [d2ec0a20]
SELECT
          product_events.EventName AS eventName,
          product_events.Kind AS kind,
          count() AS count,
          uniqIf(product_events.SessionId, product_events.SessionId != '') AS sessions,
          uniq(if(product_events.UserId != '', product_events.UserId, product_events.VisitorId)) AS persons
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Host = 'maple.dev'
          AND product_events.SessionId IN (SELECT
          session_replays.SessionId AS sessionId
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS sessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'navigation'
          AND product_events.PagePath = '/pricing'
        GROUP BY sessionId)
          AND session_replays.ReferrerHost = 't.co'
          AND session_replays.Country = 'DE'
          AND session_replays.DeviceType = 'desktop'
          AND session_replays.BrowserName = 'Chrome'
          AND session_replays.OsName = 'macOS'
          AND session_replays.Language = 'en-US'
          AND session_replays.UtmSource = 'twitter'
          AND session_replays.UtmMedium = 'social'
          AND session_replays.UtmCampaign = 'launch'
          AND session_replays.VisitorIsNew = 1
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS sessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'custom'
          AND product_events.EventName = 'signup_started'
        GROUP BY sessionId)
        GROUP BY sessionId)
        GROUP BY eventName, kind
        ORDER BY count DESC, eventName ASC
        LIMIT 100
        FORMAT JSON

-- builder:product-events:productEventsForTraceQuery:default  [b12db331]
SELECT
          product_events.Timestamp AS timestamp,
          product_events.EventName AS eventName,
          product_events.SpanId AS spanId,
          product_events.ServiceName AS serviceName,
          product_events.UserId AS userId,
          product_events.GroupId AS groupId,
          product_events.VisitorId AS visitorId,
          product_events.SessionId AS sessionId,
          product_events.Attributes AS attributes
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.TraceId = '4bf92f3577b34da6a3ce929d0e0e4736'
        ORDER BY timestamp ASC, spanId ASC
        LIMIT 50
        FORMAT JSON

-- builder:product-events:productEventsFunnelBreakdownQuery:attribute-session-step  [b3496b8e]
SELECT
          groups.group AS group,
          arrayJoin([1, 2, 3, 4]) AS step,
          arrayElement(groups.counts, step) AS count
        FROM (SELECT
          group AS group,
          [countIf(level >= 1), countIf(level >= 2), countIf(level >= 3), countIf(level >= 4)] AS counts,
          countIf(level >= 1) AS entered
        FROM (SELECT
          funnel_events.key AS key,
          windowFunnel(604800000)(funnel_events.ts, funnel_events.s1 = 1, funnel_events.s2 = 1, funnel_events.s3 = 1, funnel_events.s4 = 1) AS level,
          argMinIf(funnel_events.dim, funnel_events.ts, funnel_events.dim != '') AS group
        FROM (
SELECT
          s.UserId AS key,
          toUInt64(toUnixTimestamp64Milli(s.StartTime)) AS ts,
          0 AS seq,
          1 AS s1,
          0 AS s2,
          0 AS s3,
          0 AS s4,
          '' AS dim
        FROM session_replays AS s
        WHERE s.OrgId = 'org_sql_catalog'
          AND s.StartTime >= '2026-01-01 10:30:00'
          AND s.StartTime <= '2026-01-03 14:15:00'
          AND s.ReferrerHost = 'news.ycombinator.com'
          AND s.UserId != ''
UNION ALL
SELECT
          e.UserId AS key,
          toUInt64(toUnixTimestamp64Milli(e.Timestamp)) AS ts,
          e.Seq AS seq,
          0 AS s1,
          toUInt8(((e.Kind = 'navigation' AND e.PagePath = '/pricing') AND e.Host = 'maple.dev')) AS s2,
          toUInt8(e.EventName = 'signup_completed') AS s3,
          toUInt8((e.EventName = 'plan_started' AND e.Attributes['plan'] = 'startup')) AS s4,
          e.Attributes['plan'] AS dim
        FROM product_events AS e
        WHERE e.OrgId = 'org_sql_catalog'
          AND e.Timestamp >= '2026-01-01 10:30:00'
          AND e.Timestamp <= '2026-01-03 14:15:00'
          AND ((((e.Kind = 'navigation' AND e.PagePath = '/pricing') AND e.Host = 'maple.dev') OR e.EventName = 'signup_completed') OR (e.EventName = 'plan_started' AND e.Attributes['plan'] = 'startup'))
          AND e.UserId != ''
) AS funnel_events
        GROUP BY key) AS levels
        GROUP BY group
        ORDER BY entered DESC, group ASC
        LIMIT 5) AS groups
        ORDER BY group ASC, step ASC
        FORMAT JSON

-- builder:product-events:productEventsFunnelBreakdownQuery:session-dimension  [bb00cfab]
SELECT
          groups.group AS group,
          arrayJoin([1, 2, 3]) AS step,
          arrayElement(groups.counts, step) AS count
        FROM (SELECT
          group AS group,
          [countIf(level >= 1), countIf(level >= 2), countIf(level >= 3)] AS counts,
          countIf(level >= 1) AS entered
        FROM (SELECT
          funnel_events.key AS key,
          windowFunnel(604800000)(funnel_events.ts, funnel_events.s1 = 1, funnel_events.s2 = 1, funnel_events.s3 = 1) AS level,
          argMinIf(funnel_events.dim, funnel_events.ts, funnel_events.dim != '') AS group
        FROM (SELECT
          multiIf(e.UserId != '', e.UserId, coalesce(link.UserId, '') != '', coalesce(link.UserId, ''), e.VisitorId) AS key,
          toUInt64(toUnixTimestamp64Milli(e.Timestamp)) AS ts,
          e.Seq AS seq,
          toUInt8(((e.Kind = 'navigation' AND e.PagePath = '/pricing') AND e.Host = 'maple.dev')) AS s1,
          toUInt8(e.EventName = 'signup_completed') AS s2,
          toUInt8((e.EventName = 'plan_started' AND e.Attributes['plan'] = 'startup')) AS s3,
          coalesce(sd.Value, '') AS dim
        FROM product_events AS e
        LEFT JOIN (SELECT
          pair_links.VisitorId AS VisitorId,
          argMin(pair_links.UserId, pair_links.FirstSeen) AS UserId
        FROM (SELECT
          identity_links.VisitorId AS VisitorId,
          identity_links.UserId AS UserId,
          min(identity_links.FirstSeen) AS FirstSeen
        FROM identity_links
        WHERE identity_links.OrgId = 'org_sql_catalog'
        GROUP BY VisitorId, UserId) AS pair_links
        GROUP BY VisitorId) AS link ON e.VisitorId = link.VisitorId
        LEFT JOIN (SELECT
          session_replays.SessionId AS SessionId,
          max(session_replays.UtmSource) AS Value
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
        GROUP BY SessionId) AS sd ON e.SessionId = sd.SessionId
        WHERE e.OrgId = 'org_sql_catalog'
          AND e.Timestamp >= '2026-01-01 10:30:00'
          AND e.Timestamp <= '2026-01-03 14:15:00'
          AND ((((e.Kind = 'navigation' AND e.PagePath = '/pricing') AND e.Host = 'maple.dev') OR e.EventName = 'signup_completed') OR (e.EventName = 'plan_started' AND e.Attributes['plan'] = 'startup'))
          AND multiIf(e.UserId != '', e.UserId, coalesce(link.UserId, '') != '', coalesce(link.UserId, ''), e.VisitorId) != '') AS funnel_events
        GROUP BY key) AS levels
        GROUP BY group
        ORDER BY entered DESC, group ASC
        LIMIT 10) AS groups
        ORDER BY group ASC, step ASC
        FORMAT JSON

-- builder:product-events:productEventsFunnelLeaversQuery:visitor-filtered  [ad6d68b1]
SELECT
          hops.step AS step,
          tupleElement(hop, 1) AS next,
          tupleElement(hop, 2) AS count
        FROM (SELECT
          ranked.step AS step,
          arrayJoin(head) AS hop
        FROM (SELECT
          counted.step AS step,
          arraySlice(arrayReverseSort(x -> x.2, groupArray(tuple(next, count))), 1, 6) AS head
        FROM (SELECT
          nexts.step AS step,
          nexts.next AS next,
          count() AS count
        FROM (SELECT
          e.key AS key,
          d.step AS step,
          argMinIf(e.name, e.ts, e.ts > d.tLast) AS next
        FROM (SELECT
          e.VisitorId AS key,
          toUInt64(toUnixTimestamp64Milli(e.Timestamp)) AS ts,
          if(e.Kind = 'navigation', e.PagePath, e.EventName) AS name
        FROM product_events AS e
        WHERE e.OrgId = 'org_sql_catalog'
          AND e.Timestamp >= '2026-01-01 10:30:00'
          AND e.Timestamp <= '2026-01-03 14:15:00'
          AND e.VisitorId != ''
          AND e.VisitorId IN (SELECT
          session_replays.VisitorId AS key
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS sessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'navigation'
          AND product_events.Host = 'maple.dev'
          AND product_events.PagePath = '/pricing'
        GROUP BY sessionId)
          AND session_replays.ReferrerHost = 't.co'
          AND session_replays.Country = 'DE'
          AND session_replays.DeviceType = 'desktop'
          AND session_replays.BrowserName = 'Chrome'
          AND session_replays.OsName = 'macOS'
          AND session_replays.Language = 'en-US'
          AND session_replays.UtmSource = 'twitter'
          AND session_replays.UtmMedium = 'social'
          AND session_replays.UtmCampaign = 'launch'
          AND session_replays.VisitorIsNew = 1
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS sessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'custom'
          AND product_events.EventName = 'signup_started'
        GROUP BY sessionId)
        GROUP BY key)) AS e
        INNER JOIN (SELECT
          chain.key AS key,
          chain.level + 1 AS step,
          arrayElement([t1, t2, t3], level) AS tLast
        FROM (SELECT
          chain_events.key AS key,
          chain_events.level AS level,
          tupleElement(arrayFirst(x -> x.3 = 1, evs), 1) AS t1,
          tupleElement(arrayFirst(x -> t1 > 0 AND x.4 = 1 AND x.1 >= t1 AND x.1 <= t1 + 604800000, evs), 1) AS t2,
          tupleElement(arrayFirst(x -> t2 > 0 AND x.5 = 1 AND x.1 >= t2 AND x.1 <= t1 + 604800000, evs), 1) AS t3
        FROM (SELECT
          funnel_events.key AS key,
          windowFunnel(604800000)(funnel_events.ts, funnel_events.s1 = 1, funnel_events.s2 = 1, funnel_events.s3 = 1) AS level,
          arraySort(x -> (x.1, x.2), groupArray(tuple(ts, seq, s1, s2, s3))) AS evs
        FROM (SELECT
          e.VisitorId AS key,
          toUInt64(toUnixTimestamp64Milli(e.Timestamp)) AS ts,
          e.Seq AS seq,
          toUInt8(((e.Kind = 'navigation' AND e.PagePath = '/pricing') AND e.Host = 'maple.dev')) AS s1,
          toUInt8(e.EventName = 'signup_completed') AS s2,
          toUInt8((e.EventName = 'plan_started' AND e.Attributes['plan'] = 'startup')) AS s3
        FROM product_events AS e
        WHERE e.OrgId = 'org_sql_catalog'
          AND e.Timestamp >= '2026-01-01 10:30:00'
          AND e.Timestamp <= '2026-01-03 14:15:00'
          AND ((((e.Kind = 'navigation' AND e.PagePath = '/pricing') AND e.Host = 'maple.dev') OR e.EventName = 'signup_completed') OR (e.EventName = 'plan_started' AND e.Attributes['plan'] = 'startup'))
          AND e.VisitorId != ''
          AND e.VisitorId IN (SELECT
          session_replays.VisitorId AS key
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS sessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'navigation'
          AND product_events.Host = 'maple.dev'
          AND product_events.PagePath = '/pricing'
        GROUP BY sessionId)
          AND session_replays.ReferrerHost = 't.co'
          AND session_replays.Country = 'DE'
          AND session_replays.DeviceType = 'desktop'
          AND session_replays.BrowserName = 'Chrome'
          AND session_replays.OsName = 'macOS'
          AND session_replays.Language = 'en-US'
          AND session_replays.UtmSource = 'twitter'
          AND session_replays.UtmMedium = 'social'
          AND session_replays.UtmCampaign = 'launch'
          AND session_replays.VisitorIsNew = 1
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS sessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'custom'
          AND product_events.EventName = 'signup_started'
        GROUP BY sessionId)
        GROUP BY key)) AS funnel_events
        GROUP BY key) AS chain_events) AS chain
        WHERE chain.level >= 1
          AND chain.level < 3
          AND arrayElement([t1, t2, t3], level) > 0) AS d ON e.key = d.key
        GROUP BY key, step) AS nexts
        GROUP BY step, next) AS counted
        GROUP BY step) AS ranked) AS hops
        ORDER BY step ASC, count DESC, next ASC
        FORMAT JSON

-- builder:product-events:productEventsFunnelQuery:person  [0ee5feae]
SELECT
          arrayJoin([1, 2, 3]) AS step,
          arrayElement(totals.counts, step) AS count
        FROM (SELECT
          [countIf(level >= 1), countIf(level >= 2), countIf(level >= 3)] AS counts
        FROM (SELECT
          funnel_events.key AS key,
          windowFunnel(604800000)(funnel_events.ts, funnel_events.s1 = 1, funnel_events.s2 = 1, funnel_events.s3 = 1) AS level
        FROM (SELECT
          multiIf(e.UserId != '', e.UserId, coalesce(link.UserId, '') != '', coalesce(link.UserId, ''), e.VisitorId) AS key,
          toUInt64(toUnixTimestamp64Milli(e.Timestamp)) AS ts,
          e.Seq AS seq,
          toUInt8(((e.Kind = 'navigation' AND e.PagePath = '/pricing') AND e.Host = 'maple.dev')) AS s1,
          toUInt8(e.EventName = 'signup_completed') AS s2,
          toUInt8((e.EventName = 'plan_started' AND e.Attributes['plan'] = 'startup')) AS s3
        FROM product_events AS e
        LEFT JOIN (SELECT
          pair_links.VisitorId AS VisitorId,
          argMin(pair_links.UserId, pair_links.FirstSeen) AS UserId
        FROM (SELECT
          identity_links.VisitorId AS VisitorId,
          identity_links.UserId AS UserId,
          min(identity_links.FirstSeen) AS FirstSeen
        FROM identity_links
        WHERE identity_links.OrgId = 'org_sql_catalog'
        GROUP BY VisitorId, UserId) AS pair_links
        GROUP BY VisitorId) AS link ON e.VisitorId = link.VisitorId
        WHERE e.OrgId = 'org_sql_catalog'
          AND e.Timestamp >= '2026-01-01 10:30:00'
          AND e.Timestamp <= '2026-01-03 14:15:00'
          AND ((((e.Kind = 'navigation' AND e.PagePath = '/pricing') AND e.Host = 'maple.dev') OR e.EventName = 'signup_completed') OR (e.EventName = 'plan_started' AND e.Attributes['plan'] = 'startup'))
          AND multiIf(e.UserId != '', e.UserId, coalesce(link.UserId, '') != '', coalesce(link.UserId, ''), e.VisitorId) != '') AS funnel_events
        GROUP BY key) AS levels) AS totals
        ORDER BY step ASC
        FORMAT JSON

-- builder:product-events:productEventsFunnelQuery:session-key  [76d377e9]
SELECT
          arrayJoin([1, 2, 3]) AS step,
          arrayElement(totals.counts, step) AS count
        FROM (SELECT
          [countIf(level >= 1), countIf(level >= 2), countIf(level >= 3)] AS counts
        FROM (SELECT
          funnel_events.key AS key,
          windowFunnel(1800000)(funnel_events.ts, funnel_events.s1 = 1, funnel_events.s2 = 1, funnel_events.s3 = 1) AS level
        FROM (SELECT
          e.SessionId AS key,
          toUInt64(toUnixTimestamp64Milli(e.Timestamp)) AS ts,
          e.Seq AS seq,
          toUInt8(((e.Kind = 'navigation' AND e.PagePath = '/pricing') AND e.Host = 'maple.dev')) AS s1,
          toUInt8(e.EventName = 'signup_completed') AS s2,
          toUInt8((e.EventName = 'plan_started' AND e.Attributes['plan'] = 'startup')) AS s3
        FROM product_events AS e
        WHERE e.OrgId = 'org_sql_catalog'
          AND e.Timestamp >= '2026-01-01 10:30:00'
          AND e.Timestamp <= '2026-01-03 14:15:00'
          AND ((((e.Kind = 'navigation' AND e.PagePath = '/pricing') AND e.Host = 'maple.dev') OR e.EventName = 'signup_completed') OR (e.EventName = 'plan_started' AND e.Attributes['plan'] = 'startup'))
          AND e.SessionId != '') AS funnel_events
        GROUP BY key) AS levels) AS totals
        ORDER BY step ASC
        FORMAT JSON

-- builder:product-events:productEventsFunnelQuery:session-step-filtered  [dbec8c07]
SELECT
          arrayJoin([1, 2, 3, 4]) AS step,
          arrayElement(totals.counts, step) AS count
        FROM (SELECT
          [countIf(level >= 1), countIf(level >= 2), countIf(level >= 3), countIf(level >= 4)] AS counts
        FROM (SELECT
          funnel_events.key AS key,
          windowFunnel(604800000)(funnel_events.ts, funnel_events.s1 = 1, funnel_events.s2 = 1, funnel_events.s3 = 1, funnel_events.s4 = 1) AS level
        FROM (
SELECT
          multiIf(s.UserId != '', s.UserId, coalesce(link.UserId, '') != '', coalesce(link.UserId, ''), s.VisitorId) AS key,
          toUInt64(toUnixTimestamp64Milli(s.StartTime)) AS ts,
          0 AS seq,
          1 AS s1,
          0 AS s2,
          0 AS s3,
          0 AS s4
        FROM session_replays AS s
        LEFT JOIN (SELECT
          pair_links.VisitorId AS VisitorId,
          argMin(pair_links.UserId, pair_links.FirstSeen) AS UserId
        FROM (SELECT
          identity_links.VisitorId AS VisitorId,
          identity_links.UserId AS UserId,
          min(identity_links.FirstSeen) AS FirstSeen
        FROM identity_links
        WHERE identity_links.OrgId = 'org_sql_catalog'
        GROUP BY VisitorId, UserId) AS pair_links
        GROUP BY VisitorId) AS link ON s.VisitorId = link.VisitorId
        WHERE s.OrgId = 'org_sql_catalog'
          AND s.StartTime >= '2026-01-01 10:30:00'
          AND s.StartTime <= '2026-01-03 14:15:00'
          AND s.ReferrerHost = 'news.ycombinator.com'
          AND multiIf(s.UserId != '', s.UserId, coalesce(link.UserId, '') != '', coalesce(link.UserId, ''), s.VisitorId) != ''
          AND multiIf(s.UserId != '', s.UserId, coalesce(link.UserId, '') != '', coalesce(link.UserId, ''), s.VisitorId) IN (SELECT
          multiIf(s.UserId != '', s.UserId, coalesce(link.UserId, '') != '', coalesce(link.UserId, ''), s.VisitorId) AS key
        FROM session_replays AS s
        LEFT JOIN (SELECT
          pair_links.VisitorId AS VisitorId,
          argMin(pair_links.UserId, pair_links.FirstSeen) AS UserId
        FROM (SELECT
          identity_links.VisitorId AS VisitorId,
          identity_links.UserId AS UserId,
          min(identity_links.FirstSeen) AS FirstSeen
        FROM identity_links
        WHERE identity_links.OrgId = 'org_sql_catalog'
        GROUP BY VisitorId, UserId) AS pair_links
        GROUP BY VisitorId) AS link ON s.VisitorId = link.VisitorId
        WHERE s.OrgId = 'org_sql_catalog'
          AND s.StartTime >= '2026-01-01 10:30:00'
          AND s.StartTime <= '2026-01-03 14:15:00'
          AND s.SessionId IN (SELECT
          product_events.SessionId AS sessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'navigation'
          AND product_events.Host = 'maple.dev'
          AND product_events.PagePath = '/pricing'
        GROUP BY sessionId)
          AND s.ReferrerHost = 't.co'
          AND s.Country = 'DE'
          AND s.DeviceType = 'desktop'
          AND s.BrowserName = 'Chrome'
          AND s.OsName = 'macOS'
          AND s.Language = 'en-US'
          AND s.UtmSource = 'twitter'
          AND s.UtmMedium = 'social'
          AND s.UtmCampaign = 'launch'
          AND s.VisitorIsNew = 1
          AND s.SessionId IN (SELECT
          product_events.SessionId AS sessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'custom'
          AND product_events.EventName = 'signup_started'
        GROUP BY sessionId)
        GROUP BY key)
UNION ALL
SELECT
          multiIf(e.UserId != '', e.UserId, coalesce(link.UserId, '') != '', coalesce(link.UserId, ''), e.VisitorId) AS key,
          toUInt64(toUnixTimestamp64Milli(e.Timestamp)) AS ts,
          e.Seq AS seq,
          0 AS s1,
          toUInt8(((e.Kind = 'navigation' AND e.PagePath = '/pricing') AND e.Host = 'maple.dev')) AS s2,
          toUInt8(e.EventName = 'signup_completed') AS s3,
          toUInt8((e.EventName = 'plan_started' AND e.Attributes['plan'] = 'startup')) AS s4
        FROM product_events AS e
        LEFT JOIN (SELECT
          pair_links.VisitorId AS VisitorId,
          argMin(pair_links.UserId, pair_links.FirstSeen) AS UserId
        FROM (SELECT
          identity_links.VisitorId AS VisitorId,
          identity_links.UserId AS UserId,
          min(identity_links.FirstSeen) AS FirstSeen
        FROM identity_links
        WHERE identity_links.OrgId = 'org_sql_catalog'
        GROUP BY VisitorId, UserId) AS pair_links
        GROUP BY VisitorId) AS link ON e.VisitorId = link.VisitorId
        WHERE e.OrgId = 'org_sql_catalog'
          AND e.Timestamp >= '2026-01-01 10:30:00'
          AND e.Timestamp <= '2026-01-03 14:15:00'
          AND ((((e.Kind = 'navigation' AND e.PagePath = '/pricing') AND e.Host = 'maple.dev') OR e.EventName = 'signup_completed') OR (e.EventName = 'plan_started' AND e.Attributes['plan'] = 'startup'))
          AND multiIf(e.UserId != '', e.UserId, coalesce(link.UserId, '') != '', coalesce(link.UserId, ''), e.VisitorId) != ''
          AND multiIf(e.UserId != '', e.UserId, coalesce(link.UserId, '') != '', coalesce(link.UserId, ''), e.VisitorId) IN (SELECT
          multiIf(s.UserId != '', s.UserId, coalesce(link.UserId, '') != '', coalesce(link.UserId, ''), s.VisitorId) AS key
        FROM session_replays AS s
        LEFT JOIN (SELECT
          pair_links.VisitorId AS VisitorId,
          argMin(pair_links.UserId, pair_links.FirstSeen) AS UserId
        FROM (SELECT
          identity_links.VisitorId AS VisitorId,
          identity_links.UserId AS UserId,
          min(identity_links.FirstSeen) AS FirstSeen
        FROM identity_links
        WHERE identity_links.OrgId = 'org_sql_catalog'
        GROUP BY VisitorId, UserId) AS pair_links
        GROUP BY VisitorId) AS link ON s.VisitorId = link.VisitorId
        WHERE s.OrgId = 'org_sql_catalog'
          AND s.StartTime >= '2026-01-01 10:30:00'
          AND s.StartTime <= '2026-01-03 14:15:00'
          AND s.SessionId IN (SELECT
          product_events.SessionId AS sessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'navigation'
          AND product_events.Host = 'maple.dev'
          AND product_events.PagePath = '/pricing'
        GROUP BY sessionId)
          AND s.ReferrerHost = 't.co'
          AND s.Country = 'DE'
          AND s.DeviceType = 'desktop'
          AND s.BrowserName = 'Chrome'
          AND s.OsName = 'macOS'
          AND s.Language = 'en-US'
          AND s.UtmSource = 'twitter'
          AND s.UtmMedium = 'social'
          AND s.UtmCampaign = 'launch'
          AND s.VisitorIsNew = 1
          AND s.SessionId IN (SELECT
          product_events.SessionId AS sessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'custom'
          AND product_events.EventName = 'signup_started'
        GROUP BY sessionId)
        GROUP BY key)
) AS funnel_events
        GROUP BY key) AS levels) AS totals
        ORDER BY step ASC
        FORMAT JSON

-- builder:product-events:productEventsFunnelQuery:visitor-session-step  [c63a28ff]
SELECT
          arrayJoin([1, 2, 3, 4]) AS step,
          arrayElement(totals.counts, step) AS count
        FROM (SELECT
          [countIf(level >= 1), countIf(level >= 2), countIf(level >= 3), countIf(level >= 4)] AS counts
        FROM (SELECT
          funnel_events.key AS key,
          windowFunnel(3600000)(funnel_events.ts, funnel_events.s1 = 1, funnel_events.s2 = 1, funnel_events.s3 = 1, funnel_events.s4 = 1) AS level
        FROM (
SELECT
          s.VisitorId AS key,
          toUInt64(toUnixTimestamp64Milli(s.StartTime)) AS ts,
          0 AS seq,
          1 AS s1,
          0 AS s2,
          0 AS s3,
          0 AS s4
        FROM session_replays AS s
        WHERE s.OrgId = 'org_sql_catalog'
          AND s.StartTime >= '2026-01-01 10:30:00'
          AND s.StartTime <= '2026-01-03 14:15:00'
          AND s.ReferrerHost = 'news.ycombinator.com'
          AND s.VisitorId != ''
UNION ALL
SELECT
          e.VisitorId AS key,
          toUInt64(toUnixTimestamp64Milli(e.Timestamp)) AS ts,
          e.Seq AS seq,
          0 AS s1,
          toUInt8(((e.Kind = 'navigation' AND e.PagePath = '/pricing') AND e.Host = 'maple.dev')) AS s2,
          toUInt8(e.EventName = 'signup_completed') AS s3,
          toUInt8((e.EventName = 'plan_started' AND e.Attributes['plan'] = 'startup')) AS s4
        FROM product_events AS e
        WHERE e.OrgId = 'org_sql_catalog'
          AND e.Timestamp >= '2026-01-01 10:30:00'
          AND e.Timestamp <= '2026-01-03 14:15:00'
          AND ((((e.Kind = 'navigation' AND e.PagePath = '/pricing') AND e.Host = 'maple.dev') OR e.EventName = 'signup_completed') OR (e.EventName = 'plan_started' AND e.Attributes['plan'] = 'startup'))
          AND e.VisitorId != ''
) AS funnel_events
        GROUP BY key) AS levels) AS totals
        ORDER BY step ASC
        FORMAT JSON

-- builder:product-events:productEventsFunnelTimingQuery:person  [78104129]
SELECT
          arrayJoin([2, 3]) AS step,
          arrayElement(totals.p50s, step) AS p50Ms,
          arrayElement(totals.p90s, step) AS p90Ms
        FROM (SELECT
          [0, ifNotFinite(quantileIf(0.5)(toFloat64(t2 - t1), level >= 2 AND t2 > 0), 0), ifNotFinite(quantileIf(0.5)(toFloat64(t3 - t2), level >= 3 AND t3 > 0), 0)] AS p50s,
          [0, ifNotFinite(quantileIf(0.9)(toFloat64(t2 - t1), level >= 2 AND t2 > 0), 0), ifNotFinite(quantileIf(0.9)(toFloat64(t3 - t2), level >= 3 AND t3 > 0), 0)] AS p90s
        FROM (SELECT
          chain_events.key AS key,
          chain_events.level AS level,
          tupleElement(arrayFirst(x -> x.3 = 1, evs), 1) AS t1,
          tupleElement(arrayFirst(x -> t1 > 0 AND x.4 = 1 AND x.1 >= t1 AND x.1 <= t1 + 604800000, evs), 1) AS t2,
          tupleElement(arrayFirst(x -> t2 > 0 AND x.5 = 1 AND x.1 >= t2 AND x.1 <= t1 + 604800000, evs), 1) AS t3
        FROM (SELECT
          funnel_events.key AS key,
          windowFunnel(604800000)(funnel_events.ts, funnel_events.s1 = 1, funnel_events.s2 = 1, funnel_events.s3 = 1) AS level,
          arraySort(x -> (x.1, x.2), groupArray(tuple(ts, seq, s1, s2, s3))) AS evs
        FROM (SELECT
          multiIf(e.UserId != '', e.UserId, coalesce(link.UserId, '') != '', coalesce(link.UserId, ''), e.VisitorId) AS key,
          toUInt64(toUnixTimestamp64Milli(e.Timestamp)) AS ts,
          e.Seq AS seq,
          toUInt8(((e.Kind = 'navigation' AND e.PagePath = '/pricing') AND e.Host = 'maple.dev')) AS s1,
          toUInt8(e.EventName = 'signup_completed') AS s2,
          toUInt8((e.EventName = 'plan_started' AND e.Attributes['plan'] = 'startup')) AS s3
        FROM product_events AS e
        LEFT JOIN (SELECT
          pair_links.VisitorId AS VisitorId,
          argMin(pair_links.UserId, pair_links.FirstSeen) AS UserId
        FROM (SELECT
          identity_links.VisitorId AS VisitorId,
          identity_links.UserId AS UserId,
          min(identity_links.FirstSeen) AS FirstSeen
        FROM identity_links
        WHERE identity_links.OrgId = 'org_sql_catalog'
        GROUP BY VisitorId, UserId) AS pair_links
        GROUP BY VisitorId) AS link ON e.VisitorId = link.VisitorId
        WHERE e.OrgId = 'org_sql_catalog'
          AND e.Timestamp >= '2026-01-01 10:30:00'
          AND e.Timestamp <= '2026-01-03 14:15:00'
          AND ((((e.Kind = 'navigation' AND e.PagePath = '/pricing') AND e.Host = 'maple.dev') OR e.EventName = 'signup_completed') OR (e.EventName = 'plan_started' AND e.Attributes['plan'] = 'startup'))
          AND multiIf(e.UserId != '', e.UserId, coalesce(link.UserId, '') != '', coalesce(link.UserId, ''), e.VisitorId) != '') AS funnel_events
        GROUP BY key) AS chain_events) AS chain) AS totals
        ORDER BY step ASC
        FORMAT JSON

-- builder:product-events:productEventTraceSamplesQuery:default  [3b8995a4]
SELECT
          product_events.TraceId AS traceId,
          product_events.SpanId AS spanId,
          product_events.Timestamp AS timestamp,
          product_events.ServiceName AS serviceName,
          product_events.UserId AS userId,
          product_events.VisitorId AS visitorId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.EventName = 'checkout_completed'
          AND product_events.TraceId != ''
        ORDER BY timestamp DESC
        LIMIT 20
        FORMAT JSON

-- builder:releases:releaseErrorFingerprintsQuery:default  [01c17a5e]
SELECT
          toString(error_events_by_time.FingerprintHash) AS fingerprintHash,
          count() AS count,
          min(error_events_by_time.Timestamp) AS firstSeen
        FROM error_events_by_time
        WHERE error_events_by_time.OrgId = 'org_sql_catalog'
          AND error_events_by_time.ServiceName = 'api'
          AND error_events_by_time.ServiceVersion = '0af7651916cd43dd8448eb211c80319c0af76519'
          AND error_events_by_time.Timestamp >= '2026-01-01 10:30:00'
          AND error_events_by_time.Timestamp <= '2026-01-03 14:15:00'
          AND error_events_by_time.DeploymentEnv IN ('production')
        GROUP BY fingerprintHash
        ORDER BY count DESC
        LIMIT 50
        FORMAT JSON

-- builder:releases:releasesListQuery:default  [7a5933b6]
SELECT
          service_windows.bServiceName AS serviceName,
          service_windows.bEnvironment AS environment,
          service_windows.bCommitSha AS commitSha,
          min(service_windows.bFirstSeen) AS firstSeen,
          sum(service_windows.bSpanCount) AS spanCount,
          sum(service_windows.bErrorCount) AS errorCount,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 1) / 1000000 AS p50LatencyMs,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 2) / 1000000 AS p95LatencyMs,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 3) / 1000000 AS p99LatencyMs,
          sum(service_windows.bApdexSatisfiedCount) AS apdexSatisfiedCount,
          sum(service_windows.bApdexToleratingCount) AS apdexToleratingCount
        FROM (
SELECT
          toStartOfHour(service_overview_spans.Timestamp) AS bBucket,
          service_overview_spans.ServiceName AS bServiceName,
          service_overview_spans.ServiceNamespace AS bServiceNamespace,
          service_overview_spans.DeploymentEnv AS bEnvironment,
          service_overview_spans.CommitSha AS bCommitSha,
          count() AS bSpanCount,
          sum(service_overview_spans.SampleRate) AS bEstimatedSpanCount,
          countIf(service_overview_spans.StatusCode = 'Error') AS bErrorCount,
          sumIf(service_overview_spans.SampleRate, service_overview_spans.StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          min(service_overview_spans.Timestamp) AS bFirstSeen,
          countIf((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration < 500000000)) AS bApdexSatisfiedCount,
          countIf(((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration >= 500000000) AND service_overview_spans.Duration < 2000000000)) AS bApdexToleratingCount
        FROM service_overview_spans
        WHERE service_overview_spans.OrgId = 'org_sql_catalog'
          AND service_overview_spans.Timestamp >= '2026-01-01 10:30:00'
          AND service_overview_spans.Timestamp <= '2026-01-03 14:15:00'
          AND service_overview_spans.DeploymentEnv IN ('production')
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
UNION ALL
SELECT
          service_overview_hourly.Hour AS bBucket,
          service_overview_hourly.ServiceName AS bServiceName,
          service_overview_hourly.ServiceNamespace AS bServiceNamespace,
          service_overview_hourly.DeploymentEnv AS bEnvironment,
          service_overview_hourly.CommitSha AS bCommitSha,
          sum(service_overview_hourly.SpanCount) AS bSpanCount,
          sum(service_overview_hourly.EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(service_overview_hourly.ErrorCount) AS bErrorCount,
          sum(service_overview_hourly.EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(service_overview_hourly.DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          min(service_overview_hourly.FirstSeen) AS bFirstSeen,
          sum(service_overview_hourly.ApdexSatisfiedCount) AS bApdexSatisfiedCount,
          sum(service_overview_hourly.ApdexToleratingCount) AS bApdexToleratingCount
        FROM service_overview_hourly
        WHERE service_overview_hourly.OrgId = 'org_sql_catalog'
          AND service_overview_hourly.DeploymentEnv IN ('production')
          AND service_overview_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND service_overview_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
) AS service_windows
        WHERE service_windows.bCommitSha NOT IN ('', 'unknown', 'N/A')
          AND service_windows.bServiceName IN ('api', 'web')
        GROUP BY serviceName, environment, commitSha
        ORDER BY firstSeen DESC, spanCount DESC
        LIMIT 500
        FORMAT JSON

-- builder:releases:releasesListQuery:singleService  [8b31371a]
SELECT
          service_windows.bServiceName AS serviceName,
          service_windows.bEnvironment AS environment,
          service_windows.bCommitSha AS commitSha,
          min(service_windows.bFirstSeen) AS firstSeen,
          sum(service_windows.bSpanCount) AS spanCount,
          sum(service_windows.bErrorCount) AS errorCount,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 1) / 1000000 AS p50LatencyMs,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 2) / 1000000 AS p95LatencyMs,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 3) / 1000000 AS p99LatencyMs,
          sum(service_windows.bApdexSatisfiedCount) AS apdexSatisfiedCount,
          sum(service_windows.bApdexToleratingCount) AS apdexToleratingCount
        FROM (
SELECT
          toStartOfHour(service_overview_spans.Timestamp) AS bBucket,
          service_overview_spans.ServiceName AS bServiceName,
          service_overview_spans.ServiceNamespace AS bServiceNamespace,
          service_overview_spans.DeploymentEnv AS bEnvironment,
          service_overview_spans.CommitSha AS bCommitSha,
          count() AS bSpanCount,
          sum(service_overview_spans.SampleRate) AS bEstimatedSpanCount,
          countIf(service_overview_spans.StatusCode = 'Error') AS bErrorCount,
          sumIf(service_overview_spans.SampleRate, service_overview_spans.StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          min(service_overview_spans.Timestamp) AS bFirstSeen,
          countIf((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration < 500000000)) AS bApdexSatisfiedCount,
          countIf(((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration >= 500000000) AND service_overview_spans.Duration < 2000000000)) AS bApdexToleratingCount
        FROM service_overview_spans
        WHERE service_overview_spans.OrgId = 'org_sql_catalog'
          AND service_overview_spans.Timestamp >= '2026-01-01 10:30:00'
          AND service_overview_spans.Timestamp <= '2026-01-03 14:15:00'
          AND service_overview_spans.ServiceName = 'api'
          AND service_overview_spans.DeploymentEnv IN ('production')
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
UNION ALL
SELECT
          service_overview_hourly.Hour AS bBucket,
          service_overview_hourly.ServiceName AS bServiceName,
          service_overview_hourly.ServiceNamespace AS bServiceNamespace,
          service_overview_hourly.DeploymentEnv AS bEnvironment,
          service_overview_hourly.CommitSha AS bCommitSha,
          sum(service_overview_hourly.SpanCount) AS bSpanCount,
          sum(service_overview_hourly.EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(service_overview_hourly.ErrorCount) AS bErrorCount,
          sum(service_overview_hourly.EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(service_overview_hourly.DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          min(service_overview_hourly.FirstSeen) AS bFirstSeen,
          sum(service_overview_hourly.ApdexSatisfiedCount) AS bApdexSatisfiedCount,
          sum(service_overview_hourly.ApdexToleratingCount) AS bApdexToleratingCount
        FROM service_overview_hourly
        WHERE service_overview_hourly.OrgId = 'org_sql_catalog'
          AND service_overview_hourly.ServiceName = 'api'
          AND service_overview_hourly.DeploymentEnv IN ('production')
          AND service_overview_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND service_overview_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
) AS service_windows
        WHERE service_windows.bCommitSha NOT IN ('', 'unknown', 'N/A')
        GROUP BY serviceName, environment, commitSha
        ORDER BY firstSeen DESC, spanCount DESC
        LIMIT 100
        FORMAT JSON

-- builder:releases:releasesTimelineQuery:hourly  [a721977f]
SELECT
          toStartOfInterval(service_windows.bBucket, INTERVAL 3600 SECOND) AS bucket,
          service_windows.bServiceName AS serviceName,
          service_windows.bCommitSha AS commitSha,
          sum(service_windows.bSpanCount) AS count
        FROM (
SELECT
          toStartOfHour(service_overview_spans.Timestamp) AS bBucket,
          service_overview_spans.ServiceName AS bServiceName,
          service_overview_spans.ServiceNamespace AS bServiceNamespace,
          service_overview_spans.DeploymentEnv AS bEnvironment,
          service_overview_spans.CommitSha AS bCommitSha,
          count() AS bSpanCount,
          sum(service_overview_spans.SampleRate) AS bEstimatedSpanCount,
          countIf(service_overview_spans.StatusCode = 'Error') AS bErrorCount,
          sumIf(service_overview_spans.SampleRate, service_overview_spans.StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          min(service_overview_spans.Timestamp) AS bFirstSeen,
          countIf((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration < 500000000)) AS bApdexSatisfiedCount,
          countIf(((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration >= 500000000) AND service_overview_spans.Duration < 2000000000)) AS bApdexToleratingCount
        FROM service_overview_spans
        WHERE service_overview_spans.OrgId = 'org_sql_catalog'
          AND service_overview_spans.Timestamp >= '2026-01-01 10:30:00'
          AND service_overview_spans.Timestamp <= '2026-01-03 14:15:00'
          AND service_overview_spans.ServiceName = 'api'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
UNION ALL
SELECT
          service_overview_hourly.Hour AS bBucket,
          service_overview_hourly.ServiceName AS bServiceName,
          service_overview_hourly.ServiceNamespace AS bServiceNamespace,
          service_overview_hourly.DeploymentEnv AS bEnvironment,
          service_overview_hourly.CommitSha AS bCommitSha,
          sum(service_overview_hourly.SpanCount) AS bSpanCount,
          sum(service_overview_hourly.EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(service_overview_hourly.ErrorCount) AS bErrorCount,
          sum(service_overview_hourly.EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(service_overview_hourly.DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          min(service_overview_hourly.FirstSeen) AS bFirstSeen,
          sum(service_overview_hourly.ApdexSatisfiedCount) AS bApdexSatisfiedCount,
          sum(service_overview_hourly.ApdexToleratingCount) AS bApdexToleratingCount
        FROM service_overview_hourly
        WHERE service_overview_hourly.OrgId = 'org_sql_catalog'
          AND service_overview_hourly.ServiceName = 'api'
          AND service_overview_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND service_overview_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
) AS service_windows
        WHERE service_windows.bCommitSha NOT IN ('', 'unknown', 'N/A')
        GROUP BY bucket, serviceName, commitSha
        ORDER BY bucket ASC
        LIMIT 5000
        FORMAT JSON

-- builder:releases:releasesTimelineQuery:minutely  [42db38d1]
SELECT
          toStartOfInterval(service_windows.bBucket, INTERVAL 300 SECOND) AS bucket,
          service_windows.bServiceName AS serviceName,
          service_windows.bCommitSha AS commitSha,
          sum(service_windows.bSpanCount) AS count
        FROM (
SELECT
          toStartOfMinute(service_overview_spans.Timestamp) AS bBucket,
          service_overview_spans.ServiceName AS bServiceName,
          service_overview_spans.ServiceNamespace AS bServiceNamespace,
          service_overview_spans.DeploymentEnv AS bEnvironment,
          service_overview_spans.CommitSha AS bCommitSha,
          count() AS bSpanCount,
          sum(service_overview_spans.SampleRate) AS bEstimatedSpanCount,
          countIf(service_overview_spans.StatusCode = 'Error') AS bErrorCount,
          sumIf(service_overview_spans.SampleRate, service_overview_spans.StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          min(service_overview_spans.Timestamp) AS bFirstSeen,
          countIf((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration < 500000000)) AS bApdexSatisfiedCount,
          countIf(((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration >= 500000000) AND service_overview_spans.Duration < 2000000000)) AS bApdexToleratingCount
        FROM service_overview_spans
        WHERE service_overview_spans.OrgId = 'org_sql_catalog'
          AND service_overview_spans.Timestamp >= '2026-01-01 10:30:00'
          AND service_overview_spans.Timestamp <= '2026-01-03 14:15:00'
          AND service_overview_spans.DeploymentEnv IN ('production')
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 MINUTE) OR Timestamp >= toStartOfMinute(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
UNION ALL
SELECT
          service_overview_minutely.Minute AS bBucket,
          service_overview_minutely.ServiceName AS bServiceName,
          service_overview_minutely.ServiceNamespace AS bServiceNamespace,
          service_overview_minutely.DeploymentEnv AS bEnvironment,
          service_overview_minutely.CommitSha AS bCommitSha,
          sum(service_overview_minutely.SpanCount) AS bSpanCount,
          sum(service_overview_minutely.EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(service_overview_minutely.ErrorCount) AS bErrorCount,
          sum(service_overview_minutely.EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(service_overview_minutely.DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          min(service_overview_minutely.FirstSeen) AS bFirstSeen,
          sum(service_overview_minutely.ApdexSatisfiedCount) AS bApdexSatisfiedCount,
          sum(service_overview_minutely.ApdexToleratingCount) AS bApdexToleratingCount
        FROM service_overview_minutely
        WHERE service_overview_minutely.OrgId = 'org_sql_catalog'
          AND service_overview_minutely.DeploymentEnv IN ('production')
          AND service_overview_minutely.Minute >= if(toDateTime('2026-01-01 10:30:00') = toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 MINUTE)
          AND service_overview_minutely.Minute < toStartOfMinute(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
) AS service_windows
        WHERE service_windows.bCommitSha NOT IN ('', 'unknown', 'N/A')
        GROUP BY bucket, serviceName, commitSha
        ORDER BY bucket ASC
        LIMIT 5000
        FORMAT JSON

-- builder:releases:releasesTimelineQuery:raw  [b6bfcd22]
SELECT
          toStartOfInterval(service_overview_spans.Timestamp, INTERVAL 30 SECOND) AS bucket,
          service_overview_spans.ServiceName AS serviceName,
          service_overview_spans.CommitSha AS commitSha,
          count() AS count
        FROM service_overview_spans
        WHERE service_overview_spans.OrgId = 'org_sql_catalog'
          AND service_overview_spans.Timestamp >= '2026-01-01 10:30:00'
          AND service_overview_spans.Timestamp <= '2026-01-03 14:15:00'
          AND service_overview_spans.ServiceName = 'api'
          AND service_overview_spans.CommitSha NOT IN ('', 'unknown', 'N/A')
        GROUP BY bucket, serviceName, commitSha
        ORDER BY bucket ASC
        LIMIT 5000
        FORMAT JSON

-- builder:service-endpoints:serviceEndpointsSummaryQuery:default  [3decb4a7]
SELECT
          operation_windows.bSpanName AS spanName,
          sum(operation_windows.bSpanCount) AS spanCount,
          sum(operation_windows.bEstimatedSpanCount) AS estimatedSpanCount,
          sum(operation_windows.bErrorCount) AS errorCount,
          sum(operation_windows.bEstimatedErrorCount) AS estimatedErrorCount,
          if(sum(operation_windows.bEstimatedSpanCount) > 0, sum(operation_windows.bEstimatedErrorCount) / sum(operation_windows.bEstimatedSpanCount), 0) AS errorRate,
          if(sum(operation_windows.bSpanCount) > 0, sum(operation_windows.bDurationSum) / sum(operation_windows.bSpanCount) / 1000000, 0) AS avgDurationMs,
          if(sum(bSpanCount) > 0, arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 1) / 1000000, 0) AS p50DurationMs,
          if(sum(bSpanCount) > 0, arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 2) / 1000000, 0) AS p95DurationMs,
          if(sum(bSpanCount) > 0, arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 3) / 1000000, 0) AS p99DurationMs
        FROM (
SELECT
          if(((traces.SpanName LIKE 'http.server %' OR traces.SpanName IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')) AND (traces.SpanAttributes['http.route'] != '' OR traces.SpanAttributes['url.path'] != '')), concat(if(traces.SpanName LIKE 'http.server %', replaceOne(traces.SpanName, 'http.server ', ''), traces.SpanName), ' ', if(traces.SpanAttributes['http.route'] != '', traces.SpanAttributes['http.route'], traces.SpanAttributes['url.path'])), traces.SpanName) AS bSpanName,
          count() AS bSpanCount,
          sum(traces.SampleRate) AS bEstimatedSpanCount,
          countIf(traces.StatusCode = 'Error') AS bErrorCount,
          sumIf(traces.SampleRate, traces.StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND traces.ServiceName = 'api'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 MINUTE) OR Timestamp >= toStartOfMinute(toDateTime('2026-01-03 14:15:00')))
          AND match(if(((traces.SpanName LIKE 'http.server %' OR traces.SpanName IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')) AND (traces.SpanAttributes['http.route'] != '' OR traces.SpanAttributes['url.path'] != '')), concat(if(traces.SpanName LIKE 'http.server %', replaceOne(traces.SpanName, 'http.server ', ''), traces.SpanName), ' ', if(traces.SpanAttributes['http.route'] != '', traces.SpanAttributes['http.route'], traces.SpanAttributes['url.path'])), traces.SpanName), '^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) ')
        GROUP BY bSpanName
UNION ALL
SELECT
          service_operations_minutely.SpanName AS bSpanName,
          sum(service_operations_minutely.SpanCount) AS bSpanCount,
          sum(service_operations_minutely.EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(service_operations_minutely.ErrorCount) AS bErrorCount,
          sum(service_operations_minutely.EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(service_operations_minutely.DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles
        FROM service_operations_minutely
        WHERE service_operations_minutely.OrgId = 'org_sql_catalog'
          AND service_operations_minutely.ServiceName = 'api'
          AND service_operations_minutely.Minute >= if(toDateTime('2026-01-01 10:30:00') = toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 MINUTE)
          AND service_operations_minutely.Minute < toStartOfMinute(toDateTime('2026-01-03 14:15:00'))
          AND (Minute < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Minute >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND match(service_operations_minutely.SpanName, '^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) ')
        GROUP BY bSpanName
UNION ALL
SELECT
          service_operations_hourly.SpanName AS bSpanName,
          sum(service_operations_hourly.SpanCount) AS bSpanCount,
          sum(service_operations_hourly.EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(service_operations_hourly.ErrorCount) AS bErrorCount,
          sum(service_operations_hourly.EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(service_operations_hourly.DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles
        FROM service_operations_hourly
        WHERE service_operations_hourly.OrgId = 'org_sql_catalog'
          AND service_operations_hourly.ServiceName = 'api'
          AND service_operations_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND service_operations_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND match(service_operations_hourly.SpanName, '^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) ')
        GROUP BY bSpanName
) AS operation_windows
        GROUP BY spanName
        ORDER BY estimatedSpanCount DESC
        LIMIT 50
        FORMAT JSON

-- builder:service-endpoints:serviceEndpointsSummaryQuery:envFiltered  [c245abf5]
SELECT
          operation_windows.bSpanName AS spanName,
          sum(operation_windows.bSpanCount) AS spanCount,
          sum(operation_windows.bEstimatedSpanCount) AS estimatedSpanCount,
          sum(operation_windows.bErrorCount) AS errorCount,
          sum(operation_windows.bEstimatedErrorCount) AS estimatedErrorCount,
          if(sum(operation_windows.bEstimatedSpanCount) > 0, sum(operation_windows.bEstimatedErrorCount) / sum(operation_windows.bEstimatedSpanCount), 0) AS errorRate,
          if(sum(operation_windows.bSpanCount) > 0, sum(operation_windows.bDurationSum) / sum(operation_windows.bSpanCount) / 1000000, 0) AS avgDurationMs,
          if(sum(bSpanCount) > 0, arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 1) / 1000000, 0) AS p50DurationMs,
          if(sum(bSpanCount) > 0, arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 2) / 1000000, 0) AS p95DurationMs,
          if(sum(bSpanCount) > 0, arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 3) / 1000000, 0) AS p99DurationMs
        FROM (
SELECT
          if(((traces.SpanName LIKE 'http.server %' OR traces.SpanName IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')) AND (traces.SpanAttributes['http.route'] != '' OR traces.SpanAttributes['url.path'] != '')), concat(if(traces.SpanName LIKE 'http.server %', replaceOne(traces.SpanName, 'http.server ', ''), traces.SpanName), ' ', if(traces.SpanAttributes['http.route'] != '', traces.SpanAttributes['http.route'], traces.SpanAttributes['url.path'])), traces.SpanName) AS bSpanName,
          count() AS bSpanCount,
          sum(traces.SampleRate) AS bEstimatedSpanCount,
          countIf(traces.StatusCode = 'Error') AS bErrorCount,
          sumIf(traces.SampleRate, traces.StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND traces.ServiceName = 'api'
          AND coalesce(nullIf(traces.ResourceAttributes['deployment.environment.name'], ''), traces.ResourceAttributes['deployment.environment']) IN ('production')
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 MINUTE) OR Timestamp >= toStartOfMinute(toDateTime('2026-01-03 14:15:00')))
          AND match(if(((traces.SpanName LIKE 'http.server %' OR traces.SpanName IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')) AND (traces.SpanAttributes['http.route'] != '' OR traces.SpanAttributes['url.path'] != '')), concat(if(traces.SpanName LIKE 'http.server %', replaceOne(traces.SpanName, 'http.server ', ''), traces.SpanName), ' ', if(traces.SpanAttributes['http.route'] != '', traces.SpanAttributes['http.route'], traces.SpanAttributes['url.path'])), traces.SpanName), '^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) ')
        GROUP BY bSpanName
UNION ALL
SELECT
          service_operations_minutely.SpanName AS bSpanName,
          sum(service_operations_minutely.SpanCount) AS bSpanCount,
          sum(service_operations_minutely.EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(service_operations_minutely.ErrorCount) AS bErrorCount,
          sum(service_operations_minutely.EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(service_operations_minutely.DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles
        FROM service_operations_minutely
        WHERE service_operations_minutely.OrgId = 'org_sql_catalog'
          AND service_operations_minutely.ServiceName = 'api'
          AND service_operations_minutely.DeploymentEnv IN ('production')
          AND service_operations_minutely.Minute >= if(toDateTime('2026-01-01 10:30:00') = toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 MINUTE)
          AND service_operations_minutely.Minute < toStartOfMinute(toDateTime('2026-01-03 14:15:00'))
          AND (Minute < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Minute >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND match(service_operations_minutely.SpanName, '^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) ')
        GROUP BY bSpanName
UNION ALL
SELECT
          service_operations_hourly.SpanName AS bSpanName,
          sum(service_operations_hourly.SpanCount) AS bSpanCount,
          sum(service_operations_hourly.EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(service_operations_hourly.ErrorCount) AS bErrorCount,
          sum(service_operations_hourly.EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(service_operations_hourly.DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles
        FROM service_operations_hourly
        WHERE service_operations_hourly.OrgId = 'org_sql_catalog'
          AND service_operations_hourly.ServiceName = 'api'
          AND service_operations_hourly.DeploymentEnv IN ('production')
          AND service_operations_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND service_operations_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND match(service_operations_hourly.SpanName, '^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) ')
        GROUP BY bSpanName
) AS operation_windows
        GROUP BY spanName
        ORDER BY estimatedSpanCount DESC
        LIMIT 50
        FORMAT JSON

-- builder:service-map-rollup:serviceMapEdgesExistingHoursSQL:default  [7206e1a8]
SELECT
          toUnixTimestamp(service_map_edges_hourly.Hour) AS hourTs
        FROM service_map_edges_hourly
        WHERE service_map_edges_hourly.OrgId = 'org_sql_catalog'
          AND service_map_edges_hourly.Hour >= '2026-01-01 10:30:00'
          AND service_map_edges_hourly.Hour < '2026-01-03 14:15:00'
        GROUP BY hourTs
        FORMAT JSON

-- builder:service-map-rollup:serviceMapEdgesRollupSQL:default  [f4240642]
SELECT
          p.OrgId AS OrgId,
          toStartOfHour(p.Timestamp) AS Hour,
          p.ServiceName AS SourceService,
          c.ServiceName AS TargetService,
          p.DeploymentEnv AS DeploymentEnv,
          count() AS CallCount,
          countIf(c.StatusCode = 'Error') AS ErrorCount,
          sum(c.Duration / 1000000) AS DurationSumMs,
          max(c.Duration / 1000000) AS MaxDurationMs,
          countIf(match(c.TraceState, 'th:[0-9a-f]+')) AS SampledSpanCount,
          countIf(NOT (match(c.TraceState, 'th:[0-9a-f]+'))) AS UnsampledSpanCount,
          sum(multiIf(match(c.TraceState, 'th:[0-9a-f]+'), 1.0 / greatest(1.0 - reinterpretAsUInt64(reverse(unhex(rightPad(extract(c.TraceState, 'th:([0-9a-f]+)'), 16, '0')))) / pow(2.0, 64), 0.0001), 1.0)) AS SampleRateSum
        FROM (SELECT
          service_map_spans.OrgId AS OrgId,
          service_map_spans.Timestamp AS Timestamp,
          service_map_spans.TraceId AS TraceId,
          service_map_spans.SpanId AS SpanId,
          service_map_spans.ServiceName AS ServiceName,
          service_map_spans.DeploymentEnv AS DeploymentEnv
        FROM service_map_spans
        WHERE service_map_spans.SpanKind IN ('Client', 'Producer')
          AND service_map_spans.Timestamp >= toDateTime('2026-01-01 10:30:00')
          AND service_map_spans.Timestamp < toDateTime('2026-01-03 14:15:00')
          AND service_map_spans.OrgId = 'org_sql_catalog') AS p
        INNER JOIN (SELECT
          service_map_children.TraceId AS TraceId,
          service_map_children.ParentSpanId AS ParentSpanId,
          service_map_children.ServiceName AS ServiceName,
          service_map_children.Duration AS Duration,
          service_map_children.StatusCode AS StatusCode,
          service_map_children.TraceState AS TraceState
        FROM service_map_children
        WHERE service_map_children.Timestamp >= toDateTime('2026-01-01 10:30:00')
          AND service_map_children.Timestamp < toDateTime('2026-01-03 14:15:00')
          AND service_map_children.OrgId = 'org_sql_catalog') AS c ON (p.SpanId = c.ParentSpanId AND p.TraceId = c.TraceId)
        WHERE p.ServiceName != c.ServiceName
        GROUP BY OrgId, Hour, SourceService, TargetService, DeploymentEnv
        FORMAT JSON

-- builder:service-map-rollup:serviceMapResolutionsExistingHoursSQL:default  [19592419]
SELECT
          toUnixTimestamp(service_address_resolutions_hourly.Hour) AS hourTs
        FROM service_address_resolutions_hourly
        WHERE service_address_resolutions_hourly.OrgId = 'org_sql_catalog'
          AND service_address_resolutions_hourly.Hour >= '2026-01-01 10:30:00'
          AND service_address_resolutions_hourly.Hour < '2026-01-03 14:15:00'
        GROUP BY hourTs
        FORMAT JSON

-- builder:service-map:serviceDbEdgesForServiceQuery:default  [78428e9c]
SELECT
          edges.sourceService AS sourceService,
          edges.dbSystem AS dbSystem,
          edges.dbNamespace AS dbNamespace,
          sum(edges.bucketCallCount) AS callCount,
          sum(edges.bucketErrorCount) AS errorCount,
          ifNull(ifNotFinite(sum(edges.bucketDurationSumMs) / nullIf(sum(edges.bucketCallCount), 0), 0), 0) AS avgDurationMs,
          max(edges.bucketMaxDurationMs) AS maxDurationMs,
          if(sum(bucketCallCount) > 0, arrayElement(quantilesTDigestWeightedMerge(0.5, 0.95)(bucketDurationQuantiles), 2) / 1000000, 0) AS p95DurationMs,
          sum(edges.bucketEstimatedSpanCount) AS estimatedSpanCount
        FROM (
SELECT
          service_map_db_edges_hourly.ServiceName AS sourceService,
          service_map_db_edges_hourly.DbSystem AS dbSystem,
          if(match(service_map_db_edges_hourly.DbNamespace, '^([0-9a-fA-F]{32}|.*[.]hyperdrive[.]local)$'), 'hyperdrive', service_map_db_edges_hourly.DbNamespace) AS dbNamespace,
          sum(service_map_db_edges_hourly.CallCount) AS bucketCallCount,
          sum(service_map_db_edges_hourly.ErrorCount) AS bucketErrorCount,
          sum(service_map_db_edges_hourly.DurationSumMs) AS bucketDurationSumMs,
          max(service_map_db_edges_hourly.MaxDurationMs) AS bucketMaxDurationMs,
          sum(if(service_map_db_edges_hourly.SampleRateSum > 0, service_map_db_edges_hourly.SampleRateSum, toFloat64(service_map_db_edges_hourly.CallCount))) AS bucketEstimatedSpanCount,
          quantilesTDigestWeightedMergeState(0.5, 0.95)(DurationQuantiles) AS bucketDurationQuantiles
        FROM service_map_db_edges_hourly
        WHERE service_map_db_edges_hourly.OrgId = 'org_sql_catalog'
          AND service_map_db_edges_hourly.ServiceName = 'web'
          AND service_map_db_edges_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND service_map_db_edges_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND service_map_db_edges_hourly.DbSystem != ''
        GROUP BY sourceService, dbSystem, dbNamespace
UNION ALL
SELECT
          traces.ServiceName AS sourceService,
          coalesce(nullIf(traces.SpanAttributes['db.system.name'], ''), traces.SpanAttributes['db.system']) AS dbSystem,
          if(match(coalesce(nullIf(traces.SpanAttributes['db.namespace'], ''), nullIf(traces.SpanAttributes['db.name'], ''), nullIf(traces.SpanAttributes['server.address'], ''), traces.SpanAttributes['net.peer.name']), '^([0-9a-fA-F]{32}|.*[.]hyperdrive[.]local)$'), 'hyperdrive', coalesce(nullIf(traces.SpanAttributes['db.namespace'], ''), nullIf(traces.SpanAttributes['db.name'], ''), nullIf(traces.SpanAttributes['server.address'], ''), traces.SpanAttributes['net.peer.name'])) AS dbNamespace,
          count() AS bucketCallCount,
          countIf(traces.StatusCode = 'Error') AS bucketErrorCount,
          sum(traces.Duration / 1000000) AS bucketDurationSumMs,
          max(traces.Duration / 1000000) AS bucketMaxDurationMs,
          sum(traces.SampleRate) AS bucketEstimatedSpanCount,
          quantilesTDigestWeightedState(0.5, 0.95)(Duration, toUInt32(greatest(SampleRate, 1.0))) AS bucketDurationQuantiles
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.ServiceName = 'web'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND traces.SpanKind IN ('Client', 'Producer')
          AND coalesce(nullIf(traces.SpanAttributes['db.system.name'], ''), traces.SpanAttributes['db.system']) != ''
        GROUP BY sourceService, dbSystem, dbNamespace
) AS edges
        GROUP BY sourceService, dbSystem, dbNamespace
        ORDER BY callCount DESC
        LIMIT 200
        FORMAT JSON

-- builder:service-map:serviceDbEdgesSQL:default  [d1f75e8e]
SELECT
          edges.sourceService AS sourceService,
          edges.dbSystem AS dbSystem,
          edges.dbNamespace AS dbNamespace,
          sum(edges.bucketCallCount) AS callCount,
          sum(edges.bucketErrorCount) AS errorCount,
          ifNull(ifNotFinite(sum(edges.bucketDurationSumMs) / nullIf(sum(edges.bucketCallCount), 0), 0), 0) AS avgDurationMs,
          max(edges.bucketMaxDurationMs) AS maxDurationMs,
          if(sum(bucketCallCount) > 0, arrayElement(quantilesTDigestWeightedMerge(0.5, 0.95)(bucketDurationQuantiles), 2) / 1000000, 0) AS p95DurationMs,
          sum(edges.bucketEstimatedSpanCount) AS estimatedSpanCount
        FROM (
SELECT
          service_map_db_edges_hourly.ServiceName AS sourceService,
          service_map_db_edges_hourly.DbSystem AS dbSystem,
          if(match(service_map_db_edges_hourly.DbNamespace, '^([0-9a-fA-F]{32}|.*[.]hyperdrive[.]local)$'), 'hyperdrive', service_map_db_edges_hourly.DbNamespace) AS dbNamespace,
          sum(service_map_db_edges_hourly.CallCount) AS bucketCallCount,
          sum(service_map_db_edges_hourly.ErrorCount) AS bucketErrorCount,
          sum(service_map_db_edges_hourly.DurationSumMs) AS bucketDurationSumMs,
          max(service_map_db_edges_hourly.MaxDurationMs) AS bucketMaxDurationMs,
          sum(if(service_map_db_edges_hourly.SampleRateSum > 0, service_map_db_edges_hourly.SampleRateSum, toFloat64(service_map_db_edges_hourly.CallCount))) AS bucketEstimatedSpanCount,
          quantilesTDigestWeightedMergeState(0.5, 0.95)(DurationQuantiles) AS bucketDurationQuantiles
        FROM service_map_db_edges_hourly
        WHERE service_map_db_edges_hourly.OrgId = 'org_sql_catalog'
          AND service_map_db_edges_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND service_map_db_edges_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND service_map_db_edges_hourly.DbSystem != ''
        GROUP BY sourceService, dbSystem, dbNamespace
UNION ALL
SELECT
          traces.ServiceName AS sourceService,
          coalesce(nullIf(traces.SpanAttributes['db.system.name'], ''), traces.SpanAttributes['db.system']) AS dbSystem,
          if(match(coalesce(nullIf(traces.SpanAttributes['db.namespace'], ''), nullIf(traces.SpanAttributes['db.name'], ''), nullIf(traces.SpanAttributes['server.address'], ''), traces.SpanAttributes['net.peer.name']), '^([0-9a-fA-F]{32}|.*[.]hyperdrive[.]local)$'), 'hyperdrive', coalesce(nullIf(traces.SpanAttributes['db.namespace'], ''), nullIf(traces.SpanAttributes['db.name'], ''), nullIf(traces.SpanAttributes['server.address'], ''), traces.SpanAttributes['net.peer.name'])) AS dbNamespace,
          count() AS bucketCallCount,
          countIf(traces.StatusCode = 'Error') AS bucketErrorCount,
          sum(traces.Duration / 1000000) AS bucketDurationSumMs,
          max(traces.Duration / 1000000) AS bucketMaxDurationMs,
          sum(traces.SampleRate) AS bucketEstimatedSpanCount,
          quantilesTDigestWeightedState(0.5, 0.95)(Duration, toUInt32(greatest(SampleRate, 1.0))) AS bucketDurationQuantiles
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.ServiceName != ''
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND traces.SpanKind IN ('Client', 'Producer')
          AND coalesce(nullIf(traces.SpanAttributes['db.system.name'], ''), traces.SpanAttributes['db.system']) != ''
        GROUP BY sourceService, dbSystem, dbNamespace
) AS edges
        GROUP BY sourceService, dbSystem, dbNamespace
        ORDER BY callCount DESC
        LIMIT 200
        FORMAT JSON

-- builder:service-map:serviceDbEdgesSQL:env-scoped  [3b887cda]
SELECT
          edges.sourceService AS sourceService,
          edges.dbSystem AS dbSystem,
          edges.dbNamespace AS dbNamespace,
          sum(edges.bucketCallCount) AS callCount,
          sum(edges.bucketErrorCount) AS errorCount,
          ifNull(ifNotFinite(sum(edges.bucketDurationSumMs) / nullIf(sum(edges.bucketCallCount), 0), 0), 0) AS avgDurationMs,
          max(edges.bucketMaxDurationMs) AS maxDurationMs,
          if(sum(bucketCallCount) > 0, arrayElement(quantilesTDigestWeightedMerge(0.5, 0.95)(bucketDurationQuantiles), 2) / 1000000, 0) AS p95DurationMs,
          sum(edges.bucketEstimatedSpanCount) AS estimatedSpanCount
        FROM (
SELECT
          service_map_db_edges_hourly.ServiceName AS sourceService,
          service_map_db_edges_hourly.DbSystem AS dbSystem,
          if(match(service_map_db_edges_hourly.DbNamespace, '^([0-9a-fA-F]{32}|.*[.]hyperdrive[.]local)$'), 'hyperdrive', service_map_db_edges_hourly.DbNamespace) AS dbNamespace,
          sum(service_map_db_edges_hourly.CallCount) AS bucketCallCount,
          sum(service_map_db_edges_hourly.ErrorCount) AS bucketErrorCount,
          sum(service_map_db_edges_hourly.DurationSumMs) AS bucketDurationSumMs,
          max(service_map_db_edges_hourly.MaxDurationMs) AS bucketMaxDurationMs,
          sum(if(service_map_db_edges_hourly.SampleRateSum > 0, service_map_db_edges_hourly.SampleRateSum, toFloat64(service_map_db_edges_hourly.CallCount))) AS bucketEstimatedSpanCount,
          quantilesTDigestWeightedMergeState(0.5, 0.95)(DurationQuantiles) AS bucketDurationQuantiles
        FROM service_map_db_edges_hourly
        WHERE service_map_db_edges_hourly.OrgId = 'org_sql_catalog'
          AND service_map_db_edges_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND service_map_db_edges_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND service_map_db_edges_hourly.DbSystem != ''
          AND service_map_db_edges_hourly.DeploymentEnv = 'production'
        GROUP BY sourceService, dbSystem, dbNamespace
UNION ALL
SELECT
          traces.ServiceName AS sourceService,
          coalesce(nullIf(traces.SpanAttributes['db.system.name'], ''), traces.SpanAttributes['db.system']) AS dbSystem,
          if(match(coalesce(nullIf(traces.SpanAttributes['db.namespace'], ''), nullIf(traces.SpanAttributes['db.name'], ''), nullIf(traces.SpanAttributes['server.address'], ''), traces.SpanAttributes['net.peer.name']), '^([0-9a-fA-F]{32}|.*[.]hyperdrive[.]local)$'), 'hyperdrive', coalesce(nullIf(traces.SpanAttributes['db.namespace'], ''), nullIf(traces.SpanAttributes['db.name'], ''), nullIf(traces.SpanAttributes['server.address'], ''), traces.SpanAttributes['net.peer.name'])) AS dbNamespace,
          count() AS bucketCallCount,
          countIf(traces.StatusCode = 'Error') AS bucketErrorCount,
          sum(traces.Duration / 1000000) AS bucketDurationSumMs,
          max(traces.Duration / 1000000) AS bucketMaxDurationMs,
          sum(traces.SampleRate) AS bucketEstimatedSpanCount,
          quantilesTDigestWeightedState(0.5, 0.95)(Duration, toUInt32(greatest(SampleRate, 1.0))) AS bucketDurationQuantiles
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.ServiceName != ''
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND traces.SpanKind IN ('Client', 'Producer')
          AND coalesce(nullIf(traces.SpanAttributes['db.system.name'], ''), traces.SpanAttributes['db.system']) != ''
          AND coalesce(nullIf(traces.ResourceAttributes['deployment.environment.name'], ''), traces.ResourceAttributes['deployment.environment']) = 'production'
        GROUP BY sourceService, dbSystem, dbNamespace
) AS edges
        GROUP BY sourceService, dbSystem, dbNamespace
        ORDER BY callCount DESC
        LIMIT 200
        FORMAT JSON

-- builder:service-map:serviceDbQuerySummarySQL:default  [6c2cc268]
SELECT
          sum(branches.bCount) AS queryCount,
          sum(branches.bEst) AS estimatedQueryCount,
          sum(branches.bErr) AS errorCount,
          sum(branches.bEstErr) AS estimatedErrorCount,
          if(sum(branches.bEst) > 0, sum(branches.bEstErr) / sum(branches.bEst), 0) AS errorRate,
          if(sum(branches.bEst) > 0, sum(branches.bWDur) / sum(branches.bEst), 0) AS avgDurationMs,
          if(sum(bCount) > 0, arrayElement(quantilesTDigestWeightedMerge(0.5, 0.95)(bQ), 1) / 1000000, 0) AS p50DurationMs,
          if(sum(bCount) > 0, arrayElement(quantilesTDigestWeightedMerge(0.5, 0.95)(bQ), 2) / 1000000, 0) AS p95DurationMs,
          uniqMerge(bSvc) AS activeServiceCount
        FROM (
SELECT
          sum(service_map_db_query_shapes_hourly.CallCount) AS bCount,
          sum(service_map_db_query_shapes_hourly.EstimatedCount) AS bEst,
          sum(service_map_db_query_shapes_hourly.ErrorCount) AS bErr,
          sum(service_map_db_query_shapes_hourly.EstimatedErrorCount) AS bEstErr,
          sum(service_map_db_query_shapes_hourly.WeightedDurationSumMs) AS bWDur,
          uniqState(toString(ServiceName)) AS bSvc,
          quantilesTDigestWeightedMergeState(0.5, 0.95)(DurationQuantiles) AS bQ
        FROM service_map_db_query_shapes_hourly
        WHERE service_map_db_query_shapes_hourly.OrgId = 'org_sql_catalog'
          AND service_map_db_query_shapes_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND service_map_db_query_shapes_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND service_map_db_query_shapes_hourly.DbSystem = 'postgresql'
UNION ALL
SELECT
          count() AS bCount,
          sum(traces.SampleRate) AS bEst,
          countIf(traces.StatusCode = 'Error') AS bErr,
          sumIf(traces.SampleRate, traces.StatusCode = 'Error') AS bEstErr,
          sum(toFloat64(traces.Duration) * traces.SampleRate / 1000000) AS bWDur,
          uniqState(toString(ServiceName)) AS bSvc,
          quantilesTDigestWeightedState(0.5, 0.95)(Duration, toUInt32(greatest(SampleRate, 1.0))) AS bQ
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= toDateTime('2026-01-01 10:30:00')
          AND traces.Timestamp <= toDateTime('2026-01-03 14:15:00')
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND traces.SpanKind IN ('Client', 'Producer')
          AND traces.ServiceName != ''
          AND coalesce(nullIf(traces.SpanAttributes['db.system.name'], ''), traces.SpanAttributes['db.system']) = 'postgresql'
) AS branches
        FORMAT JSON

-- builder:service-map:serviceDbQueryTimeseriesSQL:hourly-buckets  [f4a3fb65]
SELECT
          buckets.bucket AS bucket,
          sum(buckets.bCount) AS queryCount,
          sum(buckets.bEst) AS estimatedQueryCount,
          sum(buckets.bErr) AS errorCount,
          if(sum(buckets.bEst) > 0, sum(buckets.bEstErr) / sum(buckets.bEst), 0) AS errorRate,
          if(sum(buckets.bEst) > 0, sum(buckets.bWDur) / sum(buckets.bEst), 0) AS avgDurationMs,
          if(sum(bCount) > 0, arrayElement(quantilesTDigestWeightedMerge(0.5, 0.95)(bQ), 1) / 1000000, 0) AS p50DurationMs,
          if(sum(bCount) > 0, arrayElement(quantilesTDigestWeightedMerge(0.5, 0.95)(bQ), 2) / 1000000, 0) AS p95DurationMs
        FROM (
SELECT
          toStartOfInterval(service_map_db_query_shapes_hourly.Hour, INTERVAL 3600 SECOND) AS bucket,
          sum(service_map_db_query_shapes_hourly.CallCount) AS bCount,
          sum(service_map_db_query_shapes_hourly.EstimatedCount) AS bEst,
          sum(service_map_db_query_shapes_hourly.ErrorCount) AS bErr,
          sum(service_map_db_query_shapes_hourly.EstimatedErrorCount) AS bEstErr,
          sum(service_map_db_query_shapes_hourly.WeightedDurationSumMs) AS bWDur,
          quantilesTDigestWeightedMergeState(0.5, 0.95)(DurationQuantiles) AS bQ
        FROM service_map_db_query_shapes_hourly
        WHERE service_map_db_query_shapes_hourly.OrgId = 'org_sql_catalog'
          AND service_map_db_query_shapes_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND service_map_db_query_shapes_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND service_map_db_query_shapes_hourly.DbSystem = 'postgresql'
        GROUP BY bucket
UNION ALL
SELECT
          toStartOfInterval(toDateTime(traces.Timestamp), INTERVAL 3600 SECOND) AS bucket,
          count() AS bCount,
          sum(traces.SampleRate) AS bEst,
          countIf(traces.StatusCode = 'Error') AS bErr,
          sumIf(traces.SampleRate, traces.StatusCode = 'Error') AS bEstErr,
          sum(toFloat64(traces.Duration) * traces.SampleRate / 1000000) AS bWDur,
          quantilesTDigestWeightedState(0.5, 0.95)(Duration, toUInt32(greatest(SampleRate, 1.0))) AS bQ
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= toDateTime('2026-01-01 10:30:00')
          AND traces.Timestamp <= toDateTime('2026-01-03 14:15:00')
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND traces.SpanKind IN ('Client', 'Producer')
          AND traces.ServiceName != ''
          AND coalesce(nullIf(traces.SpanAttributes['db.system.name'], ''), traces.SpanAttributes['db.system']) = 'postgresql'
        GROUP BY bucket
) AS buckets
        GROUP BY bucket
        ORDER BY bucket ASC
        LIMIT 2000
        FORMAT JSON

-- builder:service-map:serviceDbQueryTimeseriesSQL:sub-hour-buckets  [c38631df]
SELECT
          toStartOfInterval(toDateTime(traces.Timestamp), INTERVAL 300 SECOND) AS bucket,
          count() AS queryCount,
          sum(traces.SampleRate) AS estimatedQueryCount,
          countIf(traces.StatusCode = 'Error') AS errorCount,
          if(sum(traces.SampleRate) > 0, sumIf(traces.SampleRate, traces.StatusCode = 'Error') / sum(traces.SampleRate), 0) AS errorRate,
          if(sum(traces.SampleRate) > 0, sum(toFloat64(traces.Duration) * traces.SampleRate) / sum(traces.SampleRate) / 1000000, 0) AS avgDurationMs,
          if(count() > 0, arrayElement(quantilesTDigestWeighted(0.5, 0.95)(Duration, toUInt32(greatest(SampleRate, 1.0))), 1) / 1000000, 0) AS p50DurationMs,
          if(count() > 0, arrayElement(quantilesTDigestWeighted(0.5, 0.95)(Duration, toUInt32(greatest(SampleRate, 1.0))), 2) / 1000000, 0) AS p95DurationMs
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= toDateTime('2026-01-01 10:30:00')
          AND traces.Timestamp <= toDateTime('2026-01-03 14:15:00')
          AND traces.SpanKind IN ('Client', 'Producer')
          AND traces.ServiceName != ''
          AND coalesce(nullIf(traces.SpanAttributes['db.system.name'], ''), traces.SpanAttributes['db.system']) = 'postgresql'
        GROUP BY bucket
        ORDER BY bucket ASC
        LIMIT 2000
        FORMAT JSON

-- builder:service-map:serviceDbTopQueriesSQL:default  [eaaad583]
SELECT
          shape.queryKey AS queryKey,
          if(sampleStatement != '', substring(trimBoth(replaceRegexpAll(replaceRegexpAll(replaceRegexpAll(replaceRegexpAll(sampleStatement, '\'[^\']*\'', '?'), '(?i)\\bin\\s*\\([^)]*\\)', 'IN (?)'), '[0-9]+(\\.[0-9]+)?', '?'), '\\s+', ' ')), 1, 220), fallbackLabel) AS queryLabel,
          shape.sampleStatement AS sampleStatement,
          shape.sampleService AS sampleService,
          shape.serviceCount AS serviceCount,
          shape.queryCount AS queryCount,
          shape.estimatedQueryCount AS estimatedQueryCount,
          shape.errorCount AS errorCount,
          shape.errorRate AS errorRate,
          shape.avgDurationMs AS avgDurationMs,
          shape.p50DurationMs AS p50DurationMs,
          shape.p95DurationMs AS p95DurationMs,
          shape.lastSeen AS lastSeen
        FROM (SELECT
          shapes.queryKey AS queryKey,
          any(shapes.bLabel) AS fallbackLabel,
          anyIf(shapes.bStatement, shapes.bStatement != '') AS sampleStatement,
          any(shapes.bSampleService) AS sampleService,
          uniqMerge(bServices) AS serviceCount,
          sum(shapes.bCount) AS queryCount,
          sum(shapes.bEst) AS estimatedQueryCount,
          sum(shapes.bErr) AS errorCount,
          if(sum(shapes.bEst) > 0, sum(shapes.bEstErr) / sum(shapes.bEst), 0) AS errorRate,
          if(sum(shapes.bEst) > 0, sum(shapes.bWDur) / sum(shapes.bEst), 0) AS avgDurationMs,
          if(sum(bCount) > 0, arrayElement(quantilesTDigestWeightedMerge(0.5, 0.95)(bQ), 1) / 1000000, 0) AS p50DurationMs,
          if(sum(bCount) > 0, arrayElement(quantilesTDigestWeightedMerge(0.5, 0.95)(bQ), 2) / 1000000, 0) AS p95DurationMs,
          max(shapes.bLastSeen) AS lastSeen
        FROM (
SELECT
          service_map_db_query_shapes_hourly.QueryKey AS queryKey,
          any(service_map_db_query_shapes_hourly.QueryLabel) AS bLabel,
          any(service_map_db_query_shapes_hourly.SampleStatement) AS bStatement,
          any(toString(service_map_db_query_shapes_hourly.ServiceName)) AS bSampleService,
          uniqState(toString(ServiceName)) AS bServices,
          sum(service_map_db_query_shapes_hourly.CallCount) AS bCount,
          sum(service_map_db_query_shapes_hourly.EstimatedCount) AS bEst,
          sum(service_map_db_query_shapes_hourly.ErrorCount) AS bErr,
          sum(service_map_db_query_shapes_hourly.EstimatedErrorCount) AS bEstErr,
          sum(service_map_db_query_shapes_hourly.WeightedDurationSumMs) AS bWDur,
          quantilesTDigestWeightedMergeState(0.5, 0.95)(DurationQuantiles) AS bQ,
          max(service_map_db_query_shapes_hourly.Hour) AS bLastSeen
        FROM service_map_db_query_shapes_hourly
        WHERE service_map_db_query_shapes_hourly.OrgId = 'org_sql_catalog'
          AND service_map_db_query_shapes_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND service_map_db_query_shapes_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND service_map_db_query_shapes_hourly.DbSystem = 'postgresql'
        GROUP BY queryKey
UNION ALL
SELECT
          coalesce(
  nullIf(SpanAttributes['db.query.fingerprint'], ''),
  nullIf(SpanAttributes['db.statement.fingerprint'], ''),
  nullIf(if(coalesce(nullIf(SpanAttributes['db.query.text'], ''), SpanAttributes['db.statement']) != '', toString(cityHash64(replaceRegexpAll(replaceRegexpAll(replaceRegexpAll(replaceRegexpAll(replaceRegexpAll(lower(coalesce(nullIf(SpanAttributes['db.query.text'], ''), SpanAttributes['db.statement'])), '\'[^\']*\'', '?'), '\\bin\\s*\\([^)]*\\)', 'in (?)'), '[0-9]+(\\.[0-9]+)?', '?'), '\\s+', ' '), '^\\s+|\\s+$', ''))), ''), ''),
  toString(cityHash64(coalesce(
  nullIf(SpanAttributes['db.query.summary'], ''),
  nullIf(if(SpanAttributes['db.operation.name'] != '', trimBoth(concat(SpanAttributes['db.operation.name'], if(coalesce(nullIf(SpanAttributes['db.collection.name'], ''), SpanAttributes['db.namespace']) != '', concat(' ', coalesce(nullIf(SpanAttributes['db.collection.name'], ''), SpanAttributes['db.namespace'])), ''))), ''), ''),
  nullIf(if(coalesce(nullIf(SpanAttributes['db.query.text'], ''), SpanAttributes['db.statement']) != '', trimBoth(concat(upper(extract(coalesce(nullIf(SpanAttributes['db.query.text'], ''), SpanAttributes['db.statement']), '^\\s*(\\w+)')), if(extract(coalesce(nullIf(SpanAttributes['db.query.text'], ''), SpanAttributes['db.statement']), '(?i)(?:from|into|update|join|table)\\s+\\W?([\\w.]+)') != '', concat(' ', extract(coalesce(nullIf(SpanAttributes['db.query.text'], ''), SpanAttributes['db.statement']), '(?i)(?:from|into|update|join|table)\\s+\\W?([\\w.]+)')), ''))), ''), ''),
  nullIf(SpanAttributes['query.context'], ''),
  nullIf(SpanAttributes['db.operation.name'], ''),
  nullIf(SpanAttributes['db.operation'], ''),
  SpanName
)))
) AS queryKey,
          any(substring(coalesce(
  nullIf(SpanAttributes['db.query.summary'], ''),
  nullIf(if(SpanAttributes['db.operation.name'] != '', trimBoth(concat(SpanAttributes['db.operation.name'], if(coalesce(nullIf(SpanAttributes['db.collection.name'], ''), SpanAttributes['db.namespace']) != '', concat(' ', coalesce(nullIf(SpanAttributes['db.collection.name'], ''), SpanAttributes['db.namespace'])), ''))), ''), ''),
  nullIf(if(coalesce(nullIf(SpanAttributes['db.query.text'], ''), SpanAttributes['db.statement']) != '', trimBoth(concat(upper(extract(coalesce(nullIf(SpanAttributes['db.query.text'], ''), SpanAttributes['db.statement']), '^\\s*(\\w+)')), if(extract(coalesce(nullIf(SpanAttributes['db.query.text'], ''), SpanAttributes['db.statement']), '(?i)(?:from|into|update|join|table)\\s+\\W?([\\w.]+)') != '', concat(' ', extract(coalesce(nullIf(SpanAttributes['db.query.text'], ''), SpanAttributes['db.statement']), '(?i)(?:from|into|update|join|table)\\s+\\W?([\\w.]+)')), ''))), ''), ''),
  nullIf(SpanAttributes['query.context'], ''),
  nullIf(SpanAttributes['db.operation.name'], ''),
  nullIf(SpanAttributes['db.operation'], ''),
  SpanName
), 1, 220)) AS bLabel,
          any(substring(coalesce(nullIf(SpanAttributes['db.query.text'], ''), SpanAttributes['db.statement']), 1, 1000)) AS bStatement,
          any(toString(traces.ServiceName)) AS bSampleService,
          uniqState(toString(ServiceName)) AS bServices,
          count() AS bCount,
          sum(traces.SampleRate) AS bEst,
          countIf(traces.StatusCode = 'Error') AS bErr,
          sumIf(traces.SampleRate, traces.StatusCode = 'Error') AS bEstErr,
          sum(toFloat64(traces.Duration) * traces.SampleRate / 1000000) AS bWDur,
          quantilesTDigestWeightedState(0.5, 0.95)(Duration, toUInt32(greatest(SampleRate, 1.0))) AS bQ,
          max(toDateTime(traces.Timestamp)) AS bLastSeen
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= toDateTime('2026-01-01 10:30:00')
          AND traces.Timestamp <= toDateTime('2026-01-03 14:15:00')
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND traces.SpanKind IN ('Client', 'Producer')
          AND traces.ServiceName != ''
          AND coalesce(nullIf(traces.SpanAttributes['db.system.name'], ''), traces.SpanAttributes['db.system']) = 'postgresql'
        GROUP BY queryKey
) AS shapes
        GROUP BY queryKey) AS shape
        ORDER BY estimatedQueryCount DESC
        LIMIT 10
        FORMAT JSON

-- builder:service-map:serviceDependenciesForServiceQuery:default  [e832e6b5]
SELECT
          edges.sourceService AS sourceService,
          edges.targetService AS targetService,
          sum(edges.bucketCallCount) AS callCount,
          sum(edges.bucketErrorCount) AS errorCount,
          ifNull(ifNotFinite(sum(edges.bucketDurationSumMs) / nullIf(sum(edges.bucketCallCount), 0), 0), 0) AS avgDurationMs,
          max(edges.bucketMaxDurationMs) AS maxDurationMs,
          sum(edges.bucketEstimatedSpanCount) AS estimatedSpanCount
        FROM (
SELECT
          service_map_edges_hourly.SourceService AS sourceService,
          service_map_edges_hourly.TargetService AS targetService,
          sum(service_map_edges_hourly.CallCount) AS bucketCallCount,
          sum(service_map_edges_hourly.ErrorCount) AS bucketErrorCount,
          sum(service_map_edges_hourly.DurationSumMs) AS bucketDurationSumMs,
          max(service_map_edges_hourly.MaxDurationMs) AS bucketMaxDurationMs,
          sum(if(service_map_edges_hourly.SampleRateSum > 0, service_map_edges_hourly.SampleRateSum, toFloat64(service_map_edges_hourly.CallCount))) AS bucketEstimatedSpanCount
        FROM service_map_edges_hourly
        WHERE service_map_edges_hourly.OrgId = 'org_sql_catalog'
          AND service_map_edges_hourly.SourceService = 'web'
          AND service_map_edges_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND service_map_edges_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY sourceService, targetService
UNION ALL
SELECT
          p.ServiceName AS sourceService,
          c.ServiceName AS targetService,
          count() AS bucketCallCount,
          countIf(c.StatusCode = 'Error') AS bucketErrorCount,
          sum(c.Duration / 1000000) AS bucketDurationSumMs,
          max(c.Duration / 1000000) AS bucketMaxDurationMs,
          sum(multiIf(match(c.TraceState, 'th:[0-9a-f]+'), 1.0 / greatest(1.0 - reinterpretAsUInt64(reverse(unhex(rightPad(extract(c.TraceState, 'th:([0-9a-f]+)'), 16, '0')))) / pow(2.0, 64), 0.0001), 1.0)) AS bucketEstimatedSpanCount
        FROM (SELECT
          service_map_spans.OrgId AS OrgId,
          service_map_spans.Timestamp AS Timestamp,
          service_map_spans.TraceId AS TraceId,
          service_map_spans.SpanId AS SpanId,
          service_map_spans.ServiceName AS ServiceName,
          service_map_spans.DeploymentEnv AS DeploymentEnv
        FROM service_map_spans
        WHERE service_map_spans.SpanKind IN ('Client', 'Producer')
          AND service_map_spans.Timestamp >= toDateTime('2026-01-01 10:30:00')
          AND service_map_spans.Timestamp < toDateTime('2026-01-03 14:15:00')
          AND service_map_spans.OrgId = 'org_sql_catalog'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND service_map_spans.ServiceName = 'web') AS p
        INNER JOIN (SELECT
          service_map_children.TraceId AS TraceId,
          service_map_children.ParentSpanId AS ParentSpanId,
          service_map_children.ServiceName AS ServiceName,
          service_map_children.Duration AS Duration,
          service_map_children.StatusCode AS StatusCode,
          service_map_children.TraceState AS TraceState
        FROM service_map_children
        WHERE service_map_children.Timestamp >= toDateTime('2026-01-01 10:30:00')
          AND service_map_children.Timestamp < toDateTime('2026-01-03 14:15:00')
          AND service_map_children.OrgId = 'org_sql_catalog'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))) AS c ON (p.SpanId = c.ParentSpanId AND p.TraceId = c.TraceId)
        WHERE p.ServiceName != c.ServiceName
        GROUP BY sourceService, targetService
) AS edges
        GROUP BY sourceService, targetService
        ORDER BY callCount DESC
        LIMIT 200
        FORMAT JSON

-- builder:service-map:serviceDependenciesSQL:default  [2aa810d6]
SELECT
          edges.sourceService AS sourceService,
          edges.targetService AS targetService,
          sum(edges.bucketCallCount) AS callCount,
          sum(edges.bucketErrorCount) AS errorCount,
          ifNull(ifNotFinite(sum(edges.bucketDurationSumMs) / nullIf(sum(edges.bucketCallCount), 0), 0), 0) AS avgDurationMs,
          max(edges.bucketMaxDurationMs) AS maxDurationMs,
          sum(edges.bucketEstimatedSpanCount) AS estimatedSpanCount
        FROM (
SELECT
          service_map_edges_hourly.SourceService AS sourceService,
          service_map_edges_hourly.TargetService AS targetService,
          sum(service_map_edges_hourly.CallCount) AS bucketCallCount,
          sum(service_map_edges_hourly.ErrorCount) AS bucketErrorCount,
          sum(service_map_edges_hourly.DurationSumMs) AS bucketDurationSumMs,
          max(service_map_edges_hourly.MaxDurationMs) AS bucketMaxDurationMs,
          sum(if(service_map_edges_hourly.SampleRateSum > 0, service_map_edges_hourly.SampleRateSum, toFloat64(service_map_edges_hourly.CallCount))) AS bucketEstimatedSpanCount
        FROM service_map_edges_hourly
        WHERE service_map_edges_hourly.OrgId = 'org_sql_catalog'
          AND service_map_edges_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND service_map_edges_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY sourceService, targetService
UNION ALL
SELECT
          p.ServiceName AS sourceService,
          c.ServiceName AS targetService,
          count() AS bucketCallCount,
          countIf(c.StatusCode = 'Error') AS bucketErrorCount,
          sum(c.Duration / 1000000) AS bucketDurationSumMs,
          max(c.Duration / 1000000) AS bucketMaxDurationMs,
          sum(multiIf(match(c.TraceState, 'th:[0-9a-f]+'), 1.0 / greatest(1.0 - reinterpretAsUInt64(reverse(unhex(rightPad(extract(c.TraceState, 'th:([0-9a-f]+)'), 16, '0')))) / pow(2.0, 64), 0.0001), 1.0)) AS bucketEstimatedSpanCount
        FROM (SELECT
          service_map_spans.OrgId AS OrgId,
          service_map_spans.Timestamp AS Timestamp,
          service_map_spans.TraceId AS TraceId,
          service_map_spans.SpanId AS SpanId,
          service_map_spans.ServiceName AS ServiceName,
          service_map_spans.DeploymentEnv AS DeploymentEnv
        FROM service_map_spans
        WHERE service_map_spans.SpanKind IN ('Client', 'Producer')
          AND service_map_spans.Timestamp >= toDateTime('2026-01-01 10:30:00')
          AND service_map_spans.Timestamp < toDateTime('2026-01-03 14:15:00')
          AND service_map_spans.OrgId = 'org_sql_catalog'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))) AS p
        INNER JOIN (SELECT
          service_map_children.TraceId AS TraceId,
          service_map_children.ParentSpanId AS ParentSpanId,
          service_map_children.ServiceName AS ServiceName,
          service_map_children.Duration AS Duration,
          service_map_children.StatusCode AS StatusCode,
          service_map_children.TraceState AS TraceState
        FROM service_map_children
        WHERE service_map_children.Timestamp >= toDateTime('2026-01-01 10:30:00')
          AND service_map_children.Timestamp < toDateTime('2026-01-03 14:15:00')
          AND service_map_children.OrgId = 'org_sql_catalog'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))) AS c ON (p.SpanId = c.ParentSpanId AND p.TraceId = c.TraceId)
        WHERE p.ServiceName != c.ServiceName
        GROUP BY sourceService, targetService
) AS edges
        GROUP BY sourceService, targetService
        ORDER BY callCount DESC
        LIMIT 200
        FORMAT JSON

-- builder:service-map:serviceDependenciesSQL:env-scoped  [3f463d3e]
SELECT
          edges.sourceService AS sourceService,
          edges.targetService AS targetService,
          sum(edges.bucketCallCount) AS callCount,
          sum(edges.bucketErrorCount) AS errorCount,
          ifNull(ifNotFinite(sum(edges.bucketDurationSumMs) / nullIf(sum(edges.bucketCallCount), 0), 0), 0) AS avgDurationMs,
          max(edges.bucketMaxDurationMs) AS maxDurationMs,
          sum(edges.bucketEstimatedSpanCount) AS estimatedSpanCount
        FROM (
SELECT
          service_map_edges_hourly.SourceService AS sourceService,
          service_map_edges_hourly.TargetService AS targetService,
          sum(service_map_edges_hourly.CallCount) AS bucketCallCount,
          sum(service_map_edges_hourly.ErrorCount) AS bucketErrorCount,
          sum(service_map_edges_hourly.DurationSumMs) AS bucketDurationSumMs,
          max(service_map_edges_hourly.MaxDurationMs) AS bucketMaxDurationMs,
          sum(if(service_map_edges_hourly.SampleRateSum > 0, service_map_edges_hourly.SampleRateSum, toFloat64(service_map_edges_hourly.CallCount))) AS bucketEstimatedSpanCount
        FROM service_map_edges_hourly
        WHERE service_map_edges_hourly.OrgId = 'org_sql_catalog'
          AND service_map_edges_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND service_map_edges_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND service_map_edges_hourly.DeploymentEnv = 'production'
        GROUP BY sourceService, targetService
UNION ALL
SELECT
          p.ServiceName AS sourceService,
          c.ServiceName AS targetService,
          count() AS bucketCallCount,
          countIf(c.StatusCode = 'Error') AS bucketErrorCount,
          sum(c.Duration / 1000000) AS bucketDurationSumMs,
          max(c.Duration / 1000000) AS bucketMaxDurationMs,
          sum(multiIf(match(c.TraceState, 'th:[0-9a-f]+'), 1.0 / greatest(1.0 - reinterpretAsUInt64(reverse(unhex(rightPad(extract(c.TraceState, 'th:([0-9a-f]+)'), 16, '0')))) / pow(2.0, 64), 0.0001), 1.0)) AS bucketEstimatedSpanCount
        FROM (SELECT
          service_map_spans.OrgId AS OrgId,
          service_map_spans.Timestamp AS Timestamp,
          service_map_spans.TraceId AS TraceId,
          service_map_spans.SpanId AS SpanId,
          service_map_spans.ServiceName AS ServiceName,
          service_map_spans.DeploymentEnv AS DeploymentEnv
        FROM service_map_spans
        WHERE service_map_spans.SpanKind IN ('Client', 'Producer')
          AND service_map_spans.Timestamp >= toDateTime('2026-01-01 10:30:00')
          AND service_map_spans.Timestamp < toDateTime('2026-01-03 14:15:00')
          AND service_map_spans.OrgId = 'org_sql_catalog'
          AND service_map_spans.DeploymentEnv = 'production'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))) AS p
        INNER JOIN (SELECT
          service_map_children.TraceId AS TraceId,
          service_map_children.ParentSpanId AS ParentSpanId,
          service_map_children.ServiceName AS ServiceName,
          service_map_children.Duration AS Duration,
          service_map_children.StatusCode AS StatusCode,
          service_map_children.TraceState AS TraceState
        FROM service_map_children
        WHERE service_map_children.Timestamp >= toDateTime('2026-01-01 10:30:00')
          AND service_map_children.Timestamp < toDateTime('2026-01-03 14:15:00')
          AND service_map_children.OrgId = 'org_sql_catalog'
          AND service_map_children.DeploymentEnv = 'production'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))) AS c ON (p.SpanId = c.ParentSpanId AND p.TraceId = c.TraceId)
        WHERE p.ServiceName != c.ServiceName
        GROUP BY sourceService, targetService
) AS edges
        GROUP BY sourceService, targetService
        ORDER BY callCount DESC
        LIMIT 200
        FORMAT JSON

-- builder:service-map:serviceExternalEdgesSQL:default  [a24b0a4c]
SELECT
          edges.sourceService AS sourceService,
          edges.targetType AS targetType,
          edges.targetSystem AS targetSystem,
          edges.targetName AS targetName,
          sum(edges.bucketCallCount) AS callCount,
          sum(edges.bucketErrorCount) AS errorCount,
          ifNull(ifNotFinite(sum(edges.bucketDurationSumMs) / nullIf(sum(edges.bucketCallCount), 0), 0), 0) AS avgDurationMs,
          max(edges.bucketMaxDurationMs) AS maxDurationMs,
          if(sum(bucketCallCount) > 0, arrayElement(quantilesTDigestWeightedMerge(0.5, 0.95)(bucketDurationQuantiles), 2) / 1000000, 0) AS p95DurationMs,
          sum(edges.bucketEstimatedSpanCount) AS estimatedSpanCount
        FROM (
SELECT
          service_external_edges_hourly.ServiceName AS sourceService,
          service_external_edges_hourly.TargetType AS targetType,
          service_external_edges_hourly.TargetSystem AS targetSystem,
          service_external_edges_hourly.TargetName AS targetName,
          sum(service_external_edges_hourly.CallCount) AS bucketCallCount,
          sum(service_external_edges_hourly.ErrorCount) AS bucketErrorCount,
          sum(service_external_edges_hourly.DurationSumMs) AS bucketDurationSumMs,
          max(service_external_edges_hourly.MaxDurationMs) AS bucketMaxDurationMs,
          sum(if(service_external_edges_hourly.SampleRateSum > 0, service_external_edges_hourly.SampleRateSum, toFloat64(service_external_edges_hourly.CallCount))) AS bucketEstimatedSpanCount,
          quantilesTDigestWeightedMergeState(0.5, 0.95)(DurationQuantiles) AS bucketDurationQuantiles
        FROM service_external_edges_hourly
        WHERE service_external_edges_hourly.OrgId = 'org_sql_catalog'
          AND service_external_edges_hourly.ServiceName = 'web'
          AND service_external_edges_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND service_external_edges_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND service_external_edges_hourly.TargetName != ''
        GROUP BY sourceService, targetType, targetSystem, targetName
UNION ALL
SELECT
          traces.ServiceName AS sourceService,
          multiIf((coalesce(nullIf(traces.SpanAttributes['messaging.destination.name'], ''), traces.SpanAttributes['messaging.destination']) != '' OR traces.SpanAttributes['messaging.system'] != ''), 'messaging', (traces.SpanAttributes['rpc.service'] != '' OR traces.SpanAttributes['rpc.system'] != ''), 'rpc', 'http') AS targetType,
          multiIf((coalesce(nullIf(traces.SpanAttributes['messaging.destination.name'], ''), traces.SpanAttributes['messaging.destination']) != '' OR traces.SpanAttributes['messaging.system'] != ''), traces.SpanAttributes['messaging.system'], (traces.SpanAttributes['rpc.service'] != '' OR traces.SpanAttributes['rpc.system'] != ''), traces.SpanAttributes['rpc.system'], '') AS targetSystem,
          multiIf((coalesce(nullIf(traces.SpanAttributes['messaging.destination.name'], ''), traces.SpanAttributes['messaging.destination']) != '' OR traces.SpanAttributes['messaging.system'] != ''), if(coalesce(nullIf(traces.SpanAttributes['messaging.destination.name'], ''), traces.SpanAttributes['messaging.destination']) != '', coalesce(nullIf(traces.SpanAttributes['messaging.destination.name'], ''), traces.SpanAttributes['messaging.destination']), traces.SpanAttributes['messaging.system']), (traces.SpanAttributes['rpc.service'] != '' OR traces.SpanAttributes['rpc.system'] != ''), if(traces.SpanAttributes['rpc.service'] != '', traces.SpanAttributes['rpc.service'], traces.SpanAttributes['rpc.system']), if(traces.SpanAttributes['server.address'] != '', traces.SpanAttributes['server.address'], if(traces.SpanAttributes['http.host'] != '', traces.SpanAttributes['http.host'], traces.SpanAttributes['url.authority']))) AS targetName,
          count() AS bucketCallCount,
          countIf(traces.StatusCode = 'Error') AS bucketErrorCount,
          sum(traces.Duration / 1000000) AS bucketDurationSumMs,
          max(traces.Duration / 1000000) AS bucketMaxDurationMs,
          sum(traces.SampleRate) AS bucketEstimatedSpanCount,
          quantilesTDigestWeightedState(0.5, 0.95)(Duration, toUInt32(greatest(SampleRate, 1.0))) AS bucketDurationQuantiles
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.ServiceName = 'web'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND traces.SpanKind IN ('Client', 'Producer')
          AND traces.SpanAttributes['db.system.name'] = ''
          AND ((((((traces.SpanAttributes['server.address'] != '' OR traces.SpanAttributes['http.host'] != '') OR traces.SpanAttributes['url.authority'] != '') OR coalesce(nullIf(traces.SpanAttributes['messaging.destination.name'], ''), traces.SpanAttributes['messaging.destination']) != '') OR traces.SpanAttributes['messaging.system'] != '') OR traces.SpanAttributes['rpc.service'] != '') OR traces.SpanAttributes['rpc.system'] != '')
        GROUP BY sourceService, targetType, targetSystem, targetName
        HAVING targetName != ''
) AS edges
        WHERE NOT ((edges.targetType = 'http' AND edges.targetName IN (SELECT
          service_address_resolutions_hourly.ParentServerAddress AS ParentServerAddress
        FROM service_address_resolutions_hourly
        WHERE service_address_resolutions_hourly.OrgId = 'org_sql_catalog'
          AND service_address_resolutions_hourly.SourceService = 'web'
          AND service_address_resolutions_hourly.Hour >= toStartOfHour(toDateTime('2026-01-01 10:30:00'))
          AND service_address_resolutions_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND service_address_resolutions_hourly.ParentServerAddress != ''
        GROUP BY ParentServerAddress)))
        GROUP BY sourceService, targetType, targetSystem, targetName
        ORDER BY callCount DESC
        LIMIT 200
        FORMAT JSON

-- builder:service-map:serviceExternalEdgesSQL:env-scoped  [616f7d2f]
SELECT
          edges.sourceService AS sourceService,
          edges.targetType AS targetType,
          edges.targetSystem AS targetSystem,
          edges.targetName AS targetName,
          sum(edges.bucketCallCount) AS callCount,
          sum(edges.bucketErrorCount) AS errorCount,
          ifNull(ifNotFinite(sum(edges.bucketDurationSumMs) / nullIf(sum(edges.bucketCallCount), 0), 0), 0) AS avgDurationMs,
          max(edges.bucketMaxDurationMs) AS maxDurationMs,
          if(sum(bucketCallCount) > 0, arrayElement(quantilesTDigestWeightedMerge(0.5, 0.95)(bucketDurationQuantiles), 2) / 1000000, 0) AS p95DurationMs,
          sum(edges.bucketEstimatedSpanCount) AS estimatedSpanCount
        FROM (
SELECT
          service_external_edges_hourly.ServiceName AS sourceService,
          service_external_edges_hourly.TargetType AS targetType,
          service_external_edges_hourly.TargetSystem AS targetSystem,
          service_external_edges_hourly.TargetName AS targetName,
          sum(service_external_edges_hourly.CallCount) AS bucketCallCount,
          sum(service_external_edges_hourly.ErrorCount) AS bucketErrorCount,
          sum(service_external_edges_hourly.DurationSumMs) AS bucketDurationSumMs,
          max(service_external_edges_hourly.MaxDurationMs) AS bucketMaxDurationMs,
          sum(if(service_external_edges_hourly.SampleRateSum > 0, service_external_edges_hourly.SampleRateSum, toFloat64(service_external_edges_hourly.CallCount))) AS bucketEstimatedSpanCount,
          quantilesTDigestWeightedMergeState(0.5, 0.95)(DurationQuantiles) AS bucketDurationQuantiles
        FROM service_external_edges_hourly
        WHERE service_external_edges_hourly.OrgId = 'org_sql_catalog'
          AND service_external_edges_hourly.ServiceName = 'web'
          AND service_external_edges_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND service_external_edges_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND service_external_edges_hourly.TargetName != ''
          AND service_external_edges_hourly.DeploymentEnv = 'production'
        GROUP BY sourceService, targetType, targetSystem, targetName
UNION ALL
SELECT
          traces.ServiceName AS sourceService,
          multiIf((coalesce(nullIf(traces.SpanAttributes['messaging.destination.name'], ''), traces.SpanAttributes['messaging.destination']) != '' OR traces.SpanAttributes['messaging.system'] != ''), 'messaging', (traces.SpanAttributes['rpc.service'] != '' OR traces.SpanAttributes['rpc.system'] != ''), 'rpc', 'http') AS targetType,
          multiIf((coalesce(nullIf(traces.SpanAttributes['messaging.destination.name'], ''), traces.SpanAttributes['messaging.destination']) != '' OR traces.SpanAttributes['messaging.system'] != ''), traces.SpanAttributes['messaging.system'], (traces.SpanAttributes['rpc.service'] != '' OR traces.SpanAttributes['rpc.system'] != ''), traces.SpanAttributes['rpc.system'], '') AS targetSystem,
          multiIf((coalesce(nullIf(traces.SpanAttributes['messaging.destination.name'], ''), traces.SpanAttributes['messaging.destination']) != '' OR traces.SpanAttributes['messaging.system'] != ''), if(coalesce(nullIf(traces.SpanAttributes['messaging.destination.name'], ''), traces.SpanAttributes['messaging.destination']) != '', coalesce(nullIf(traces.SpanAttributes['messaging.destination.name'], ''), traces.SpanAttributes['messaging.destination']), traces.SpanAttributes['messaging.system']), (traces.SpanAttributes['rpc.service'] != '' OR traces.SpanAttributes['rpc.system'] != ''), if(traces.SpanAttributes['rpc.service'] != '', traces.SpanAttributes['rpc.service'], traces.SpanAttributes['rpc.system']), if(traces.SpanAttributes['server.address'] != '', traces.SpanAttributes['server.address'], if(traces.SpanAttributes['http.host'] != '', traces.SpanAttributes['http.host'], traces.SpanAttributes['url.authority']))) AS targetName,
          count() AS bucketCallCount,
          countIf(traces.StatusCode = 'Error') AS bucketErrorCount,
          sum(traces.Duration / 1000000) AS bucketDurationSumMs,
          max(traces.Duration / 1000000) AS bucketMaxDurationMs,
          sum(traces.SampleRate) AS bucketEstimatedSpanCount,
          quantilesTDigestWeightedState(0.5, 0.95)(Duration, toUInt32(greatest(SampleRate, 1.0))) AS bucketDurationQuantiles
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.ServiceName = 'web'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND traces.SpanKind IN ('Client', 'Producer')
          AND traces.SpanAttributes['db.system.name'] = ''
          AND ((((((traces.SpanAttributes['server.address'] != '' OR traces.SpanAttributes['http.host'] != '') OR traces.SpanAttributes['url.authority'] != '') OR coalesce(nullIf(traces.SpanAttributes['messaging.destination.name'], ''), traces.SpanAttributes['messaging.destination']) != '') OR traces.SpanAttributes['messaging.system'] != '') OR traces.SpanAttributes['rpc.service'] != '') OR traces.SpanAttributes['rpc.system'] != '')
          AND coalesce(nullIf(traces.ResourceAttributes['deployment.environment.name'], ''), traces.ResourceAttributes['deployment.environment']) = 'production'
        GROUP BY sourceService, targetType, targetSystem, targetName
        HAVING targetName != ''
) AS edges
        WHERE NOT ((edges.targetType = 'http' AND edges.targetName IN (SELECT
          service_address_resolutions_hourly.ParentServerAddress AS ParentServerAddress
        FROM service_address_resolutions_hourly
        WHERE service_address_resolutions_hourly.OrgId = 'org_sql_catalog'
          AND service_address_resolutions_hourly.SourceService = 'web'
          AND service_address_resolutions_hourly.Hour >= toStartOfHour(toDateTime('2026-01-01 10:30:00'))
          AND service_address_resolutions_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND service_address_resolutions_hourly.ParentServerAddress != ''
          AND service_address_resolutions_hourly.DeploymentEnv = 'production'
        GROUP BY ParentServerAddress)))
        GROUP BY sourceService, targetType, targetSystem, targetName
        ORDER BY callCount DESC
        LIMIT 200
        FORMAT JSON

-- builder:service-map:serviceMapEdgeJoinQuery:rollup-hour  [f4240642]
SELECT
          p.OrgId AS OrgId,
          toStartOfHour(p.Timestamp) AS Hour,
          p.ServiceName AS SourceService,
          c.ServiceName AS TargetService,
          p.DeploymentEnv AS DeploymentEnv,
          count() AS CallCount,
          countIf(c.StatusCode = 'Error') AS ErrorCount,
          sum(c.Duration / 1000000) AS DurationSumMs,
          max(c.Duration / 1000000) AS MaxDurationMs,
          countIf(match(c.TraceState, 'th:[0-9a-f]+')) AS SampledSpanCount,
          countIf(NOT (match(c.TraceState, 'th:[0-9a-f]+'))) AS UnsampledSpanCount,
          sum(multiIf(match(c.TraceState, 'th:[0-9a-f]+'), 1.0 / greatest(1.0 - reinterpretAsUInt64(reverse(unhex(rightPad(extract(c.TraceState, 'th:([0-9a-f]+)'), 16, '0')))) / pow(2.0, 64), 0.0001), 1.0)) AS SampleRateSum
        FROM (SELECT
          service_map_spans.OrgId AS OrgId,
          service_map_spans.Timestamp AS Timestamp,
          service_map_spans.TraceId AS TraceId,
          service_map_spans.SpanId AS SpanId,
          service_map_spans.ServiceName AS ServiceName,
          service_map_spans.DeploymentEnv AS DeploymentEnv
        FROM service_map_spans
        WHERE service_map_spans.SpanKind IN ('Client', 'Producer')
          AND service_map_spans.Timestamp >= toDateTime('2026-01-01 10:30:00')
          AND service_map_spans.Timestamp < toDateTime('2026-01-03 14:15:00')
          AND service_map_spans.OrgId = 'org_sql_catalog') AS p
        INNER JOIN (SELECT
          service_map_children.TraceId AS TraceId,
          service_map_children.ParentSpanId AS ParentSpanId,
          service_map_children.ServiceName AS ServiceName,
          service_map_children.Duration AS Duration,
          service_map_children.StatusCode AS StatusCode,
          service_map_children.TraceState AS TraceState
        FROM service_map_children
        WHERE service_map_children.Timestamp >= toDateTime('2026-01-01 10:30:00')
          AND service_map_children.Timestamp < toDateTime('2026-01-03 14:15:00')
          AND service_map_children.OrgId = 'org_sql_catalog') AS c ON (p.SpanId = c.ParentSpanId AND p.TraceId = c.TraceId)
        WHERE p.ServiceName != c.ServiceName
        GROUP BY OrgId, Hour, SourceService, TargetService, DeploymentEnv
        FORMAT JSON

-- builder:service-map:serviceMapEdgeJoinQuery:scoped-to-service  [f0f11d97]
SELECT
          p.OrgId AS OrgId,
          toStartOfHour(p.Timestamp) AS Hour,
          p.ServiceName AS SourceService,
          c.ServiceName AS TargetService,
          p.DeploymentEnv AS DeploymentEnv,
          count() AS CallCount,
          countIf(c.StatusCode = 'Error') AS ErrorCount,
          sum(c.Duration / 1000000) AS DurationSumMs,
          max(c.Duration / 1000000) AS MaxDurationMs,
          countIf(match(c.TraceState, 'th:[0-9a-f]+')) AS SampledSpanCount,
          countIf(NOT (match(c.TraceState, 'th:[0-9a-f]+'))) AS UnsampledSpanCount,
          sum(multiIf(match(c.TraceState, 'th:[0-9a-f]+'), 1.0 / greatest(1.0 - reinterpretAsUInt64(reverse(unhex(rightPad(extract(c.TraceState, 'th:([0-9a-f]+)'), 16, '0')))) / pow(2.0, 64), 0.0001), 1.0)) AS SampleRateSum
        FROM (SELECT
          service_map_spans.OrgId AS OrgId,
          service_map_spans.Timestamp AS Timestamp,
          service_map_spans.TraceId AS TraceId,
          service_map_spans.SpanId AS SpanId,
          service_map_spans.ServiceName AS ServiceName,
          service_map_spans.DeploymentEnv AS DeploymentEnv
        FROM service_map_spans
        WHERE service_map_spans.SpanKind IN ('Client', 'Producer')
          AND service_map_spans.Timestamp >= toDateTime('2026-01-01 10:30:00')
          AND service_map_spans.Timestamp < toDateTime('2026-01-03 14:15:00')
          AND service_map_spans.OrgId = 'org_sql_catalog'
          AND service_map_spans.DeploymentEnv = 'production'
          AND service_map_spans.ServiceName = 'web') AS p
        INNER JOIN (SELECT
          service_map_children.TraceId AS TraceId,
          service_map_children.ParentSpanId AS ParentSpanId,
          service_map_children.ServiceName AS ServiceName,
          service_map_children.Duration AS Duration,
          service_map_children.StatusCode AS StatusCode,
          service_map_children.TraceState AS TraceState
        FROM service_map_children
        WHERE service_map_children.Timestamp >= toDateTime('2026-01-01 10:30:00')
          AND service_map_children.Timestamp < toDateTime('2026-01-03 14:15:00')
          AND service_map_children.OrgId = 'org_sql_catalog'
          AND service_map_children.DeploymentEnv = 'production') AS c ON (p.SpanId = c.ParentSpanId AND p.TraceId = c.TraceId)
        WHERE p.ServiceName != c.ServiceName
        GROUP BY OrgId, Hour, SourceService, TargetService, DeploymentEnv
        FORMAT JSON

-- builder:service-operations:serviceOperationsSummaryQuery:default  [84fbd092]
SELECT
          operation_windows.bSpanName AS spanName,
          sum(operation_windows.bSpanCount) AS spanCount,
          sum(operation_windows.bEstimatedSpanCount) AS estimatedSpanCount,
          sum(operation_windows.bErrorCount) AS errorCount,
          sum(operation_windows.bEstimatedErrorCount) AS estimatedErrorCount,
          if(sum(operation_windows.bEstimatedSpanCount) > 0, sum(operation_windows.bEstimatedErrorCount) / sum(operation_windows.bEstimatedSpanCount), 0) AS errorRate,
          if(sum(operation_windows.bSpanCount) > 0, sum(operation_windows.bDurationSum) / sum(operation_windows.bSpanCount) / 1000000, 0) AS avgDurationMs,
          if(sum(bSpanCount) > 0, arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 1) / 1000000, 0) AS p50DurationMs,
          if(sum(bSpanCount) > 0, arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 2) / 1000000, 0) AS p95DurationMs,
          if(sum(bSpanCount) > 0, arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 3) / 1000000, 0) AS p99DurationMs
        FROM (
SELECT
          if(((traces.SpanName LIKE 'http.server %' OR traces.SpanName IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')) AND (traces.SpanAttributes['http.route'] != '' OR traces.SpanAttributes['url.path'] != '')), concat(if(traces.SpanName LIKE 'http.server %', replaceOne(traces.SpanName, 'http.server ', ''), traces.SpanName), ' ', if(traces.SpanAttributes['http.route'] != '', traces.SpanAttributes['http.route'], traces.SpanAttributes['url.path'])), traces.SpanName) AS bSpanName,
          count() AS bSpanCount,
          sum(traces.SampleRate) AS bEstimatedSpanCount,
          countIf(traces.StatusCode = 'Error') AS bErrorCount,
          sumIf(traces.SampleRate, traces.StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND traces.ServiceName = 'api'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 MINUTE) OR Timestamp >= toStartOfMinute(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bSpanName
UNION ALL
SELECT
          service_operations_minutely.SpanName AS bSpanName,
          sum(service_operations_minutely.SpanCount) AS bSpanCount,
          sum(service_operations_minutely.EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(service_operations_minutely.ErrorCount) AS bErrorCount,
          sum(service_operations_minutely.EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(service_operations_minutely.DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles
        FROM service_operations_minutely
        WHERE service_operations_minutely.OrgId = 'org_sql_catalog'
          AND service_operations_minutely.ServiceName = 'api'
          AND service_operations_minutely.Minute >= if(toDateTime('2026-01-01 10:30:00') = toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 MINUTE)
          AND service_operations_minutely.Minute < toStartOfMinute(toDateTime('2026-01-03 14:15:00'))
          AND (Minute < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Minute >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bSpanName
UNION ALL
SELECT
          service_operations_hourly.SpanName AS bSpanName,
          sum(service_operations_hourly.SpanCount) AS bSpanCount,
          sum(service_operations_hourly.EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(service_operations_hourly.ErrorCount) AS bErrorCount,
          sum(service_operations_hourly.EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(service_operations_hourly.DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles
        FROM service_operations_hourly
        WHERE service_operations_hourly.OrgId = 'org_sql_catalog'
          AND service_operations_hourly.ServiceName = 'api'
          AND service_operations_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND service_operations_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bSpanName
) AS operation_windows
        GROUP BY spanName
        ORDER BY estimatedSpanCount DESC
        LIMIT 50
        FORMAT JSON

-- builder:service-operations:serviceOperationsSummaryQuery:envFiltered  [6be67b06]
SELECT
          operation_windows.bSpanName AS spanName,
          sum(operation_windows.bSpanCount) AS spanCount,
          sum(operation_windows.bEstimatedSpanCount) AS estimatedSpanCount,
          sum(operation_windows.bErrorCount) AS errorCount,
          sum(operation_windows.bEstimatedErrorCount) AS estimatedErrorCount,
          if(sum(operation_windows.bEstimatedSpanCount) > 0, sum(operation_windows.bEstimatedErrorCount) / sum(operation_windows.bEstimatedSpanCount), 0) AS errorRate,
          if(sum(operation_windows.bSpanCount) > 0, sum(operation_windows.bDurationSum) / sum(operation_windows.bSpanCount) / 1000000, 0) AS avgDurationMs,
          if(sum(bSpanCount) > 0, arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 1) / 1000000, 0) AS p50DurationMs,
          if(sum(bSpanCount) > 0, arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 2) / 1000000, 0) AS p95DurationMs,
          if(sum(bSpanCount) > 0, arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 3) / 1000000, 0) AS p99DurationMs
        FROM (
SELECT
          if(((traces.SpanName LIKE 'http.server %' OR traces.SpanName IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')) AND (traces.SpanAttributes['http.route'] != '' OR traces.SpanAttributes['url.path'] != '')), concat(if(traces.SpanName LIKE 'http.server %', replaceOne(traces.SpanName, 'http.server ', ''), traces.SpanName), ' ', if(traces.SpanAttributes['http.route'] != '', traces.SpanAttributes['http.route'], traces.SpanAttributes['url.path'])), traces.SpanName) AS bSpanName,
          count() AS bSpanCount,
          sum(traces.SampleRate) AS bEstimatedSpanCount,
          countIf(traces.StatusCode = 'Error') AS bErrorCount,
          sumIf(traces.SampleRate, traces.StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND traces.ServiceName = 'api'
          AND coalesce(nullIf(traces.ResourceAttributes['deployment.environment.name'], ''), traces.ResourceAttributes['deployment.environment']) IN ('production')
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 MINUTE) OR Timestamp >= toStartOfMinute(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bSpanName
UNION ALL
SELECT
          service_operations_minutely.SpanName AS bSpanName,
          sum(service_operations_minutely.SpanCount) AS bSpanCount,
          sum(service_operations_minutely.EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(service_operations_minutely.ErrorCount) AS bErrorCount,
          sum(service_operations_minutely.EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(service_operations_minutely.DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles
        FROM service_operations_minutely
        WHERE service_operations_minutely.OrgId = 'org_sql_catalog'
          AND service_operations_minutely.ServiceName = 'api'
          AND service_operations_minutely.DeploymentEnv IN ('production')
          AND service_operations_minutely.Minute >= if(toDateTime('2026-01-01 10:30:00') = toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 MINUTE)
          AND service_operations_minutely.Minute < toStartOfMinute(toDateTime('2026-01-03 14:15:00'))
          AND (Minute < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Minute >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bSpanName
UNION ALL
SELECT
          service_operations_hourly.SpanName AS bSpanName,
          sum(service_operations_hourly.SpanCount) AS bSpanCount,
          sum(service_operations_hourly.EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(service_operations_hourly.ErrorCount) AS bErrorCount,
          sum(service_operations_hourly.EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(service_operations_hourly.DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles
        FROM service_operations_hourly
        WHERE service_operations_hourly.OrgId = 'org_sql_catalog'
          AND service_operations_hourly.ServiceName = 'api'
          AND service_operations_hourly.DeploymentEnv IN ('production')
          AND service_operations_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND service_operations_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bSpanName
) AS operation_windows
        GROUP BY spanName
        ORDER BY estimatedSpanCount DESC
        LIMIT 50
        FORMAT JSON

-- builder:service-operations:serviceOperationsTimeseriesQuery:default  [df7a2f46]
SELECT
          operation_buckets.bucket AS bucket,
          operation_buckets.spanName AS spanName,
          sum(operation_buckets.count) AS count
        FROM (
SELECT
          toStartOfInterval(traces.Timestamp, INTERVAL 300 SECOND) AS bucket,
          if(((traces.SpanName LIKE 'http.server %' OR traces.SpanName IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')) AND (traces.SpanAttributes['http.route'] != '' OR traces.SpanAttributes['url.path'] != '')), concat(if(traces.SpanName LIKE 'http.server %', replaceOne(traces.SpanName, 'http.server ', ''), traces.SpanName), ' ', if(traces.SpanAttributes['http.route'] != '', traces.SpanAttributes['http.route'], traces.SpanAttributes['url.path'])), traces.SpanName) AS spanName,
          sum(traces.SampleRate) AS count
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND traces.ServiceName = 'api'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 MINUTE) OR Timestamp >= toStartOfMinute(toDateTime('2026-01-03 14:15:00')))
          AND if(((traces.SpanName LIKE 'http.server %' OR traces.SpanName IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')) AND (traces.SpanAttributes['http.route'] != '' OR traces.SpanAttributes['url.path'] != '')), concat(if(traces.SpanName LIKE 'http.server %', replaceOne(traces.SpanName, 'http.server ', ''), traces.SpanName), ' ', if(traces.SpanAttributes['http.route'] != '', traces.SpanAttributes['http.route'], traces.SpanAttributes['url.path'])), traces.SpanName) IN ('GET /v2/services', 'POST /v2/alerts')
        GROUP BY bucket, spanName
UNION ALL
SELECT
          toStartOfInterval(service_operations_minutely.Minute, INTERVAL 300 SECOND) AS bucket,
          service_operations_minutely.SpanName AS spanName,
          sum(service_operations_minutely.EstimatedSpanCount) AS count
        FROM service_operations_minutely
        WHERE service_operations_minutely.OrgId = 'org_sql_catalog'
          AND service_operations_minutely.ServiceName = 'api'
          AND service_operations_minutely.Minute >= if(toDateTime('2026-01-01 10:30:00') = toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 MINUTE)
          AND service_operations_minutely.Minute < toStartOfMinute(toDateTime('2026-01-03 14:15:00'))
          AND service_operations_minutely.SpanName IN ('GET /v2/services', 'POST /v2/alerts')
        GROUP BY bucket, spanName
) AS operation_buckets
        GROUP BY bucket, spanName
        ORDER BY bucket ASC
        LIMIT 10000
        FORMAT JSON

-- builder:services:serviceCatalogQuery:default  [510c3e6d]
SELECT
          service_windows.bServiceName AS serviceName,
          arraySort(arrayFilter(x -> x != '', arrayDistinct(groupArray(bServiceNamespace)))) AS serviceNamespaces,
          arraySort(arrayFilter(x -> x != '', arrayDistinct(groupArray(bEnvironment)))) AS deploymentEnvironments,
          sum(service_windows.bSpanCount) AS spanCount,
          sum(service_windows.bErrorCount) AS errorCount,
          sum(service_windows.bEstimatedErrorCount) AS estimatedErrorCount,
          sum(service_windows.bEstimatedSpanCount) AS estimatedSpanCount,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 1) / 1000000 AS p50LatencyMs,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 2) / 1000000 AS p95LatencyMs,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 3) / 1000000 AS p99LatencyMs
        FROM (
SELECT
          toStartOfHour(service_overview_spans.Timestamp) AS bBucket,
          service_overview_spans.ServiceName AS bServiceName,
          service_overview_spans.ServiceNamespace AS bServiceNamespace,
          service_overview_spans.DeploymentEnv AS bEnvironment,
          service_overview_spans.CommitSha AS bCommitSha,
          count() AS bSpanCount,
          sum(service_overview_spans.SampleRate) AS bEstimatedSpanCount,
          countIf(service_overview_spans.StatusCode = 'Error') AS bErrorCount,
          sumIf(service_overview_spans.SampleRate, service_overview_spans.StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          min(service_overview_spans.Timestamp) AS bFirstSeen,
          countIf((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration < 500000000)) AS bApdexSatisfiedCount,
          countIf(((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration >= 500000000) AND service_overview_spans.Duration < 2000000000)) AS bApdexToleratingCount
        FROM service_overview_spans
        WHERE service_overview_spans.OrgId = 'org_sql_catalog'
          AND service_overview_spans.Timestamp >= '2026-01-01 10:30:00'
          AND service_overview_spans.Timestamp <= '2026-01-03 14:15:00'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
UNION ALL
SELECT
          service_overview_hourly.Hour AS bBucket,
          service_overview_hourly.ServiceName AS bServiceName,
          service_overview_hourly.ServiceNamespace AS bServiceNamespace,
          service_overview_hourly.DeploymentEnv AS bEnvironment,
          service_overview_hourly.CommitSha AS bCommitSha,
          sum(service_overview_hourly.SpanCount) AS bSpanCount,
          sum(service_overview_hourly.EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(service_overview_hourly.ErrorCount) AS bErrorCount,
          sum(service_overview_hourly.EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(service_overview_hourly.DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          min(service_overview_hourly.FirstSeen) AS bFirstSeen,
          sum(service_overview_hourly.ApdexSatisfiedCount) AS bApdexSatisfiedCount,
          sum(service_overview_hourly.ApdexToleratingCount) AS bApdexToleratingCount
        FROM service_overview_hourly
        WHERE service_overview_hourly.OrgId = 'org_sql_catalog'
          AND service_overview_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND service_overview_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
) AS service_windows
        GROUP BY serviceName
        ORDER BY estimatedSpanCount DESC, serviceName ASC
        LIMIT 50
        OFFSET 0
        FORMAT JSON

-- builder:services:serviceCatalogQuery:filtered  [69edc1bb]
SELECT
          service_windows.bServiceName AS serviceName,
          arraySort(arrayFilter(x -> x != '', arrayDistinct(groupArray(bServiceNamespace)))) AS serviceNamespaces,
          arraySort(arrayFilter(x -> x != '', arrayDistinct(groupArray(bEnvironment)))) AS deploymentEnvironments,
          sum(service_windows.bSpanCount) AS spanCount,
          sum(service_windows.bErrorCount) AS errorCount,
          sum(service_windows.bEstimatedErrorCount) AS estimatedErrorCount,
          sum(service_windows.bEstimatedSpanCount) AS estimatedSpanCount,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 1) / 1000000 AS p50LatencyMs,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 2) / 1000000 AS p95LatencyMs,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 3) / 1000000 AS p99LatencyMs
        FROM (
SELECT
          toStartOfHour(service_overview_spans.Timestamp) AS bBucket,
          service_overview_spans.ServiceName AS bServiceName,
          service_overview_spans.ServiceNamespace AS bServiceNamespace,
          service_overview_spans.DeploymentEnv AS bEnvironment,
          service_overview_spans.CommitSha AS bCommitSha,
          count() AS bSpanCount,
          sum(service_overview_spans.SampleRate) AS bEstimatedSpanCount,
          countIf(service_overview_spans.StatusCode = 'Error') AS bErrorCount,
          sumIf(service_overview_spans.SampleRate, service_overview_spans.StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          min(service_overview_spans.Timestamp) AS bFirstSeen,
          countIf((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration < 500000000)) AS bApdexSatisfiedCount,
          countIf(((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration >= 500000000) AND service_overview_spans.Duration < 2000000000)) AS bApdexToleratingCount
        FROM service_overview_spans
        WHERE service_overview_spans.OrgId = 'org_sql_catalog'
          AND service_overview_spans.Timestamp >= '2026-01-01 10:30:00'
          AND service_overview_spans.Timestamp <= '2026-01-03 14:15:00'
          AND service_overview_spans.ServiceName = 'api'
          AND service_overview_spans.DeploymentEnv IN ('production')
          AND service_overview_spans.ServiceNamespace IN ('backend')
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
UNION ALL
SELECT
          service_overview_hourly.Hour AS bBucket,
          service_overview_hourly.ServiceName AS bServiceName,
          service_overview_hourly.ServiceNamespace AS bServiceNamespace,
          service_overview_hourly.DeploymentEnv AS bEnvironment,
          service_overview_hourly.CommitSha AS bCommitSha,
          sum(service_overview_hourly.SpanCount) AS bSpanCount,
          sum(service_overview_hourly.EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(service_overview_hourly.ErrorCount) AS bErrorCount,
          sum(service_overview_hourly.EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(service_overview_hourly.DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          min(service_overview_hourly.FirstSeen) AS bFirstSeen,
          sum(service_overview_hourly.ApdexSatisfiedCount) AS bApdexSatisfiedCount,
          sum(service_overview_hourly.ApdexToleratingCount) AS bApdexToleratingCount
        FROM service_overview_hourly
        WHERE service_overview_hourly.OrgId = 'org_sql_catalog'
          AND service_overview_hourly.ServiceName = 'api'
          AND service_overview_hourly.DeploymentEnv IN ('production')
          AND service_overview_hourly.ServiceNamespace IN ('backend')
          AND service_overview_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND service_overview_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
) AS service_windows
        GROUP BY serviceName
        ORDER BY estimatedSpanCount DESC, serviceName ASC
        LIMIT 50
        OFFSET 0
        FORMAT JSON

-- builder:session-events:sessionActivityQuery:default  [bb249b01]
SELECT
          g.sessionId AS sessionId,
          sumIf(g.gapMs, (g.gapMs > 0 AND g.gapMs <= 15000)) AS activeTimeMs,
          sumIf(g.gapMs, g.gapMs > 15000) AS idleTimeMs,
          count() AS eventCount
        FROM (SELECT
          session_events.SessionId AS sessionId,
          toFloat64(toUnixTimestamp64Nano(session_events.Timestamp) - toUnixTimestamp64Nano(lagInFrame(session_events.Timestamp, 1, session_events.Timestamp) OVER (PARTITION BY session_events.SessionId ORDER BY session_events.Timestamp ASC, session_events.Seq ASC ROWS BETWEEN 1 PRECEDING AND CURRENT ROW))) / 1000000 AS gapMs
        FROM session_events
        WHERE session_events.OrgId = 'org_sql_catalog'
          AND session_events.SessionId = 'sess_0af7651916cd43dd'
          AND session_events.Timestamp >= '2026-01-01 10:30:00'
          AND session_events.Timestamp <= '2026-01-03 14:15:00') AS g
        GROUP BY sessionId
        LIMIT 1
        FORMAT JSON

-- builder:session-events:sessionTranscriptQuery:default  [87352edd]
SELECT
          session_events.Timestamp AS timestamp,
          session_events.Seq AS seq,
          session_events.Type AS type,
          session_events.Url AS url,
          session_events.TraceId AS traceId,
          session_events.Level AS level,
          session_events.Message AS message,
          session_events.TargetSelector AS targetSelector,
          session_events.TargetText AS targetText,
          session_events.NetMethod AS netMethod,
          session_events.NetUrl AS netUrl,
          session_events.NetStatus AS netStatus,
          session_events.NetDurationMs AS netDurationMs,
          session_events.ErrorStack AS errorStack,
          toJSONString(session_events.Attributes) AS attributes
        FROM session_events
        WHERE session_events.OrgId = 'org_sql_catalog'
          AND session_events.SessionId = 'sess_0af7651916cd43dd'
          AND session_events.Timestamp >= '2026-01-01 10:30:00'
          AND session_events.Timestamp <= '2026-01-03 14:15:00'
        ORDER BY timestamp ASC, seq ASC
        LIMIT 100
        OFFSET 0
        FORMAT JSON

-- builder:session-replays:getSessionReplayQuery:default  [b6587e9d]
SELECT
          session_replays.Version AS version,
          session_replays.SessionId AS sessionId,
          session_replays.StartTime AS startTime,
          session_replays.EndTime AS endTime,
          session_replays.DurationMs AS durationMs,
          session_replays.Status AS status,
          session_replays.UserId AS userId,
          session_replays.UrlInitial AS urlInitial,
          session_replays.UserAgent AS userAgent,
          session_replays.BrowserName AS browserName,
          session_replays.OsName AS osName,
          session_replays.DeviceType AS deviceType,
          session_replays.Country AS country,
          session_replays.ServiceName AS serviceName,
          session_replays.PageViews AS pageViews,
          session_replays.ClickCount AS clickCount,
          session_replays.ErrorCount AS errorCount,
          session_replays.TraceIds AS traceIds,
          toJSONString(session_replays.ResourceAttributes) AS resourceAttributes,
          session_replays.VisitorId AS visitorId,
          session_replays.VisitorIsNew AS visitorIsNew,
          session_replays.UserEmail AS userEmail,
          session_replays.UserName AS userName,
          session_replays.GroupId AS groupId,
          session_replays.GroupName AS groupName,
          toJSONString(session_replays.UserTraits) AS userTraits,
          session_replays.Referrer AS referrer,
          session_replays.ReferrerHost AS referrerHost,
          session_replays.UtmSource AS utmSource,
          session_replays.UtmMedium AS utmMedium,
          session_replays.UtmCampaign AS utmCampaign,
          session_replays.UtmTerm AS utmTerm,
          session_replays.UtmContent AS utmContent,
          session_replays.Host AS host,
          session_replays.EntryPath AS entryPath,
          session_replays.ExitPath AS exitPath,
          session_replays.Language AS language,
          session_replays.LastActivityAt AS lastActivityAt
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.SessionId = 'sess_0af7651916cd43dd'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
        ORDER BY version DESC
        LIMIT 1
        FORMAT JSON

-- builder:session-replays:sessionReplayChunkIndexQuery:default  [ee1e0400]
SELECT
          session_replay_events.ChunkSeq AS chunkSeq,
          session_replay_events.Timestamp AS timestamp,
          session_replay_events.DurationMs AS durationMs,
          session_replay_events.EventCount AS eventCount,
          session_replay_events.ByteSize AS byteSize,
          session_replay_events.IsCheckpoint AS isCheckpoint
        FROM session_replay_events
        WHERE session_replay_events.OrgId = 'org_sql_catalog'
          AND session_replay_events.SessionId = 'sess_0af7651916cd43dd'
          AND session_replay_events.Timestamp >= '2026-01-01 10:30:00'
          AND session_replay_events.Timestamp <= '2026-01-03 14:15:00'
        ORDER BY chunkSeq ASC
        FORMAT JSON

-- builder:session-replays:sessionReplayEventsQuery:default  [5aed8c5e]
SELECT
          session_replay_events.ChunkSeq AS chunkSeq,
          session_replay_events.Timestamp AS timestamp,
          session_replay_events.DurationMs AS durationMs,
          session_replay_events.EventCount AS eventCount,
          session_replay_events.ByteSize AS byteSize,
          session_replay_events.Events AS events,
          session_replay_events.IsCheckpoint AS isCheckpoint
        FROM session_replay_events
        WHERE session_replay_events.OrgId = 'org_sql_catalog'
          AND session_replay_events.SessionId = 'sess_0af7651916cd43dd'
          AND session_replay_events.Timestamp >= '2026-01-01 10:30:00'
          AND session_replay_events.Timestamp <= '2026-01-03 14:15:00'
        ORDER BY chunkSeq ASC
        FORMAT JSON

-- builder:session-replays:sessionReplayEventsQuery:ranged  [f2cb4b10]
SELECT
          session_replay_events.ChunkSeq AS chunkSeq,
          session_replay_events.Timestamp AS timestamp,
          session_replay_events.DurationMs AS durationMs,
          session_replay_events.EventCount AS eventCount,
          session_replay_events.ByteSize AS byteSize,
          session_replay_events.Events AS events,
          session_replay_events.IsCheckpoint AS isCheckpoint
        FROM session_replay_events
        WHERE session_replay_events.OrgId = 'org_sql_catalog'
          AND session_replay_events.SessionId = 'sess_0af7651916cd43dd'
          AND session_replay_events.Timestamp >= '2026-01-01 10:30:00'
          AND session_replay_events.Timestamp <= '2026-01-03 14:15:00'
          AND session_replay_events.ChunkSeq >= 16
          AND session_replay_events.ChunkSeq <= 31
        ORDER BY chunkSeq ASC
        LIMIT 40
        FORMAT JSON

-- builder:session-replays:sessionReplaysFacetsQuery:default  [529af837]
SELECT
          session_replays.ServiceName AS name,
          uniq(session_replays.SessionId) AS count,
          'service' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.ServiceName != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          session_replays.BrowserName AS name,
          uniq(session_replays.SessionId) AS count,
          'browser' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.BrowserName != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          session_replays.Country AS name,
          uniq(session_replays.SessionId) AS count,
          'country' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.Country != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          session_replays.DeviceType AS name,
          uniq(session_replays.SessionId) AS count,
          'device' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.DeviceType != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          session_replays.GroupName AS name,
          uniq(session_replays.SessionId) AS count,
          'group' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.GroupName != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          product_events.PagePath AS name,
          uniq(product_events.SessionId) AS count,
          'page' AS facetType
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'navigation'
          AND product_events.PagePath != ''
          AND product_events.SessionId IN (SELECT
          session_replays.SessionId AS SessionId
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00')
        GROUP BY name
        ORDER BY count DESC
        LIMIT 200
UNION ALL
SELECT
          arrayJoin(arrayFilter(tag -> tag != '', [t.quality, if(t.signedIn = 1, 'signed_in', ''), if(t.newVisitor = 1, 'new_visitor', '')])) AS name,
          count() AS count,
          'tag' AS facetType
        FROM (SELECT
          session_replays.SessionId AS sessionId,
          multiIf(multiSearchAnyCaseInsensitive(argMax(session_replays.UserAgent, session_replays.Version), ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'PerplexityBot', 'Google-Extended', 'Applebot-Extended', 'meta-externalagent', 'meta-webindexer', 'Bytespider', 'CCBot', 'Amazonbot', 'DuckAssistBot', 'Googlebot', 'GoogleOther', 'AdsBot-Google', 'Google-Read-Aloud', 'bingbot', 'YandexBot', 'Baiduspider', 'DuckDuckBot', 'Applebot', 'Sogou', 'SeznamBot', 'AhrefsSiteAudit', 'AhrefsBot', 'SemrushBot', 'DataForSeoBot', 'DotBot', 'MJ12bot', 'Barkrowler', 'Screaming Frog', 'facebookexternalhit', 'Twitterbot', 'LinkedInBot', 'Slackbot', 'Discordbot', 'TelegramBot', 'Pinterest', 'HubSpot Crawler', 'Stripebot', 'UptimeRobot', 'Pingdom', 'StatusCake', 'Headless', 'bot/', 'bot\x3B', 'bot)', 'crawler', 'spider', '+http']), 'bot', (coalesce(argMax(session_replays.DurationMs, session_replays.Version), dateDiff('millisecond', argMax(session_replays.StartTime, session_replays.Version), coalesce(argMax(session_replays.LastActivityAt, session_replays.Version), argMax(session_replays.StartTime, session_replays.Version)))) < 5000 AND argMax(session_replays.ClickCount, session_replays.Version) = 0), 'bounce', ((argMax(session_replays.PageViews, session_replays.Version) <= 1 AND argMax(session_replays.ClickCount, session_replays.Version) = 0) AND argMax(session_replays.ErrorCount, session_replays.Version) = 0), 'idle', (((argMax(session_replays.PageViews, session_replays.Version) <= 1 AND argMax(session_replays.ClickCount, session_replays.Version) <= 2) AND argMax(session_replays.ErrorCount, session_replays.Version) = 0) AND coalesce(argMax(session_replays.DurationMs, session_replays.Version), dateDiff('millisecond', argMax(session_replays.StartTime, session_replays.Version), coalesce(argMax(session_replays.LastActivityAt, session_replays.Version), argMax(session_replays.StartTime, session_replays.Version)))) < 30000), 'glance', 'engaged') AS quality,
          if(argMax(session_replays.UserId, session_replays.Version) != '', 1, 0) AS signedIn,
          argMax(session_replays.VisitorIsNew, session_replays.Version) AS newVisitor
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
        GROUP BY sessionId) AS t
        GROUP BY name
UNION ALL
SELECT
          toString(toUInt64(round(pow(2, floor(log2(greatest(session_replays.DurationMs, 1000) / 1000) * 2) / 2) * 1000))) AS name,
          uniq(session_replays.SessionId) AS count,
          'durationBucket' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.DurationMs > 0
        GROUP BY name
        LIMIT 40
UNION ALL
SELECT
          'p50' AS name,
          toUInt64(ifNull(ifNotFinite(round(quantile(0.5)(assumeNotNull(session_replays.DurationMs))), 0), 0)) AS count,
          'durationStat' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.DurationMs > 0
UNION ALL
SELECT
          'p95' AS name,
          toUInt64(ifNull(ifNotFinite(round(quantile(0.95)(assumeNotNull(session_replays.DurationMs))), 0), 0)) AS count,
          'durationStat' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.DurationMs > 0
UNION ALL
SELECT
          'total' AS name,
          uniq(session_replays.SessionId) AS count,
          'total' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
UNION ALL
SELECT
          'live' AS name,
          uniqIf(session_replays.SessionId, (session_replays.Status = 'active' AND coalesce(session_replays.LastActivityAt, session_replays.StartTime) >= toDateTime('2026-01-03 14:15:00') - INTERVAL 300 SECOND)) AS count,
          'live' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
UNION ALL
SELECT
          'error' AS name,
          uniq(session_replays.SessionId) AS count,
          'error' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.ErrorCount > 0
FORMAT JSON

-- builder:session-replays:sessionReplaysFacetsQuery:identity-filtered  [33dfe2f9]
SELECT
          session_replays.ServiceName AS name,
          uniq(session_replays.SessionId) AS count,
          'service' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.GroupName = 'Acme Inc'
          AND (session_replays.UserName ILIKE '%ada%' OR session_replays.UserEmail ILIKE '%ada%')
          AND session_replays.ServiceName != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          session_replays.BrowserName AS name,
          uniq(session_replays.SessionId) AS count,
          'browser' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.GroupName = 'Acme Inc'
          AND (session_replays.UserName ILIKE '%ada%' OR session_replays.UserEmail ILIKE '%ada%')
          AND session_replays.BrowserName != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          session_replays.Country AS name,
          uniq(session_replays.SessionId) AS count,
          'country' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.GroupName = 'Acme Inc'
          AND (session_replays.UserName ILIKE '%ada%' OR session_replays.UserEmail ILIKE '%ada%')
          AND session_replays.Country != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          session_replays.DeviceType AS name,
          uniq(session_replays.SessionId) AS count,
          'device' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.GroupName = 'Acme Inc'
          AND (session_replays.UserName ILIKE '%ada%' OR session_replays.UserEmail ILIKE '%ada%')
          AND session_replays.DeviceType != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          session_replays.GroupName AS name,
          uniq(session_replays.SessionId) AS count,
          'group' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND (session_replays.UserName ILIKE '%ada%' OR session_replays.UserEmail ILIKE '%ada%')
          AND session_replays.GroupName != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          product_events.PagePath AS name,
          uniq(product_events.SessionId) AS count,
          'page' AS facetType
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'navigation'
          AND product_events.PagePath != ''
          AND product_events.SessionId IN (SELECT
          session_replays.SessionId AS SessionId
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.GroupName = 'Acme Inc'
          AND (session_replays.UserName ILIKE '%ada%' OR session_replays.UserEmail ILIKE '%ada%'))
        GROUP BY name
        ORDER BY count DESC
        LIMIT 200
UNION ALL
SELECT
          arrayJoin(arrayFilter(tag -> tag != '', [t.quality, if(t.signedIn = 1, 'signed_in', ''), if(t.newVisitor = 1, 'new_visitor', '')])) AS name,
          count() AS count,
          'tag' AS facetType
        FROM (SELECT
          session_replays.SessionId AS sessionId,
          multiIf(multiSearchAnyCaseInsensitive(argMax(session_replays.UserAgent, session_replays.Version), ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'PerplexityBot', 'Google-Extended', 'Applebot-Extended', 'meta-externalagent', 'meta-webindexer', 'Bytespider', 'CCBot', 'Amazonbot', 'DuckAssistBot', 'Googlebot', 'GoogleOther', 'AdsBot-Google', 'Google-Read-Aloud', 'bingbot', 'YandexBot', 'Baiduspider', 'DuckDuckBot', 'Applebot', 'Sogou', 'SeznamBot', 'AhrefsSiteAudit', 'AhrefsBot', 'SemrushBot', 'DataForSeoBot', 'DotBot', 'MJ12bot', 'Barkrowler', 'Screaming Frog', 'facebookexternalhit', 'Twitterbot', 'LinkedInBot', 'Slackbot', 'Discordbot', 'TelegramBot', 'Pinterest', 'HubSpot Crawler', 'Stripebot', 'UptimeRobot', 'Pingdom', 'StatusCake', 'Headless', 'bot/', 'bot\x3B', 'bot)', 'crawler', 'spider', '+http']), 'bot', (coalesce(argMax(session_replays.DurationMs, session_replays.Version), dateDiff('millisecond', argMax(session_replays.StartTime, session_replays.Version), coalesce(argMax(session_replays.LastActivityAt, session_replays.Version), argMax(session_replays.StartTime, session_replays.Version)))) < 5000 AND argMax(session_replays.ClickCount, session_replays.Version) = 0), 'bounce', ((argMax(session_replays.PageViews, session_replays.Version) <= 1 AND argMax(session_replays.ClickCount, session_replays.Version) = 0) AND argMax(session_replays.ErrorCount, session_replays.Version) = 0), 'idle', (((argMax(session_replays.PageViews, session_replays.Version) <= 1 AND argMax(session_replays.ClickCount, session_replays.Version) <= 2) AND argMax(session_replays.ErrorCount, session_replays.Version) = 0) AND coalesce(argMax(session_replays.DurationMs, session_replays.Version), dateDiff('millisecond', argMax(session_replays.StartTime, session_replays.Version), coalesce(argMax(session_replays.LastActivityAt, session_replays.Version), argMax(session_replays.StartTime, session_replays.Version)))) < 30000), 'glance', 'engaged') AS quality,
          if(argMax(session_replays.UserId, session_replays.Version) != '', 1, 0) AS signedIn,
          argMax(session_replays.VisitorIsNew, session_replays.Version) AS newVisitor
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.GroupName = 'Acme Inc'
          AND (session_replays.UserName ILIKE '%ada%' OR session_replays.UserEmail ILIKE '%ada%')
        GROUP BY sessionId) AS t
        GROUP BY name
UNION ALL
SELECT
          toString(toUInt64(round(pow(2, floor(log2(greatest(session_replays.DurationMs, 1000) / 1000) * 2) / 2) * 1000))) AS name,
          uniq(session_replays.SessionId) AS count,
          'durationBucket' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.GroupName = 'Acme Inc'
          AND (session_replays.UserName ILIKE '%ada%' OR session_replays.UserEmail ILIKE '%ada%')
          AND session_replays.DurationMs > 0
        GROUP BY name
        LIMIT 40
UNION ALL
SELECT
          'p50' AS name,
          toUInt64(ifNull(ifNotFinite(round(quantile(0.5)(assumeNotNull(session_replays.DurationMs))), 0), 0)) AS count,
          'durationStat' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.GroupName = 'Acme Inc'
          AND (session_replays.UserName ILIKE '%ada%' OR session_replays.UserEmail ILIKE '%ada%')
          AND session_replays.DurationMs > 0
UNION ALL
SELECT
          'p95' AS name,
          toUInt64(ifNull(ifNotFinite(round(quantile(0.95)(assumeNotNull(session_replays.DurationMs))), 0), 0)) AS count,
          'durationStat' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.GroupName = 'Acme Inc'
          AND (session_replays.UserName ILIKE '%ada%' OR session_replays.UserEmail ILIKE '%ada%')
          AND session_replays.DurationMs > 0
UNION ALL
SELECT
          'total' AS name,
          uniq(session_replays.SessionId) AS count,
          'total' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.GroupName = 'Acme Inc'
          AND (session_replays.UserName ILIKE '%ada%' OR session_replays.UserEmail ILIKE '%ada%')
UNION ALL
SELECT
          'live' AS name,
          uniqIf(session_replays.SessionId, (session_replays.Status = 'active' AND coalesce(session_replays.LastActivityAt, session_replays.StartTime) >= toDateTime('2026-01-03 14:15:00') - INTERVAL 300 SECOND)) AS count,
          'live' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.GroupName = 'Acme Inc'
          AND (session_replays.UserName ILIKE '%ada%' OR session_replays.UserEmail ILIKE '%ada%')
UNION ALL
SELECT
          'error' AS name,
          uniq(session_replays.SessionId) AS count,
          'error' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.GroupName = 'Acme Inc'
          AND (session_replays.UserName ILIKE '%ada%' OR session_replays.UserEmail ILIKE '%ada%')
          AND session_replays.ErrorCount > 0
FORMAT JSON

-- builder:session-replays:sessionReplaysFacetsQuery:page-visited  [29682969]
SELECT
          session_replays.ServiceName AS name,
          uniq(session_replays.SessionId) AS count,
          'service' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS SessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'navigation'
          AND product_events.PagePath = '/pricing')
          AND session_replays.ServiceName != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          session_replays.BrowserName AS name,
          uniq(session_replays.SessionId) AS count,
          'browser' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS SessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'navigation'
          AND product_events.PagePath = '/pricing')
          AND session_replays.BrowserName != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          session_replays.Country AS name,
          uniq(session_replays.SessionId) AS count,
          'country' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS SessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'navigation'
          AND product_events.PagePath = '/pricing')
          AND session_replays.Country != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          session_replays.DeviceType AS name,
          uniq(session_replays.SessionId) AS count,
          'device' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS SessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'navigation'
          AND product_events.PagePath = '/pricing')
          AND session_replays.DeviceType != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          session_replays.GroupName AS name,
          uniq(session_replays.SessionId) AS count,
          'group' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS SessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'navigation'
          AND product_events.PagePath = '/pricing')
          AND session_replays.GroupName != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          product_events.PagePath AS name,
          uniq(product_events.SessionId) AS count,
          'page' AS facetType
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'navigation'
          AND product_events.PagePath != ''
          AND product_events.SessionId IN (SELECT
          session_replays.SessionId AS SessionId
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00')
        GROUP BY name
        ORDER BY count DESC
        LIMIT 200
UNION ALL
SELECT
          arrayJoin(arrayFilter(tag -> tag != '', [t.quality, if(t.signedIn = 1, 'signed_in', ''), if(t.newVisitor = 1, 'new_visitor', '')])) AS name,
          count() AS count,
          'tag' AS facetType
        FROM (SELECT
          session_replays.SessionId AS sessionId,
          multiIf(multiSearchAnyCaseInsensitive(argMax(session_replays.UserAgent, session_replays.Version), ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'PerplexityBot', 'Google-Extended', 'Applebot-Extended', 'meta-externalagent', 'meta-webindexer', 'Bytespider', 'CCBot', 'Amazonbot', 'DuckAssistBot', 'Googlebot', 'GoogleOther', 'AdsBot-Google', 'Google-Read-Aloud', 'bingbot', 'YandexBot', 'Baiduspider', 'DuckDuckBot', 'Applebot', 'Sogou', 'SeznamBot', 'AhrefsSiteAudit', 'AhrefsBot', 'SemrushBot', 'DataForSeoBot', 'DotBot', 'MJ12bot', 'Barkrowler', 'Screaming Frog', 'facebookexternalhit', 'Twitterbot', 'LinkedInBot', 'Slackbot', 'Discordbot', 'TelegramBot', 'Pinterest', 'HubSpot Crawler', 'Stripebot', 'UptimeRobot', 'Pingdom', 'StatusCake', 'Headless', 'bot/', 'bot\x3B', 'bot)', 'crawler', 'spider', '+http']), 'bot', (coalesce(argMax(session_replays.DurationMs, session_replays.Version), dateDiff('millisecond', argMax(session_replays.StartTime, session_replays.Version), coalesce(argMax(session_replays.LastActivityAt, session_replays.Version), argMax(session_replays.StartTime, session_replays.Version)))) < 5000 AND argMax(session_replays.ClickCount, session_replays.Version) = 0), 'bounce', ((argMax(session_replays.PageViews, session_replays.Version) <= 1 AND argMax(session_replays.ClickCount, session_replays.Version) = 0) AND argMax(session_replays.ErrorCount, session_replays.Version) = 0), 'idle', (((argMax(session_replays.PageViews, session_replays.Version) <= 1 AND argMax(session_replays.ClickCount, session_replays.Version) <= 2) AND argMax(session_replays.ErrorCount, session_replays.Version) = 0) AND coalesce(argMax(session_replays.DurationMs, session_replays.Version), dateDiff('millisecond', argMax(session_replays.StartTime, session_replays.Version), coalesce(argMax(session_replays.LastActivityAt, session_replays.Version), argMax(session_replays.StartTime, session_replays.Version)))) < 30000), 'glance', 'engaged') AS quality,
          if(argMax(session_replays.UserId, session_replays.Version) != '', 1, 0) AS signedIn,
          argMax(session_replays.VisitorIsNew, session_replays.Version) AS newVisitor
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS SessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'navigation'
          AND product_events.PagePath = '/pricing')
        GROUP BY sessionId) AS t
        GROUP BY name
UNION ALL
SELECT
          toString(toUInt64(round(pow(2, floor(log2(greatest(session_replays.DurationMs, 1000) / 1000) * 2) / 2) * 1000))) AS name,
          uniq(session_replays.SessionId) AS count,
          'durationBucket' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS SessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'navigation'
          AND product_events.PagePath = '/pricing')
          AND session_replays.DurationMs > 0
        GROUP BY name
        LIMIT 40
UNION ALL
SELECT
          'p50' AS name,
          toUInt64(ifNull(ifNotFinite(round(quantile(0.5)(assumeNotNull(session_replays.DurationMs))), 0), 0)) AS count,
          'durationStat' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS SessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'navigation'
          AND product_events.PagePath = '/pricing')
          AND session_replays.DurationMs > 0
UNION ALL
SELECT
          'p95' AS name,
          toUInt64(ifNull(ifNotFinite(round(quantile(0.95)(assumeNotNull(session_replays.DurationMs))), 0), 0)) AS count,
          'durationStat' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS SessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'navigation'
          AND product_events.PagePath = '/pricing')
          AND session_replays.DurationMs > 0
UNION ALL
SELECT
          'total' AS name,
          uniq(session_replays.SessionId) AS count,
          'total' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS SessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'navigation'
          AND product_events.PagePath = '/pricing')
UNION ALL
SELECT
          'live' AS name,
          uniqIf(session_replays.SessionId, (session_replays.Status = 'active' AND coalesce(session_replays.LastActivityAt, session_replays.StartTime) >= toDateTime('2026-01-03 14:15:00') - INTERVAL 300 SECOND)) AS count,
          'live' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS SessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'navigation'
          AND product_events.PagePath = '/pricing')
UNION ALL
SELECT
          'error' AS name,
          uniq(session_replays.SessionId) AS count,
          'error' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS SessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'navigation'
          AND product_events.PagePath = '/pricing')
          AND session_replays.ErrorCount > 0
FORMAT JSON

-- builder:session-replays:sessionReplaysFacetsQuery:tagged  [31f451a3]
SELECT
          session_replays.ServiceName AS name,
          uniq(session_replays.SessionId) AS count,
          'service' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          t.sessionId AS SessionId
        FROM (SELECT
          session_replays.SessionId AS sessionId,
          multiIf(multiSearchAnyCaseInsensitive(argMax(session_replays.UserAgent, session_replays.Version), ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'PerplexityBot', 'Google-Extended', 'Applebot-Extended', 'meta-externalagent', 'meta-webindexer', 'Bytespider', 'CCBot', 'Amazonbot', 'DuckAssistBot', 'Googlebot', 'GoogleOther', 'AdsBot-Google', 'Google-Read-Aloud', 'bingbot', 'YandexBot', 'Baiduspider', 'DuckDuckBot', 'Applebot', 'Sogou', 'SeznamBot', 'AhrefsSiteAudit', 'AhrefsBot', 'SemrushBot', 'DataForSeoBot', 'DotBot', 'MJ12bot', 'Barkrowler', 'Screaming Frog', 'facebookexternalhit', 'Twitterbot', 'LinkedInBot', 'Slackbot', 'Discordbot', 'TelegramBot', 'Pinterest', 'HubSpot Crawler', 'Stripebot', 'UptimeRobot', 'Pingdom', 'StatusCake', 'Headless', 'bot/', 'bot\x3B', 'bot)', 'crawler', 'spider', '+http']), 'bot', (coalesce(argMax(session_replays.DurationMs, session_replays.Version), dateDiff('millisecond', argMax(session_replays.StartTime, session_replays.Version), coalesce(argMax(session_replays.LastActivityAt, session_replays.Version), argMax(session_replays.StartTime, session_replays.Version)))) < 5000 AND argMax(session_replays.ClickCount, session_replays.Version) = 0), 'bounce', ((argMax(session_replays.PageViews, session_replays.Version) <= 1 AND argMax(session_replays.ClickCount, session_replays.Version) = 0) AND argMax(session_replays.ErrorCount, session_replays.Version) = 0), 'idle', (((argMax(session_replays.PageViews, session_replays.Version) <= 1 AND argMax(session_replays.ClickCount, session_replays.Version) <= 2) AND argMax(session_replays.ErrorCount, session_replays.Version) = 0) AND coalesce(argMax(session_replays.DurationMs, session_replays.Version), dateDiff('millisecond', argMax(session_replays.StartTime, session_replays.Version), coalesce(argMax(session_replays.LastActivityAt, session_replays.Version), argMax(session_replays.StartTime, session_replays.Version)))) < 30000), 'glance', 'engaged') AS quality,
          if(argMax(session_replays.UserId, session_replays.Version) != '', 1, 0) AS signedIn,
          argMax(session_replays.VisitorIsNew, session_replays.Version) AS newVisitor
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
        GROUP BY sessionId) AS t
        WHERE t.quality = 'engaged')
          AND session_replays.ServiceName != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          session_replays.BrowserName AS name,
          uniq(session_replays.SessionId) AS count,
          'browser' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          t.sessionId AS SessionId
        FROM (SELECT
          session_replays.SessionId AS sessionId,
          multiIf(multiSearchAnyCaseInsensitive(argMax(session_replays.UserAgent, session_replays.Version), ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'PerplexityBot', 'Google-Extended', 'Applebot-Extended', 'meta-externalagent', 'meta-webindexer', 'Bytespider', 'CCBot', 'Amazonbot', 'DuckAssistBot', 'Googlebot', 'GoogleOther', 'AdsBot-Google', 'Google-Read-Aloud', 'bingbot', 'YandexBot', 'Baiduspider', 'DuckDuckBot', 'Applebot', 'Sogou', 'SeznamBot', 'AhrefsSiteAudit', 'AhrefsBot', 'SemrushBot', 'DataForSeoBot', 'DotBot', 'MJ12bot', 'Barkrowler', 'Screaming Frog', 'facebookexternalhit', 'Twitterbot', 'LinkedInBot', 'Slackbot', 'Discordbot', 'TelegramBot', 'Pinterest', 'HubSpot Crawler', 'Stripebot', 'UptimeRobot', 'Pingdom', 'StatusCake', 'Headless', 'bot/', 'bot\x3B', 'bot)', 'crawler', 'spider', '+http']), 'bot', (coalesce(argMax(session_replays.DurationMs, session_replays.Version), dateDiff('millisecond', argMax(session_replays.StartTime, session_replays.Version), coalesce(argMax(session_replays.LastActivityAt, session_replays.Version), argMax(session_replays.StartTime, session_replays.Version)))) < 5000 AND argMax(session_replays.ClickCount, session_replays.Version) = 0), 'bounce', ((argMax(session_replays.PageViews, session_replays.Version) <= 1 AND argMax(session_replays.ClickCount, session_replays.Version) = 0) AND argMax(session_replays.ErrorCount, session_replays.Version) = 0), 'idle', (((argMax(session_replays.PageViews, session_replays.Version) <= 1 AND argMax(session_replays.ClickCount, session_replays.Version) <= 2) AND argMax(session_replays.ErrorCount, session_replays.Version) = 0) AND coalesce(argMax(session_replays.DurationMs, session_replays.Version), dateDiff('millisecond', argMax(session_replays.StartTime, session_replays.Version), coalesce(argMax(session_replays.LastActivityAt, session_replays.Version), argMax(session_replays.StartTime, session_replays.Version)))) < 30000), 'glance', 'engaged') AS quality,
          if(argMax(session_replays.UserId, session_replays.Version) != '', 1, 0) AS signedIn,
          argMax(session_replays.VisitorIsNew, session_replays.Version) AS newVisitor
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
        GROUP BY sessionId) AS t
        WHERE t.quality = 'engaged')
          AND session_replays.BrowserName != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          session_replays.Country AS name,
          uniq(session_replays.SessionId) AS count,
          'country' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          t.sessionId AS SessionId
        FROM (SELECT
          session_replays.SessionId AS sessionId,
          multiIf(multiSearchAnyCaseInsensitive(argMax(session_replays.UserAgent, session_replays.Version), ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'PerplexityBot', 'Google-Extended', 'Applebot-Extended', 'meta-externalagent', 'meta-webindexer', 'Bytespider', 'CCBot', 'Amazonbot', 'DuckAssistBot', 'Googlebot', 'GoogleOther', 'AdsBot-Google', 'Google-Read-Aloud', 'bingbot', 'YandexBot', 'Baiduspider', 'DuckDuckBot', 'Applebot', 'Sogou', 'SeznamBot', 'AhrefsSiteAudit', 'AhrefsBot', 'SemrushBot', 'DataForSeoBot', 'DotBot', 'MJ12bot', 'Barkrowler', 'Screaming Frog', 'facebookexternalhit', 'Twitterbot', 'LinkedInBot', 'Slackbot', 'Discordbot', 'TelegramBot', 'Pinterest', 'HubSpot Crawler', 'Stripebot', 'UptimeRobot', 'Pingdom', 'StatusCake', 'Headless', 'bot/', 'bot\x3B', 'bot)', 'crawler', 'spider', '+http']), 'bot', (coalesce(argMax(session_replays.DurationMs, session_replays.Version), dateDiff('millisecond', argMax(session_replays.StartTime, session_replays.Version), coalesce(argMax(session_replays.LastActivityAt, session_replays.Version), argMax(session_replays.StartTime, session_replays.Version)))) < 5000 AND argMax(session_replays.ClickCount, session_replays.Version) = 0), 'bounce', ((argMax(session_replays.PageViews, session_replays.Version) <= 1 AND argMax(session_replays.ClickCount, session_replays.Version) = 0) AND argMax(session_replays.ErrorCount, session_replays.Version) = 0), 'idle', (((argMax(session_replays.PageViews, session_replays.Version) <= 1 AND argMax(session_replays.ClickCount, session_replays.Version) <= 2) AND argMax(session_replays.ErrorCount, session_replays.Version) = 0) AND coalesce(argMax(session_replays.DurationMs, session_replays.Version), dateDiff('millisecond', argMax(session_replays.StartTime, session_replays.Version), coalesce(argMax(session_replays.LastActivityAt, session_replays.Version), argMax(session_replays.StartTime, session_replays.Version)))) < 30000), 'glance', 'engaged') AS quality,
          if(argMax(session_replays.UserId, session_replays.Version) != '', 1, 0) AS signedIn,
          argMax(session_replays.VisitorIsNew, session_replays.Version) AS newVisitor
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
        GROUP BY sessionId) AS t
        WHERE t.quality = 'engaged')
          AND session_replays.Country != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          session_replays.DeviceType AS name,
          uniq(session_replays.SessionId) AS count,
          'device' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          t.sessionId AS SessionId
        FROM (SELECT
          session_replays.SessionId AS sessionId,
          multiIf(multiSearchAnyCaseInsensitive(argMax(session_replays.UserAgent, session_replays.Version), ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'PerplexityBot', 'Google-Extended', 'Applebot-Extended', 'meta-externalagent', 'meta-webindexer', 'Bytespider', 'CCBot', 'Amazonbot', 'DuckAssistBot', 'Googlebot', 'GoogleOther', 'AdsBot-Google', 'Google-Read-Aloud', 'bingbot', 'YandexBot', 'Baiduspider', 'DuckDuckBot', 'Applebot', 'Sogou', 'SeznamBot', 'AhrefsSiteAudit', 'AhrefsBot', 'SemrushBot', 'DataForSeoBot', 'DotBot', 'MJ12bot', 'Barkrowler', 'Screaming Frog', 'facebookexternalhit', 'Twitterbot', 'LinkedInBot', 'Slackbot', 'Discordbot', 'TelegramBot', 'Pinterest', 'HubSpot Crawler', 'Stripebot', 'UptimeRobot', 'Pingdom', 'StatusCake', 'Headless', 'bot/', 'bot\x3B', 'bot)', 'crawler', 'spider', '+http']), 'bot', (coalesce(argMax(session_replays.DurationMs, session_replays.Version), dateDiff('millisecond', argMax(session_replays.StartTime, session_replays.Version), coalesce(argMax(session_replays.LastActivityAt, session_replays.Version), argMax(session_replays.StartTime, session_replays.Version)))) < 5000 AND argMax(session_replays.ClickCount, session_replays.Version) = 0), 'bounce', ((argMax(session_replays.PageViews, session_replays.Version) <= 1 AND argMax(session_replays.ClickCount, session_replays.Version) = 0) AND argMax(session_replays.ErrorCount, session_replays.Version) = 0), 'idle', (((argMax(session_replays.PageViews, session_replays.Version) <= 1 AND argMax(session_replays.ClickCount, session_replays.Version) <= 2) AND argMax(session_replays.ErrorCount, session_replays.Version) = 0) AND coalesce(argMax(session_replays.DurationMs, session_replays.Version), dateDiff('millisecond', argMax(session_replays.StartTime, session_replays.Version), coalesce(argMax(session_replays.LastActivityAt, session_replays.Version), argMax(session_replays.StartTime, session_replays.Version)))) < 30000), 'glance', 'engaged') AS quality,
          if(argMax(session_replays.UserId, session_replays.Version) != '', 1, 0) AS signedIn,
          argMax(session_replays.VisitorIsNew, session_replays.Version) AS newVisitor
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
        GROUP BY sessionId) AS t
        WHERE t.quality = 'engaged')
          AND session_replays.DeviceType != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          session_replays.GroupName AS name,
          uniq(session_replays.SessionId) AS count,
          'group' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          t.sessionId AS SessionId
        FROM (SELECT
          session_replays.SessionId AS sessionId,
          multiIf(multiSearchAnyCaseInsensitive(argMax(session_replays.UserAgent, session_replays.Version), ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'PerplexityBot', 'Google-Extended', 'Applebot-Extended', 'meta-externalagent', 'meta-webindexer', 'Bytespider', 'CCBot', 'Amazonbot', 'DuckAssistBot', 'Googlebot', 'GoogleOther', 'AdsBot-Google', 'Google-Read-Aloud', 'bingbot', 'YandexBot', 'Baiduspider', 'DuckDuckBot', 'Applebot', 'Sogou', 'SeznamBot', 'AhrefsSiteAudit', 'AhrefsBot', 'SemrushBot', 'DataForSeoBot', 'DotBot', 'MJ12bot', 'Barkrowler', 'Screaming Frog', 'facebookexternalhit', 'Twitterbot', 'LinkedInBot', 'Slackbot', 'Discordbot', 'TelegramBot', 'Pinterest', 'HubSpot Crawler', 'Stripebot', 'UptimeRobot', 'Pingdom', 'StatusCake', 'Headless', 'bot/', 'bot\x3B', 'bot)', 'crawler', 'spider', '+http']), 'bot', (coalesce(argMax(session_replays.DurationMs, session_replays.Version), dateDiff('millisecond', argMax(session_replays.StartTime, session_replays.Version), coalesce(argMax(session_replays.LastActivityAt, session_replays.Version), argMax(session_replays.StartTime, session_replays.Version)))) < 5000 AND argMax(session_replays.ClickCount, session_replays.Version) = 0), 'bounce', ((argMax(session_replays.PageViews, session_replays.Version) <= 1 AND argMax(session_replays.ClickCount, session_replays.Version) = 0) AND argMax(session_replays.ErrorCount, session_replays.Version) = 0), 'idle', (((argMax(session_replays.PageViews, session_replays.Version) <= 1 AND argMax(session_replays.ClickCount, session_replays.Version) <= 2) AND argMax(session_replays.ErrorCount, session_replays.Version) = 0) AND coalesce(argMax(session_replays.DurationMs, session_replays.Version), dateDiff('millisecond', argMax(session_replays.StartTime, session_replays.Version), coalesce(argMax(session_replays.LastActivityAt, session_replays.Version), argMax(session_replays.StartTime, session_replays.Version)))) < 30000), 'glance', 'engaged') AS quality,
          if(argMax(session_replays.UserId, session_replays.Version) != '', 1, 0) AS signedIn,
          argMax(session_replays.VisitorIsNew, session_replays.Version) AS newVisitor
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
        GROUP BY sessionId) AS t
        WHERE t.quality = 'engaged')
          AND session_replays.GroupName != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          product_events.PagePath AS name,
          uniq(product_events.SessionId) AS count,
          'page' AS facetType
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'navigation'
          AND product_events.PagePath != ''
          AND product_events.SessionId IN (SELECT
          session_replays.SessionId AS SessionId
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          t.sessionId AS SessionId
        FROM (SELECT
          session_replays.SessionId AS sessionId,
          multiIf(multiSearchAnyCaseInsensitive(argMax(session_replays.UserAgent, session_replays.Version), ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'PerplexityBot', 'Google-Extended', 'Applebot-Extended', 'meta-externalagent', 'meta-webindexer', 'Bytespider', 'CCBot', 'Amazonbot', 'DuckAssistBot', 'Googlebot', 'GoogleOther', 'AdsBot-Google', 'Google-Read-Aloud', 'bingbot', 'YandexBot', 'Baiduspider', 'DuckDuckBot', 'Applebot', 'Sogou', 'SeznamBot', 'AhrefsSiteAudit', 'AhrefsBot', 'SemrushBot', 'DataForSeoBot', 'DotBot', 'MJ12bot', 'Barkrowler', 'Screaming Frog', 'facebookexternalhit', 'Twitterbot', 'LinkedInBot', 'Slackbot', 'Discordbot', 'TelegramBot', 'Pinterest', 'HubSpot Crawler', 'Stripebot', 'UptimeRobot', 'Pingdom', 'StatusCake', 'Headless', 'bot/', 'bot\x3B', 'bot)', 'crawler', 'spider', '+http']), 'bot', (coalesce(argMax(session_replays.DurationMs, session_replays.Version), dateDiff('millisecond', argMax(session_replays.StartTime, session_replays.Version), coalesce(argMax(session_replays.LastActivityAt, session_replays.Version), argMax(session_replays.StartTime, session_replays.Version)))) < 5000 AND argMax(session_replays.ClickCount, session_replays.Version) = 0), 'bounce', ((argMax(session_replays.PageViews, session_replays.Version) <= 1 AND argMax(session_replays.ClickCount, session_replays.Version) = 0) AND argMax(session_replays.ErrorCount, session_replays.Version) = 0), 'idle', (((argMax(session_replays.PageViews, session_replays.Version) <= 1 AND argMax(session_replays.ClickCount, session_replays.Version) <= 2) AND argMax(session_replays.ErrorCount, session_replays.Version) = 0) AND coalesce(argMax(session_replays.DurationMs, session_replays.Version), dateDiff('millisecond', argMax(session_replays.StartTime, session_replays.Version), coalesce(argMax(session_replays.LastActivityAt, session_replays.Version), argMax(session_replays.StartTime, session_replays.Version)))) < 30000), 'glance', 'engaged') AS quality,
          if(argMax(session_replays.UserId, session_replays.Version) != '', 1, 0) AS signedIn,
          argMax(session_replays.VisitorIsNew, session_replays.Version) AS newVisitor
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
        GROUP BY sessionId) AS t
        WHERE t.quality = 'engaged'))
        GROUP BY name
        ORDER BY count DESC
        LIMIT 200
UNION ALL
SELECT
          arrayJoin(arrayFilter(tag -> tag != '', [t.quality, if((t.signedIn = 1 AND t.quality = 'engaged'), 'signed_in', ''), if((t.newVisitor = 1 AND t.quality = 'engaged'), 'new_visitor', '')])) AS name,
          count() AS count,
          'tag' AS facetType
        FROM (SELECT
          session_replays.SessionId AS sessionId,
          multiIf(multiSearchAnyCaseInsensitive(argMax(session_replays.UserAgent, session_replays.Version), ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'PerplexityBot', 'Google-Extended', 'Applebot-Extended', 'meta-externalagent', 'meta-webindexer', 'Bytespider', 'CCBot', 'Amazonbot', 'DuckAssistBot', 'Googlebot', 'GoogleOther', 'AdsBot-Google', 'Google-Read-Aloud', 'bingbot', 'YandexBot', 'Baiduspider', 'DuckDuckBot', 'Applebot', 'Sogou', 'SeznamBot', 'AhrefsSiteAudit', 'AhrefsBot', 'SemrushBot', 'DataForSeoBot', 'DotBot', 'MJ12bot', 'Barkrowler', 'Screaming Frog', 'facebookexternalhit', 'Twitterbot', 'LinkedInBot', 'Slackbot', 'Discordbot', 'TelegramBot', 'Pinterest', 'HubSpot Crawler', 'Stripebot', 'UptimeRobot', 'Pingdom', 'StatusCake', 'Headless', 'bot/', 'bot\x3B', 'bot)', 'crawler', 'spider', '+http']), 'bot', (coalesce(argMax(session_replays.DurationMs, session_replays.Version), dateDiff('millisecond', argMax(session_replays.StartTime, session_replays.Version), coalesce(argMax(session_replays.LastActivityAt, session_replays.Version), argMax(session_replays.StartTime, session_replays.Version)))) < 5000 AND argMax(session_replays.ClickCount, session_replays.Version) = 0), 'bounce', ((argMax(session_replays.PageViews, session_replays.Version) <= 1 AND argMax(session_replays.ClickCount, session_replays.Version) = 0) AND argMax(session_replays.ErrorCount, session_replays.Version) = 0), 'idle', (((argMax(session_replays.PageViews, session_replays.Version) <= 1 AND argMax(session_replays.ClickCount, session_replays.Version) <= 2) AND argMax(session_replays.ErrorCount, session_replays.Version) = 0) AND coalesce(argMax(session_replays.DurationMs, session_replays.Version), dateDiff('millisecond', argMax(session_replays.StartTime, session_replays.Version), coalesce(argMax(session_replays.LastActivityAt, session_replays.Version), argMax(session_replays.StartTime, session_replays.Version)))) < 30000), 'glance', 'engaged') AS quality,
          if(argMax(session_replays.UserId, session_replays.Version) != '', 1, 0) AS signedIn,
          argMax(session_replays.VisitorIsNew, session_replays.Version) AS newVisitor
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
        GROUP BY sessionId) AS t
        GROUP BY name
UNION ALL
SELECT
          toString(toUInt64(round(pow(2, floor(log2(greatest(session_replays.DurationMs, 1000) / 1000) * 2) / 2) * 1000))) AS name,
          uniq(session_replays.SessionId) AS count,
          'durationBucket' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          t.sessionId AS SessionId
        FROM (SELECT
          session_replays.SessionId AS sessionId,
          multiIf(multiSearchAnyCaseInsensitive(argMax(session_replays.UserAgent, session_replays.Version), ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'PerplexityBot', 'Google-Extended', 'Applebot-Extended', 'meta-externalagent', 'meta-webindexer', 'Bytespider', 'CCBot', 'Amazonbot', 'DuckAssistBot', 'Googlebot', 'GoogleOther', 'AdsBot-Google', 'Google-Read-Aloud', 'bingbot', 'YandexBot', 'Baiduspider', 'DuckDuckBot', 'Applebot', 'Sogou', 'SeznamBot', 'AhrefsSiteAudit', 'AhrefsBot', 'SemrushBot', 'DataForSeoBot', 'DotBot', 'MJ12bot', 'Barkrowler', 'Screaming Frog', 'facebookexternalhit', 'Twitterbot', 'LinkedInBot', 'Slackbot', 'Discordbot', 'TelegramBot', 'Pinterest', 'HubSpot Crawler', 'Stripebot', 'UptimeRobot', 'Pingdom', 'StatusCake', 'Headless', 'bot/', 'bot\x3B', 'bot)', 'crawler', 'spider', '+http']), 'bot', (coalesce(argMax(session_replays.DurationMs, session_replays.Version), dateDiff('millisecond', argMax(session_replays.StartTime, session_replays.Version), coalesce(argMax(session_replays.LastActivityAt, session_replays.Version), argMax(session_replays.StartTime, session_replays.Version)))) < 5000 AND argMax(session_replays.ClickCount, session_replays.Version) = 0), 'bounce', ((argMax(session_replays.PageViews, session_replays.Version) <= 1 AND argMax(session_replays.ClickCount, session_replays.Version) = 0) AND argMax(session_replays.ErrorCount, session_replays.Version) = 0), 'idle', (((argMax(session_replays.PageViews, session_replays.Version) <= 1 AND argMax(session_replays.ClickCount, session_replays.Version) <= 2) AND argMax(session_replays.ErrorCount, session_replays.Version) = 0) AND coalesce(argMax(session_replays.DurationMs, session_replays.Version), dateDiff('millisecond', argMax(session_replays.StartTime, session_replays.Version), coalesce(argMax(session_replays.LastActivityAt, session_replays.Version), argMax(session_replays.StartTime, session_replays.Version)))) < 30000), 'glance', 'engaged') AS quality,
          if(argMax(session_replays.UserId, session_replays.Version) != '', 1, 0) AS signedIn,
          argMax(session_replays.VisitorIsNew, session_replays.Version) AS newVisitor
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
        GROUP BY sessionId) AS t
        WHERE t.quality = 'engaged')
          AND session_replays.DurationMs > 0
        GROUP BY name
        LIMIT 40
UNION ALL
SELECT
          'p50' AS name,
          toUInt64(ifNull(ifNotFinite(round(quantile(0.5)(assumeNotNull(session_replays.DurationMs))), 0), 0)) AS count,
          'durationStat' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          t.sessionId AS SessionId
        FROM (SELECT
          session_replays.SessionId AS sessionId,
          multiIf(multiSearchAnyCaseInsensitive(argMax(session_replays.UserAgent, session_replays.Version), ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'PerplexityBot', 'Google-Extended', 'Applebot-Extended', 'meta-externalagent', 'meta-webindexer', 'Bytespider', 'CCBot', 'Amazonbot', 'DuckAssistBot', 'Googlebot', 'GoogleOther', 'AdsBot-Google', 'Google-Read-Aloud', 'bingbot', 'YandexBot', 'Baiduspider', 'DuckDuckBot', 'Applebot', 'Sogou', 'SeznamBot', 'AhrefsSiteAudit', 'AhrefsBot', 'SemrushBot', 'DataForSeoBot', 'DotBot', 'MJ12bot', 'Barkrowler', 'Screaming Frog', 'facebookexternalhit', 'Twitterbot', 'LinkedInBot', 'Slackbot', 'Discordbot', 'TelegramBot', 'Pinterest', 'HubSpot Crawler', 'Stripebot', 'UptimeRobot', 'Pingdom', 'StatusCake', 'Headless', 'bot/', 'bot\x3B', 'bot)', 'crawler', 'spider', '+http']), 'bot', (coalesce(argMax(session_replays.DurationMs, session_replays.Version), dateDiff('millisecond', argMax(session_replays.StartTime, session_replays.Version), coalesce(argMax(session_replays.LastActivityAt, session_replays.Version), argMax(session_replays.StartTime, session_replays.Version)))) < 5000 AND argMax(session_replays.ClickCount, session_replays.Version) = 0), 'bounce', ((argMax(session_replays.PageViews, session_replays.Version) <= 1 AND argMax(session_replays.ClickCount, session_replays.Version) = 0) AND argMax(session_replays.ErrorCount, session_replays.Version) = 0), 'idle', (((argMax(session_replays.PageViews, session_replays.Version) <= 1 AND argMax(session_replays.ClickCount, session_replays.Version) <= 2) AND argMax(session_replays.ErrorCount, session_replays.Version) = 0) AND coalesce(argMax(session_replays.DurationMs, session_replays.Version), dateDiff('millisecond', argMax(session_replays.StartTime, session_replays.Version), coalesce(argMax(session_replays.LastActivityAt, session_replays.Version), argMax(session_replays.StartTime, session_replays.Version)))) < 30000), 'glance', 'engaged') AS quality,
          if(argMax(session_replays.UserId, session_replays.Version) != '', 1, 0) AS signedIn,
          argMax(session_replays.VisitorIsNew, session_replays.Version) AS newVisitor
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
        GROUP BY sessionId) AS t
        WHERE t.quality = 'engaged')
          AND session_replays.DurationMs > 0
UNION ALL
SELECT
          'p95' AS name,
          toUInt64(ifNull(ifNotFinite(round(quantile(0.95)(assumeNotNull(session_replays.DurationMs))), 0), 0)) AS count,
          'durationStat' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          t.sessionId AS SessionId
        FROM (SELECT
          session_replays.SessionId AS sessionId,
          multiIf(multiSearchAnyCaseInsensitive(argMax(session_replays.UserAgent, session_replays.Version), ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'PerplexityBot', 'Google-Extended', 'Applebot-Extended', 'meta-externalagent', 'meta-webindexer', 'Bytespider', 'CCBot', 'Amazonbot', 'DuckAssistBot', 'Googlebot', 'GoogleOther', 'AdsBot-Google', 'Google-Read-Aloud', 'bingbot', 'YandexBot', 'Baiduspider', 'DuckDuckBot', 'Applebot', 'Sogou', 'SeznamBot', 'AhrefsSiteAudit', 'AhrefsBot', 'SemrushBot', 'DataForSeoBot', 'DotBot', 'MJ12bot', 'Barkrowler', 'Screaming Frog', 'facebookexternalhit', 'Twitterbot', 'LinkedInBot', 'Slackbot', 'Discordbot', 'TelegramBot', 'Pinterest', 'HubSpot Crawler', 'Stripebot', 'UptimeRobot', 'Pingdom', 'StatusCake', 'Headless', 'bot/', 'bot\x3B', 'bot)', 'crawler', 'spider', '+http']), 'bot', (coalesce(argMax(session_replays.DurationMs, session_replays.Version), dateDiff('millisecond', argMax(session_replays.StartTime, session_replays.Version), coalesce(argMax(session_replays.LastActivityAt, session_replays.Version), argMax(session_replays.StartTime, session_replays.Version)))) < 5000 AND argMax(session_replays.ClickCount, session_replays.Version) = 0), 'bounce', ((argMax(session_replays.PageViews, session_replays.Version) <= 1 AND argMax(session_replays.ClickCount, session_replays.Version) = 0) AND argMax(session_replays.ErrorCount, session_replays.Version) = 0), 'idle', (((argMax(session_replays.PageViews, session_replays.Version) <= 1 AND argMax(session_replays.ClickCount, session_replays.Version) <= 2) AND argMax(session_replays.ErrorCount, session_replays.Version) = 0) AND coalesce(argMax(session_replays.DurationMs, session_replays.Version), dateDiff('millisecond', argMax(session_replays.StartTime, session_replays.Version), coalesce(argMax(session_replays.LastActivityAt, session_replays.Version), argMax(session_replays.StartTime, session_replays.Version)))) < 30000), 'glance', 'engaged') AS quality,
          if(argMax(session_replays.UserId, session_replays.Version) != '', 1, 0) AS signedIn,
          argMax(session_replays.VisitorIsNew, session_replays.Version) AS newVisitor
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
        GROUP BY sessionId) AS t
        WHERE t.quality = 'engaged')
          AND session_replays.DurationMs > 0
UNION ALL
SELECT
          'total' AS name,
          uniq(session_replays.SessionId) AS count,
          'total' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          t.sessionId AS SessionId
        FROM (SELECT
          session_replays.SessionId AS sessionId,
          multiIf(multiSearchAnyCaseInsensitive(argMax(session_replays.UserAgent, session_replays.Version), ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'PerplexityBot', 'Google-Extended', 'Applebot-Extended', 'meta-externalagent', 'meta-webindexer', 'Bytespider', 'CCBot', 'Amazonbot', 'DuckAssistBot', 'Googlebot', 'GoogleOther', 'AdsBot-Google', 'Google-Read-Aloud', 'bingbot', 'YandexBot', 'Baiduspider', 'DuckDuckBot', 'Applebot', 'Sogou', 'SeznamBot', 'AhrefsSiteAudit', 'AhrefsBot', 'SemrushBot', 'DataForSeoBot', 'DotBot', 'MJ12bot', 'Barkrowler', 'Screaming Frog', 'facebookexternalhit', 'Twitterbot', 'LinkedInBot', 'Slackbot', 'Discordbot', 'TelegramBot', 'Pinterest', 'HubSpot Crawler', 'Stripebot', 'UptimeRobot', 'Pingdom', 'StatusCake', 'Headless', 'bot/', 'bot\x3B', 'bot)', 'crawler', 'spider', '+http']), 'bot', (coalesce(argMax(session_replays.DurationMs, session_replays.Version), dateDiff('millisecond', argMax(session_replays.StartTime, session_replays.Version), coalesce(argMax(session_replays.LastActivityAt, session_replays.Version), argMax(session_replays.StartTime, session_replays.Version)))) < 5000 AND argMax(session_replays.ClickCount, session_replays.Version) = 0), 'bounce', ((argMax(session_replays.PageViews, session_replays.Version) <= 1 AND argMax(session_replays.ClickCount, session_replays.Version) = 0) AND argMax(session_replays.ErrorCount, session_replays.Version) = 0), 'idle', (((argMax(session_replays.PageViews, session_replays.Version) <= 1 AND argMax(session_replays.ClickCount, session_replays.Version) <= 2) AND argMax(session_replays.ErrorCount, session_replays.Version) = 0) AND coalesce(argMax(session_replays.DurationMs, session_replays.Version), dateDiff('millisecond', argMax(session_replays.StartTime, session_replays.Version), coalesce(argMax(session_replays.LastActivityAt, session_replays.Version), argMax(session_replays.StartTime, session_replays.Version)))) < 30000), 'glance', 'engaged') AS quality,
          if(argMax(session_replays.UserId, session_replays.Version) != '', 1, 0) AS signedIn,
          argMax(session_replays.VisitorIsNew, session_replays.Version) AS newVisitor
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
        GROUP BY sessionId) AS t
        WHERE t.quality = 'engaged')
UNION ALL
SELECT
          'live' AS name,
          uniqIf(session_replays.SessionId, (session_replays.Status = 'active' AND coalesce(session_replays.LastActivityAt, session_replays.StartTime) >= toDateTime('2026-01-03 14:15:00') - INTERVAL 300 SECOND)) AS count,
          'live' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          t.sessionId AS SessionId
        FROM (SELECT
          session_replays.SessionId AS sessionId,
          multiIf(multiSearchAnyCaseInsensitive(argMax(session_replays.UserAgent, session_replays.Version), ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'PerplexityBot', 'Google-Extended', 'Applebot-Extended', 'meta-externalagent', 'meta-webindexer', 'Bytespider', 'CCBot', 'Amazonbot', 'DuckAssistBot', 'Googlebot', 'GoogleOther', 'AdsBot-Google', 'Google-Read-Aloud', 'bingbot', 'YandexBot', 'Baiduspider', 'DuckDuckBot', 'Applebot', 'Sogou', 'SeznamBot', 'AhrefsSiteAudit', 'AhrefsBot', 'SemrushBot', 'DataForSeoBot', 'DotBot', 'MJ12bot', 'Barkrowler', 'Screaming Frog', 'facebookexternalhit', 'Twitterbot', 'LinkedInBot', 'Slackbot', 'Discordbot', 'TelegramBot', 'Pinterest', 'HubSpot Crawler', 'Stripebot', 'UptimeRobot', 'Pingdom', 'StatusCake', 'Headless', 'bot/', 'bot\x3B', 'bot)', 'crawler', 'spider', '+http']), 'bot', (coalesce(argMax(session_replays.DurationMs, session_replays.Version), dateDiff('millisecond', argMax(session_replays.StartTime, session_replays.Version), coalesce(argMax(session_replays.LastActivityAt, session_replays.Version), argMax(session_replays.StartTime, session_replays.Version)))) < 5000 AND argMax(session_replays.ClickCount, session_replays.Version) = 0), 'bounce', ((argMax(session_replays.PageViews, session_replays.Version) <= 1 AND argMax(session_replays.ClickCount, session_replays.Version) = 0) AND argMax(session_replays.ErrorCount, session_replays.Version) = 0), 'idle', (((argMax(session_replays.PageViews, session_replays.Version) <= 1 AND argMax(session_replays.ClickCount, session_replays.Version) <= 2) AND argMax(session_replays.ErrorCount, session_replays.Version) = 0) AND coalesce(argMax(session_replays.DurationMs, session_replays.Version), dateDiff('millisecond', argMax(session_replays.StartTime, session_replays.Version), coalesce(argMax(session_replays.LastActivityAt, session_replays.Version), argMax(session_replays.StartTime, session_replays.Version)))) < 30000), 'glance', 'engaged') AS quality,
          if(argMax(session_replays.UserId, session_replays.Version) != '', 1, 0) AS signedIn,
          argMax(session_replays.VisitorIsNew, session_replays.Version) AS newVisitor
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
        GROUP BY sessionId) AS t
        WHERE t.quality = 'engaged')
UNION ALL
SELECT
          'error' AS name,
          uniq(session_replays.SessionId) AS count,
          'error' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          t.sessionId AS SessionId
        FROM (SELECT
          session_replays.SessionId AS sessionId,
          multiIf(multiSearchAnyCaseInsensitive(argMax(session_replays.UserAgent, session_replays.Version), ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'PerplexityBot', 'Google-Extended', 'Applebot-Extended', 'meta-externalagent', 'meta-webindexer', 'Bytespider', 'CCBot', 'Amazonbot', 'DuckAssistBot', 'Googlebot', 'GoogleOther', 'AdsBot-Google', 'Google-Read-Aloud', 'bingbot', 'YandexBot', 'Baiduspider', 'DuckDuckBot', 'Applebot', 'Sogou', 'SeznamBot', 'AhrefsSiteAudit', 'AhrefsBot', 'SemrushBot', 'DataForSeoBot', 'DotBot', 'MJ12bot', 'Barkrowler', 'Screaming Frog', 'facebookexternalhit', 'Twitterbot', 'LinkedInBot', 'Slackbot', 'Discordbot', 'TelegramBot', 'Pinterest', 'HubSpot Crawler', 'Stripebot', 'UptimeRobot', 'Pingdom', 'StatusCake', 'Headless', 'bot/', 'bot\x3B', 'bot)', 'crawler', 'spider', '+http']), 'bot', (coalesce(argMax(session_replays.DurationMs, session_replays.Version), dateDiff('millisecond', argMax(session_replays.StartTime, session_replays.Version), coalesce(argMax(session_replays.LastActivityAt, session_replays.Version), argMax(session_replays.StartTime, session_replays.Version)))) < 5000 AND argMax(session_replays.ClickCount, session_replays.Version) = 0), 'bounce', ((argMax(session_replays.PageViews, session_replays.Version) <= 1 AND argMax(session_replays.ClickCount, session_replays.Version) = 0) AND argMax(session_replays.ErrorCount, session_replays.Version) = 0), 'idle', (((argMax(session_replays.PageViews, session_replays.Version) <= 1 AND argMax(session_replays.ClickCount, session_replays.Version) <= 2) AND argMax(session_replays.ErrorCount, session_replays.Version) = 0) AND coalesce(argMax(session_replays.DurationMs, session_replays.Version), dateDiff('millisecond', argMax(session_replays.StartTime, session_replays.Version), coalesce(argMax(session_replays.LastActivityAt, session_replays.Version), argMax(session_replays.StartTime, session_replays.Version)))) < 30000), 'glance', 'engaged') AS quality,
          if(argMax(session_replays.UserId, session_replays.Version) != '', 1, 0) AS signedIn,
          argMax(session_replays.VisitorIsNew, session_replays.Version) AS newVisitor
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
        GROUP BY sessionId) AS t
        WHERE t.quality = 'engaged')
          AND session_replays.ErrorCount > 0
FORMAT JSON

-- builder:session-replays:sessionReplaysListQuery:default  [86aa9b23]
SELECT
          session_replays.SessionId AS sessionId,
          argMax(session_replays.StartTime, session_replays.Version) AS startTime,
          argMax(session_replays.EndTime, session_replays.Version) AS endTime,
          argMax(session_replays.DurationMs, session_replays.Version) AS durationMs,
          argMax(session_replays.Status, session_replays.Version) AS status,
          argMax(session_replays.LastActivityAt, session_replays.Version) AS lastActivityAt,
          argMax(session_replays.UserId, session_replays.Version) AS userId,
          argMax(session_replays.UserName, session_replays.Version) AS userName,
          argMax(session_replays.UserEmail, session_replays.Version) AS userEmail,
          argMax(session_replays.GroupId, session_replays.Version) AS groupId,
          argMax(session_replays.GroupName, session_replays.Version) AS groupName,
          argMax(session_replays.VisitorId, session_replays.Version) AS visitorId,
          argMax(session_replays.UtmSource, session_replays.Version) AS utmSource,
          argMax(session_replays.EntryPath, session_replays.Version) AS entryPath,
          argMax(session_replays.UrlInitial, session_replays.Version) AS urlInitial,
          argMax(session_replays.BrowserName, session_replays.Version) AS browserName,
          argMax(session_replays.OsName, session_replays.Version) AS osName,
          argMax(session_replays.DeviceType, session_replays.Version) AS deviceType,
          argMax(session_replays.Country, session_replays.Version) AS country,
          argMax(session_replays.ServiceName, session_replays.Version) AS serviceName,
          argMax(session_replays.PageViews, session_replays.Version) AS pageViews,
          argMax(session_replays.ClickCount, session_replays.Version) AS clickCount,
          argMax(session_replays.ErrorCount, session_replays.Version) AS errorCount,
          length(argMax(session_replays.TraceIds, session_replays.Version)) AS traceCount,
          argMax(session_replays.ResourceAttributes['maple.session.recorded'], session_replays.Version) AS recorded,
          multiIf(multiSearchAnyCaseInsensitive(argMax(session_replays.UserAgent, session_replays.Version), ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'PerplexityBot', 'Google-Extended', 'Applebot-Extended', 'meta-externalagent', 'meta-webindexer', 'Bytespider', 'CCBot', 'Amazonbot', 'DuckAssistBot', 'Googlebot', 'GoogleOther', 'AdsBot-Google', 'Google-Read-Aloud', 'bingbot', 'YandexBot', 'Baiduspider', 'DuckDuckBot', 'Applebot', 'Sogou', 'SeznamBot', 'AhrefsSiteAudit', 'AhrefsBot', 'SemrushBot', 'DataForSeoBot', 'DotBot', 'MJ12bot', 'Barkrowler', 'Screaming Frog', 'facebookexternalhit', 'Twitterbot', 'LinkedInBot', 'Slackbot', 'Discordbot', 'TelegramBot', 'Pinterest', 'HubSpot Crawler', 'Stripebot', 'UptimeRobot', 'Pingdom', 'StatusCake', 'Headless', 'bot/', 'bot\x3B', 'bot)', 'crawler', 'spider', '+http']), 'bot', (coalesce(argMax(session_replays.DurationMs, session_replays.Version), dateDiff('millisecond', argMax(session_replays.StartTime, session_replays.Version), coalesce(argMax(session_replays.LastActivityAt, session_replays.Version), argMax(session_replays.StartTime, session_replays.Version)))) < 5000 AND argMax(session_replays.ClickCount, session_replays.Version) = 0), 'bounce', ((argMax(session_replays.PageViews, session_replays.Version) <= 1 AND argMax(session_replays.ClickCount, session_replays.Version) = 0) AND argMax(session_replays.ErrorCount, session_replays.Version) = 0), 'idle', (((argMax(session_replays.PageViews, session_replays.Version) <= 1 AND argMax(session_replays.ClickCount, session_replays.Version) <= 2) AND argMax(session_replays.ErrorCount, session_replays.Version) = 0) AND coalesce(argMax(session_replays.DurationMs, session_replays.Version), dateDiff('millisecond', argMax(session_replays.StartTime, session_replays.Version), coalesce(argMax(session_replays.LastActivityAt, session_replays.Version), argMax(session_replays.StartTime, session_replays.Version)))) < 30000), 'glance', 'engaged') AS quality,
          argMax(session_replays.VisitorIsNew, session_replays.Version) AS visitorIsNew
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
        GROUP BY sessionId
        ORDER BY startTime DESC, sessionId DESC
        LIMIT 50
        OFFSET 0
        FORMAT JSON

-- builder:session-replays:sessionReplaysListQuery:filtered  [5ae12ff4]
SELECT
          s.sessionId AS sessionId,
          s.startTime AS startTime,
          s.endTime AS endTime,
          s.durationMs AS durationMs,
          s.status AS status,
          s.lastActivityAt AS lastActivityAt,
          s.userId AS userId,
          s.userName AS userName,
          s.userEmail AS userEmail,
          s.groupId AS groupId,
          s.groupName AS groupName,
          s.visitorId AS visitorId,
          s.utmSource AS utmSource,
          s.entryPath AS entryPath,
          s.urlInitial AS urlInitial,
          s.browserName AS browserName,
          s.osName AS osName,
          s.deviceType AS deviceType,
          s.country AS country,
          s.serviceName AS serviceName,
          s.pageViews AS pageViews,
          s.clickCount AS clickCount,
          s.errorCount AS errorCount,
          s.traceCount AS traceCount,
          s.recorded AS recorded,
          s.quality AS quality,
          s.visitorIsNew AS visitorIsNew
        FROM (SELECT
          session_replays.SessionId AS sessionId,
          argMax(session_replays.StartTime, session_replays.Version) AS startTime,
          argMax(session_replays.EndTime, session_replays.Version) AS endTime,
          argMax(session_replays.DurationMs, session_replays.Version) AS durationMs,
          argMax(session_replays.Status, session_replays.Version) AS status,
          argMax(session_replays.LastActivityAt, session_replays.Version) AS lastActivityAt,
          argMax(session_replays.UserId, session_replays.Version) AS userId,
          argMax(session_replays.UserName, session_replays.Version) AS userName,
          argMax(session_replays.UserEmail, session_replays.Version) AS userEmail,
          argMax(session_replays.GroupId, session_replays.Version) AS groupId,
          argMax(session_replays.GroupName, session_replays.Version) AS groupName,
          argMax(session_replays.VisitorId, session_replays.Version) AS visitorId,
          argMax(session_replays.UtmSource, session_replays.Version) AS utmSource,
          argMax(session_replays.EntryPath, session_replays.Version) AS entryPath,
          argMax(session_replays.UrlInitial, session_replays.Version) AS urlInitial,
          argMax(session_replays.BrowserName, session_replays.Version) AS browserName,
          argMax(session_replays.OsName, session_replays.Version) AS osName,
          argMax(session_replays.DeviceType, session_replays.Version) AS deviceType,
          argMax(session_replays.Country, session_replays.Version) AS country,
          argMax(session_replays.ServiceName, session_replays.Version) AS serviceName,
          argMax(session_replays.PageViews, session_replays.Version) AS pageViews,
          argMax(session_replays.ClickCount, session_replays.Version) AS clickCount,
          argMax(session_replays.ErrorCount, session_replays.Version) AS errorCount,
          length(argMax(session_replays.TraceIds, session_replays.Version)) AS traceCount,
          argMax(session_replays.ResourceAttributes['maple.session.recorded'], session_replays.Version) AS recorded,
          multiIf(multiSearchAnyCaseInsensitive(argMax(session_replays.UserAgent, session_replays.Version), ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'PerplexityBot', 'Google-Extended', 'Applebot-Extended', 'meta-externalagent', 'meta-webindexer', 'Bytespider', 'CCBot', 'Amazonbot', 'DuckAssistBot', 'Googlebot', 'GoogleOther', 'AdsBot-Google', 'Google-Read-Aloud', 'bingbot', 'YandexBot', 'Baiduspider', 'DuckDuckBot', 'Applebot', 'Sogou', 'SeznamBot', 'AhrefsSiteAudit', 'AhrefsBot', 'SemrushBot', 'DataForSeoBot', 'DotBot', 'MJ12bot', 'Barkrowler', 'Screaming Frog', 'facebookexternalhit', 'Twitterbot', 'LinkedInBot', 'Slackbot', 'Discordbot', 'TelegramBot', 'Pinterest', 'HubSpot Crawler', 'Stripebot', 'UptimeRobot', 'Pingdom', 'StatusCake', 'Headless', 'bot/', 'bot\x3B', 'bot)', 'crawler', 'spider', '+http']), 'bot', (coalesce(argMax(session_replays.DurationMs, session_replays.Version), dateDiff('millisecond', argMax(session_replays.StartTime, session_replays.Version), coalesce(argMax(session_replays.LastActivityAt, session_replays.Version), argMax(session_replays.StartTime, session_replays.Version)))) < 5000 AND argMax(session_replays.ClickCount, session_replays.Version) = 0), 'bounce', ((argMax(session_replays.PageViews, session_replays.Version) <= 1 AND argMax(session_replays.ClickCount, session_replays.Version) = 0) AND argMax(session_replays.ErrorCount, session_replays.Version) = 0), 'idle', (((argMax(session_replays.PageViews, session_replays.Version) <= 1 AND argMax(session_replays.ClickCount, session_replays.Version) <= 2) AND argMax(session_replays.ErrorCount, session_replays.Version) = 0) AND coalesce(argMax(session_replays.DurationMs, session_replays.Version), dateDiff('millisecond', argMax(session_replays.StartTime, session_replays.Version), coalesce(argMax(session_replays.LastActivityAt, session_replays.Version), argMax(session_replays.StartTime, session_replays.Version)))) < 30000), 'glance', 'engaged') AS quality,
          argMax(session_replays.VisitorIsNew, session_replays.Version) AS visitorIsNew
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.ServiceName = 'web'
          AND (session_replays.UserName ILIKE '%ada%' OR session_replays.UserEmail ILIKE '%ada%')
          AND session_replays.GroupName = 'Acme Inc'
          AND session_replays.ErrorCount > 0
          AND session_replays.UrlInitial ILIKE '%checkout%'
        GROUP BY sessionId) AS s
        LEFT JOIN (SELECT
          g.sessionId AS sessionId,
          sumIf(g.gapMs, (g.gapMs > 0 AND g.gapMs <= 15000)) AS activeTimeMs,
          sumIf(g.gapMs, g.gapMs > 15000) AS idleTimeMs,
          count() AS eventCount
        FROM (SELECT
          session_events.SessionId AS sessionId,
          toFloat64(toUnixTimestamp64Nano(session_events.Timestamp) - toUnixTimestamp64Nano(lagInFrame(session_events.Timestamp, 1, session_events.Timestamp) OVER (PARTITION BY session_events.SessionId ORDER BY session_events.Timestamp ASC, session_events.Seq ASC ROWS BETWEEN 1 PRECEDING AND CURRENT ROW))) / 1000000 AS gapMs
        FROM session_events
        WHERE session_events.OrgId = 'org_sql_catalog'
          AND session_events.Timestamp >= '2026-01-01 10:30:00'
          AND session_events.Timestamp <= '2026-01-03 14:15:00') AS g
        GROUP BY sessionId) AS a ON s.sessionId = a.sessionId
        WHERE s.durationMs >= 1000
          AND coalesce(a.activeTimeMs, 0) >= 500
        ORDER BY startTime DESC, sessionId DESC
        LIMIT 50
        OFFSET 0
        FORMAT JSON

-- builder:session-replays:sessionReplaysListQuery:page-visited  [d9dcb119]
SELECT
          session_replays.SessionId AS sessionId,
          argMax(session_replays.StartTime, session_replays.Version) AS startTime,
          argMax(session_replays.EndTime, session_replays.Version) AS endTime,
          argMax(session_replays.DurationMs, session_replays.Version) AS durationMs,
          argMax(session_replays.Status, session_replays.Version) AS status,
          argMax(session_replays.LastActivityAt, session_replays.Version) AS lastActivityAt,
          argMax(session_replays.UserId, session_replays.Version) AS userId,
          argMax(session_replays.UserName, session_replays.Version) AS userName,
          argMax(session_replays.UserEmail, session_replays.Version) AS userEmail,
          argMax(session_replays.GroupId, session_replays.Version) AS groupId,
          argMax(session_replays.GroupName, session_replays.Version) AS groupName,
          argMax(session_replays.VisitorId, session_replays.Version) AS visitorId,
          argMax(session_replays.UtmSource, session_replays.Version) AS utmSource,
          argMax(session_replays.EntryPath, session_replays.Version) AS entryPath,
          argMax(session_replays.UrlInitial, session_replays.Version) AS urlInitial,
          argMax(session_replays.BrowserName, session_replays.Version) AS browserName,
          argMax(session_replays.OsName, session_replays.Version) AS osName,
          argMax(session_replays.DeviceType, session_replays.Version) AS deviceType,
          argMax(session_replays.Country, session_replays.Version) AS country,
          argMax(session_replays.ServiceName, session_replays.Version) AS serviceName,
          argMax(session_replays.PageViews, session_replays.Version) AS pageViews,
          argMax(session_replays.ClickCount, session_replays.Version) AS clickCount,
          argMax(session_replays.ErrorCount, session_replays.Version) AS errorCount,
          length(argMax(session_replays.TraceIds, session_replays.Version)) AS traceCount,
          argMax(session_replays.ResourceAttributes['maple.session.recorded'], session_replays.Version) AS recorded,
          multiIf(multiSearchAnyCaseInsensitive(argMax(session_replays.UserAgent, session_replays.Version), ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'PerplexityBot', 'Google-Extended', 'Applebot-Extended', 'meta-externalagent', 'meta-webindexer', 'Bytespider', 'CCBot', 'Amazonbot', 'DuckAssistBot', 'Googlebot', 'GoogleOther', 'AdsBot-Google', 'Google-Read-Aloud', 'bingbot', 'YandexBot', 'Baiduspider', 'DuckDuckBot', 'Applebot', 'Sogou', 'SeznamBot', 'AhrefsSiteAudit', 'AhrefsBot', 'SemrushBot', 'DataForSeoBot', 'DotBot', 'MJ12bot', 'Barkrowler', 'Screaming Frog', 'facebookexternalhit', 'Twitterbot', 'LinkedInBot', 'Slackbot', 'Discordbot', 'TelegramBot', 'Pinterest', 'HubSpot Crawler', 'Stripebot', 'UptimeRobot', 'Pingdom', 'StatusCake', 'Headless', 'bot/', 'bot\x3B', 'bot)', 'crawler', 'spider', '+http']), 'bot', (coalesce(argMax(session_replays.DurationMs, session_replays.Version), dateDiff('millisecond', argMax(session_replays.StartTime, session_replays.Version), coalesce(argMax(session_replays.LastActivityAt, session_replays.Version), argMax(session_replays.StartTime, session_replays.Version)))) < 5000 AND argMax(session_replays.ClickCount, session_replays.Version) = 0), 'bounce', ((argMax(session_replays.PageViews, session_replays.Version) <= 1 AND argMax(session_replays.ClickCount, session_replays.Version) = 0) AND argMax(session_replays.ErrorCount, session_replays.Version) = 0), 'idle', (((argMax(session_replays.PageViews, session_replays.Version) <= 1 AND argMax(session_replays.ClickCount, session_replays.Version) <= 2) AND argMax(session_replays.ErrorCount, session_replays.Version) = 0) AND coalesce(argMax(session_replays.DurationMs, session_replays.Version), dateDiff('millisecond', argMax(session_replays.StartTime, session_replays.Version), coalesce(argMax(session_replays.LastActivityAt, session_replays.Version), argMax(session_replays.StartTime, session_replays.Version)))) < 30000), 'glance', 'engaged') AS quality,
          argMax(session_replays.VisitorIsNew, session_replays.Version) AS visitorIsNew
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS SessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'navigation'
          AND product_events.PagePath = '/pricing')
        GROUP BY sessionId
        ORDER BY startTime DESC, sessionId DESC
        LIMIT 50
        OFFSET 0
        FORMAT JSON

-- builder:session-replays:sessionReplaysListQuery:tagged  [c8dfa830]
SELECT
          session_replays.SessionId AS sessionId,
          argMax(session_replays.StartTime, session_replays.Version) AS startTime,
          argMax(session_replays.EndTime, session_replays.Version) AS endTime,
          argMax(session_replays.DurationMs, session_replays.Version) AS durationMs,
          argMax(session_replays.Status, session_replays.Version) AS status,
          argMax(session_replays.LastActivityAt, session_replays.Version) AS lastActivityAt,
          argMax(session_replays.UserId, session_replays.Version) AS userId,
          argMax(session_replays.UserName, session_replays.Version) AS userName,
          argMax(session_replays.UserEmail, session_replays.Version) AS userEmail,
          argMax(session_replays.GroupId, session_replays.Version) AS groupId,
          argMax(session_replays.GroupName, session_replays.Version) AS groupName,
          argMax(session_replays.VisitorId, session_replays.Version) AS visitorId,
          argMax(session_replays.UtmSource, session_replays.Version) AS utmSource,
          argMax(session_replays.EntryPath, session_replays.Version) AS entryPath,
          argMax(session_replays.UrlInitial, session_replays.Version) AS urlInitial,
          argMax(session_replays.BrowserName, session_replays.Version) AS browserName,
          argMax(session_replays.OsName, session_replays.Version) AS osName,
          argMax(session_replays.DeviceType, session_replays.Version) AS deviceType,
          argMax(session_replays.Country, session_replays.Version) AS country,
          argMax(session_replays.ServiceName, session_replays.Version) AS serviceName,
          argMax(session_replays.PageViews, session_replays.Version) AS pageViews,
          argMax(session_replays.ClickCount, session_replays.Version) AS clickCount,
          argMax(session_replays.ErrorCount, session_replays.Version) AS errorCount,
          length(argMax(session_replays.TraceIds, session_replays.Version)) AS traceCount,
          argMax(session_replays.ResourceAttributes['maple.session.recorded'], session_replays.Version) AS recorded,
          multiIf(multiSearchAnyCaseInsensitive(argMax(session_replays.UserAgent, session_replays.Version), ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'PerplexityBot', 'Google-Extended', 'Applebot-Extended', 'meta-externalagent', 'meta-webindexer', 'Bytespider', 'CCBot', 'Amazonbot', 'DuckAssistBot', 'Googlebot', 'GoogleOther', 'AdsBot-Google', 'Google-Read-Aloud', 'bingbot', 'YandexBot', 'Baiduspider', 'DuckDuckBot', 'Applebot', 'Sogou', 'SeznamBot', 'AhrefsSiteAudit', 'AhrefsBot', 'SemrushBot', 'DataForSeoBot', 'DotBot', 'MJ12bot', 'Barkrowler', 'Screaming Frog', 'facebookexternalhit', 'Twitterbot', 'LinkedInBot', 'Slackbot', 'Discordbot', 'TelegramBot', 'Pinterest', 'HubSpot Crawler', 'Stripebot', 'UptimeRobot', 'Pingdom', 'StatusCake', 'Headless', 'bot/', 'bot\x3B', 'bot)', 'crawler', 'spider', '+http']), 'bot', (coalesce(argMax(session_replays.DurationMs, session_replays.Version), dateDiff('millisecond', argMax(session_replays.StartTime, session_replays.Version), coalesce(argMax(session_replays.LastActivityAt, session_replays.Version), argMax(session_replays.StartTime, session_replays.Version)))) < 5000 AND argMax(session_replays.ClickCount, session_replays.Version) = 0), 'bounce', ((argMax(session_replays.PageViews, session_replays.Version) <= 1 AND argMax(session_replays.ClickCount, session_replays.Version) = 0) AND argMax(session_replays.ErrorCount, session_replays.Version) = 0), 'idle', (((argMax(session_replays.PageViews, session_replays.Version) <= 1 AND argMax(session_replays.ClickCount, session_replays.Version) <= 2) AND argMax(session_replays.ErrorCount, session_replays.Version) = 0) AND coalesce(argMax(session_replays.DurationMs, session_replays.Version), dateDiff('millisecond', argMax(session_replays.StartTime, session_replays.Version), coalesce(argMax(session_replays.LastActivityAt, session_replays.Version), argMax(session_replays.StartTime, session_replays.Version)))) < 30000), 'glance', 'engaged') AS quality,
          argMax(session_replays.VisitorIsNew, session_replays.Version) AS visitorIsNew
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          t.sessionId AS SessionId
        FROM (SELECT
          session_replays.SessionId AS sessionId,
          multiIf(multiSearchAnyCaseInsensitive(argMax(session_replays.UserAgent, session_replays.Version), ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'PerplexityBot', 'Google-Extended', 'Applebot-Extended', 'meta-externalagent', 'meta-webindexer', 'Bytespider', 'CCBot', 'Amazonbot', 'DuckAssistBot', 'Googlebot', 'GoogleOther', 'AdsBot-Google', 'Google-Read-Aloud', 'bingbot', 'YandexBot', 'Baiduspider', 'DuckDuckBot', 'Applebot', 'Sogou', 'SeznamBot', 'AhrefsSiteAudit', 'AhrefsBot', 'SemrushBot', 'DataForSeoBot', 'DotBot', 'MJ12bot', 'Barkrowler', 'Screaming Frog', 'facebookexternalhit', 'Twitterbot', 'LinkedInBot', 'Slackbot', 'Discordbot', 'TelegramBot', 'Pinterest', 'HubSpot Crawler', 'Stripebot', 'UptimeRobot', 'Pingdom', 'StatusCake', 'Headless', 'bot/', 'bot\x3B', 'bot)', 'crawler', 'spider', '+http']), 'bot', (coalesce(argMax(session_replays.DurationMs, session_replays.Version), dateDiff('millisecond', argMax(session_replays.StartTime, session_replays.Version), coalesce(argMax(session_replays.LastActivityAt, session_replays.Version), argMax(session_replays.StartTime, session_replays.Version)))) < 5000 AND argMax(session_replays.ClickCount, session_replays.Version) = 0), 'bounce', ((argMax(session_replays.PageViews, session_replays.Version) <= 1 AND argMax(session_replays.ClickCount, session_replays.Version) = 0) AND argMax(session_replays.ErrorCount, session_replays.Version) = 0), 'idle', (((argMax(session_replays.PageViews, session_replays.Version) <= 1 AND argMax(session_replays.ClickCount, session_replays.Version) <= 2) AND argMax(session_replays.ErrorCount, session_replays.Version) = 0) AND coalesce(argMax(session_replays.DurationMs, session_replays.Version), dateDiff('millisecond', argMax(session_replays.StartTime, session_replays.Version), coalesce(argMax(session_replays.LastActivityAt, session_replays.Version), argMax(session_replays.StartTime, session_replays.Version)))) < 30000), 'glance', 'engaged') AS quality,
          if(argMax(session_replays.UserId, session_replays.Version) != '', 1, 0) AS signedIn,
          argMax(session_replays.VisitorIsNew, session_replays.Version) AS newVisitor
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
        GROUP BY sessionId) AS t
        WHERE t.quality = 'engaged'
          AND t.signedIn = 1)
        GROUP BY sessionId
        ORDER BY startTime DESC, sessionId DESC
        LIMIT 50
        OFFSET 0
        FORMAT JSON

-- builder:session-replays:sessionsForTraceQuery:default  [78898c08]
SELECT
          session_replays.SessionId AS sessionId,
          argMax(session_replays.StartTime, session_replays.Version) AS startTime,
          argMax(session_replays.DurationMs, session_replays.Version) AS durationMs
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND has(session_replays.TraceIds, '0af7651916cd43dd8448eb211c80319c')
        GROUP BY sessionId
        ORDER BY startTime DESC, sessionId DESC
        LIMIT 10
        OFFSET 0
        FORMAT JSON

-- builder:session-replays:sessionTraceSummariesQuery:default  [fbd46ea2]
SELECT
          trace_detail_spans.TraceId AS traceId,
          min(trace_detail_spans.Timestamp) AS startTime,
          if(maxIf(trace_detail_spans.Duration, trace_detail_spans.ParentSpanId = '') / 1000000 > 0, maxIf(trace_detail_spans.Duration, trace_detail_spans.ParentSpanId = '') / 1000000, max(trace_detail_spans.Duration) / 1000000) AS durationMs,
          coalesce(nullIf(anyIf(trace_detail_spans.SpanName, trace_detail_spans.ParentSpanId = ''), ''), any(trace_detail_spans.SpanName)) AS rootSpanName,
          coalesce(nullIf(anyIf(trace_detail_spans.ServiceName, trace_detail_spans.ParentSpanId = ''), ''), any(trace_detail_spans.ServiceName)) AS rootServiceName,
          anyIf(trace_detail_spans.SpanKind, trace_detail_spans.ParentSpanId = '') AS rootSpanKind,
          anyIf(toJSONString(trace_detail_spans.SpanAttributes), trace_detail_spans.ParentSpanId = '') AS rootSpanAttributes,
          count() AS spanCount,
          if(countIf(trace_detail_spans.StatusCode = 'Error') > 0, 1, 0) AS hasError
        FROM trace_detail_spans
        WHERE trace_detail_spans.OrgId = 'org_sql_catalog'
          AND trace_detail_spans.TraceId IN ('0af7651916cd43dd8448eb211c80319c')
          AND trace_detail_spans.Timestamp >= '2026-01-01 10:30:00'
          AND trace_detail_spans.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY traceId
        ORDER BY startTime ASC
        LIMIT 200
        FORMAT JSON

-- builder:signal-presence:signalPresenceQuery:default  [11ed613a]
SELECT
          'traces' AS signal,
          sum(service_usage.TraceCount) AS count,
          toString(min(service_usage.Hour)) AS firstSeen,
          toString(max(service_usage.Hour)) AS lastSeen
        FROM service_usage
        WHERE service_usage.OrgId = 'org_sql_catalog'
          AND service_usage.Hour >= toStartOfHour(toDateTime('2026-01-01 10:30:00'))
          AND service_usage.Hour <= toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND service_usage.TraceCount > 0
UNION ALL
SELECT
          'logs' AS signal,
          sum(service_usage.LogCount) AS count,
          toString(min(service_usage.Hour)) AS firstSeen,
          toString(max(service_usage.Hour)) AS lastSeen
        FROM service_usage
        WHERE service_usage.OrgId = 'org_sql_catalog'
          AND service_usage.Hour >= toStartOfHour(toDateTime('2026-01-01 10:30:00'))
          AND service_usage.Hour <= toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND service_usage.LogCount > 0
UNION ALL
SELECT
          'metrics' AS signal,
          sum(service_usage.SumMetricCount) + sum(service_usage.GaugeMetricCount) + sum(service_usage.HistogramMetricCount) + sum(service_usage.ExpHistogramMetricCount) AS count,
          toString(min(service_usage.Hour)) AS firstSeen,
          toString(max(service_usage.Hour)) AS lastSeen
        FROM service_usage
        WHERE service_usage.OrgId = 'org_sql_catalog'
          AND service_usage.Hour >= toStartOfHour(toDateTime('2026-01-01 10:30:00'))
          AND service_usage.Hour <= toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND service_usage.SumMetricCount + service_usage.GaugeMetricCount + service_usage.HistogramMetricCount + service_usage.ExpHistogramMetricCount > 0
UNION ALL
SELECT
          'sessions' AS signal,
          count() AS count,
          toString(min(session_replays.StartTime)) AS firstSeen,
          toString(max(session_replays.StartTime)) AS lastSeen
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
UNION ALL
SELECT
          'product_events' AS signal,
          count() AS count,
          toString(min(product_events.Timestamp)) AS firstSeen,
          toString(max(product_events.Timestamp)) AS lastSeen
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
FORMAT JSON

-- builder:traces:traceServicesByTraceIdsQuery:page-enrichment  [465d5a7d]
SELECT
          service_map_spans.TraceId AS traceId,
          arrayDistinct(arrayPushFront(arraySort(groupUniqArray(service_map_spans.ServiceName)), argMin(service_map_spans.ServiceName, (if(ParentSpanId = '', 0, 1), Timestamp)))) AS services
        FROM service_map_spans
        WHERE service_map_spans.OrgId = 'org_sql_catalog'
          AND service_map_spans.TraceId IN ('0af7651916cd43dd8448eb211c80319c', '4bf92f3577b34da6a3ce929d0e0e4736')
          AND service_map_spans.Timestamp >= '2026-01-01 10:30:00'
          AND service_map_spans.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY traceId
        LIMIT 2
        FORMAT JSON

-- builder:traces:traceSpanStatsByTraceIdsQuery:page-enrichment  [4ede1db9]
SELECT
          trace_detail_spans.TraceId AS traceId,
          count() AS spanCount,
          arrayDistinct(arrayPushFront(arraySort(groupUniqArray(trace_detail_spans.ServiceName)), argMin(trace_detail_spans.ServiceName, (if(ParentSpanId = '', 0, 1), Timestamp)))) AS services
        FROM trace_detail_spans
        WHERE trace_detail_spans.OrgId = 'org_sql_catalog'
          AND trace_detail_spans.TraceId IN ('0af7651916cd43dd8448eb211c80319c', '4bf92f3577b34da6a3ce929d0e0e4736')
          AND trace_detail_spans.Timestamp >= subtractHours(toDateTime('2026-01-01 10:30:00'), 1)
          AND trace_detail_spans.Timestamp <= addHours(toDateTime('2026-01-03 14:15:00'), 1)
        GROUP BY traceId
        LIMIT 2
        FORMAT JSON

-- builder:web-analytics-ai:webAnalyticsAiCrawledPagesQuery:default  [56486fc0]
SELECT
          ai_crawler_requests.Host AS host,
          ai_crawler_requests.Path AS path,
          uniq(ai_crawler_requests.TraceId) AS requests,
          arraySort(groupUniqArray(ai_crawler_requests.Crawler)) AS crawlers,
          max(ai_crawler_requests.Timestamp) AS lastSeen
        FROM ai_crawler_requests
        WHERE ai_crawler_requests.OrgId = 'org_sql_catalog'
          AND ai_crawler_requests.Timestamp >= '2026-01-01 10:30:00'
          AND ai_crawler_requests.Timestamp <= '2026-01-03 14:15:00'
          AND ai_crawler_requests.HttpStatus < 400
        GROUP BY host, path
        ORDER BY requests DESC
        LIMIT 50
        FORMAT JSON

-- builder:web-analytics-ai:webAnalyticsAiCrawlerFormatsQuery:url-filtered  [7d190956]
SELECT
          multiIf(match(lower(ai_crawler_requests.Path), '\\.(md|mdx|markdown)$'), 'markdown', match(lower(ai_crawler_requests.Path), '(^|/)llms(-full)?\\.txt$'), 'llms', match(lower(ai_crawler_requests.Path), '(/[^/.]*|\\.html?)$'), 'html', 'other') AS format,
          uniq(ai_crawler_requests.TraceId) AS requests,
          uniqIf(ai_crawler_requests.TraceId, NOT (ai_crawler_requests.HttpStatus < 400)) AS failedRequests,
          uniqIf(concat(ai_crawler_requests.Host, ai_crawler_requests.Path), ai_crawler_requests.HttpStatus < 400) AS pages,
          arraySort(groupUniqArray(ai_crawler_requests.Crawler)) AS crawlers
        FROM ai_crawler_requests
        WHERE ai_crawler_requests.OrgId = 'org_sql_catalog'
          AND ai_crawler_requests.Timestamp >= '2026-01-01 10:30:00'
          AND ai_crawler_requests.Timestamp <= '2026-01-03 14:15:00'
          AND ai_crawler_requests.Host = 'maple.dev'
          AND ai_crawler_requests.Path = '/pricing'
        GROUP BY format
        FORMAT JSON

-- builder:web-analytics-ai:webAnalyticsAiCrawlersQuery:default  [a4be7bcd]
SELECT
          ai_crawler_requests.Crawler AS crawler,
          uniq(ai_crawler_requests.TraceId) AS requests,
          uniqIf(ai_crawler_requests.TraceId, NOT (ai_crawler_requests.HttpStatus < 400)) AS failedRequests,
          uniqIf(concat(ai_crawler_requests.Host, ai_crawler_requests.Path), ai_crawler_requests.HttpStatus < 400) AS pages,
          max(ai_crawler_requests.Timestamp) AS lastSeen
        FROM ai_crawler_requests
        WHERE ai_crawler_requests.OrgId = 'org_sql_catalog'
          AND ai_crawler_requests.Timestamp >= '2026-01-01 10:30:00'
          AND ai_crawler_requests.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY crawler
        ORDER BY requests DESC
        FORMAT JSON

-- builder:web-analytics-ai:webAnalyticsAiReferralsQuery:default  [28f91fbb]
SELECT
          toStartOfInterval(session_replays.StartTime, INTERVAL 3600 SECOND) AS bucket,
          if(transform(replaceRegexpOne(lower(session_replays.ReferrerHost), '^www\\.', ''), ['chatgpt.com', 'chat.openai.com', 'com.openai.chatgpt', 'claude.ai', 'com.anthropic.claude', 'gemini.google.com', 'bard.google.com', 'perplexity.ai', 'ai.perplexity.app.android', 'copilot.microsoft.com', 'copilot.cloud.microsoft', 'm365.cloud.microsoft', 'meta.ai', 'doubao.com', 'chat.deepseek.com', 'deepseek.com', 'grok.com', 'chat.mistral.ai', 'kimi.com', 'kimi.moonshot.cn'], ['chatgpt', 'chatgpt', 'chatgpt', 'claude', 'claude', 'gemini', 'gemini', 'perplexity', 'perplexity', 'copilot', 'copilot', 'copilot', 'meta', 'doubao', 'deepseek', 'deepseek', 'grok', 'mistral', 'kimi', 'kimi'], '') != '', transform(replaceRegexpOne(lower(session_replays.ReferrerHost), '^www\\.', ''), ['chatgpt.com', 'chat.openai.com', 'com.openai.chatgpt', 'claude.ai', 'com.anthropic.claude', 'gemini.google.com', 'bard.google.com', 'perplexity.ai', 'ai.perplexity.app.android', 'copilot.microsoft.com', 'copilot.cloud.microsoft', 'm365.cloud.microsoft', 'meta.ai', 'doubao.com', 'chat.deepseek.com', 'deepseek.com', 'grok.com', 'chat.mistral.ai', 'kimi.com', 'kimi.moonshot.cn'], ['chatgpt', 'chatgpt', 'chatgpt', 'claude', 'claude', 'gemini', 'gemini', 'perplexity', 'perplexity', 'copilot', 'copilot', 'copilot', 'meta', 'doubao', 'deepseek', 'deepseek', 'grok', 'mistral', 'kimi', 'kimi'], ''), transform(lower(session_replays.UtmSource), ['chatgpt.com', 'chatgpt', 'chat.openai.com', 'openai', 'claude.ai', 'claude', 'gemini.google.com', 'gemini', 'perplexity.ai', 'perplexity', 'copilot.microsoft.com', 'copilot.com', 'copilot', 'meta.ai', 'doubao.com', 'doubao', 'deepseek.com', 'deepseek', 'grok.com', 'grok', 'chat.mistral.ai', 'mistral', 'kimi.com', 'kimi'], ['chatgpt', 'chatgpt', 'chatgpt', 'chatgpt', 'claude', 'claude', 'gemini', 'gemini', 'perplexity', 'perplexity', 'copilot', 'copilot', 'copilot', 'meta', 'doubao', 'doubao', 'deepseek', 'deepseek', 'grok', 'grok', 'mistral', 'mistral', 'kimi', 'kimi'], '')) AS product,
          uniq(session_replays.SessionId) AS sessions
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND (replaceRegexpOne(lower(session_replays.ReferrerHost), '^www\\.', '') IN ('chatgpt.com', 'chat.openai.com', 'com.openai.chatgpt', 'claude.ai', 'com.anthropic.claude', 'gemini.google.com', 'bard.google.com', 'perplexity.ai', 'ai.perplexity.app.android', 'copilot.microsoft.com', 'copilot.cloud.microsoft', 'm365.cloud.microsoft', 'meta.ai', 'doubao.com', 'chat.deepseek.com', 'deepseek.com', 'grok.com', 'chat.mistral.ai', 'kimi.com', 'kimi.moonshot.cn') OR lower(session_replays.UtmSource) IN ('chatgpt.com', 'chatgpt', 'chat.openai.com', 'openai', 'claude.ai', 'claude', 'gemini.google.com', 'gemini', 'perplexity.ai', 'perplexity', 'copilot.microsoft.com', 'copilot.com', 'copilot', 'meta.ai', 'doubao.com', 'doubao', 'deepseek.com', 'deepseek', 'grok.com', 'grok', 'chat.mistral.ai', 'mistral', 'kimi.com', 'kimi'))
        GROUP BY bucket, product
        ORDER BY bucket ASC
        FORMAT JSON

-- builder:web-analytics-ai:webAnalyticsAiReferralsQuery:default-rollup  [28f91fbb]
SELECT
          toStartOfInterval(session_replays.StartTime, INTERVAL 3600 SECOND) AS bucket,
          if(transform(replaceRegexpOne(lower(session_replays.ReferrerHost), '^www\\.', ''), ['chatgpt.com', 'chat.openai.com', 'com.openai.chatgpt', 'claude.ai', 'com.anthropic.claude', 'gemini.google.com', 'bard.google.com', 'perplexity.ai', 'ai.perplexity.app.android', 'copilot.microsoft.com', 'copilot.cloud.microsoft', 'm365.cloud.microsoft', 'meta.ai', 'doubao.com', 'chat.deepseek.com', 'deepseek.com', 'grok.com', 'chat.mistral.ai', 'kimi.com', 'kimi.moonshot.cn'], ['chatgpt', 'chatgpt', 'chatgpt', 'claude', 'claude', 'gemini', 'gemini', 'perplexity', 'perplexity', 'copilot', 'copilot', 'copilot', 'meta', 'doubao', 'deepseek', 'deepseek', 'grok', 'mistral', 'kimi', 'kimi'], '') != '', transform(replaceRegexpOne(lower(session_replays.ReferrerHost), '^www\\.', ''), ['chatgpt.com', 'chat.openai.com', 'com.openai.chatgpt', 'claude.ai', 'com.anthropic.claude', 'gemini.google.com', 'bard.google.com', 'perplexity.ai', 'ai.perplexity.app.android', 'copilot.microsoft.com', 'copilot.cloud.microsoft', 'm365.cloud.microsoft', 'meta.ai', 'doubao.com', 'chat.deepseek.com', 'deepseek.com', 'grok.com', 'chat.mistral.ai', 'kimi.com', 'kimi.moonshot.cn'], ['chatgpt', 'chatgpt', 'chatgpt', 'claude', 'claude', 'gemini', 'gemini', 'perplexity', 'perplexity', 'copilot', 'copilot', 'copilot', 'meta', 'doubao', 'deepseek', 'deepseek', 'grok', 'mistral', 'kimi', 'kimi'], ''), transform(lower(session_replays.UtmSource), ['chatgpt.com', 'chatgpt', 'chat.openai.com', 'openai', 'claude.ai', 'claude', 'gemini.google.com', 'gemini', 'perplexity.ai', 'perplexity', 'copilot.microsoft.com', 'copilot.com', 'copilot', 'meta.ai', 'doubao.com', 'doubao', 'deepseek.com', 'deepseek', 'grok.com', 'grok', 'chat.mistral.ai', 'mistral', 'kimi.com', 'kimi'], ['chatgpt', 'chatgpt', 'chatgpt', 'chatgpt', 'claude', 'claude', 'gemini', 'gemini', 'perplexity', 'perplexity', 'copilot', 'copilot', 'copilot', 'meta', 'doubao', 'doubao', 'deepseek', 'deepseek', 'grok', 'grok', 'mistral', 'mistral', 'kimi', 'kimi'], '')) AS product,
          uniq(session_replays.SessionId) AS sessions
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND (replaceRegexpOne(lower(session_replays.ReferrerHost), '^www\\.', '') IN ('chatgpt.com', 'chat.openai.com', 'com.openai.chatgpt', 'claude.ai', 'com.anthropic.claude', 'gemini.google.com', 'bard.google.com', 'perplexity.ai', 'ai.perplexity.app.android', 'copilot.microsoft.com', 'copilot.cloud.microsoft', 'm365.cloud.microsoft', 'meta.ai', 'doubao.com', 'chat.deepseek.com', 'deepseek.com', 'grok.com', 'chat.mistral.ai', 'kimi.com', 'kimi.moonshot.cn') OR lower(session_replays.UtmSource) IN ('chatgpt.com', 'chatgpt', 'chat.openai.com', 'openai', 'claude.ai', 'claude', 'gemini.google.com', 'gemini', 'perplexity.ai', 'perplexity', 'copilot.microsoft.com', 'copilot.com', 'copilot', 'meta.ai', 'doubao.com', 'doubao', 'deepseek.com', 'deepseek', 'grok.com', 'grok', 'chat.mistral.ai', 'mistral', 'kimi.com', 'kimi'))
        GROUP BY bucket, product
        ORDER BY bucket ASC
        FORMAT JSON

-- builder:web-analytics-ai:webAnalyticsAiReferralsQuery:filtered  [0aa0a607]
SELECT
          toStartOfInterval(session_replays.StartTime, INTERVAL 3600 SECOND) AS bucket,
          if(transform(replaceRegexpOne(lower(session_replays.ReferrerHost), '^www\\.', ''), ['chatgpt.com', 'chat.openai.com', 'com.openai.chatgpt', 'claude.ai', 'com.anthropic.claude', 'gemini.google.com', 'bard.google.com', 'perplexity.ai', 'ai.perplexity.app.android', 'copilot.microsoft.com', 'copilot.cloud.microsoft', 'm365.cloud.microsoft', 'meta.ai', 'doubao.com', 'chat.deepseek.com', 'deepseek.com', 'grok.com', 'chat.mistral.ai', 'kimi.com', 'kimi.moonshot.cn'], ['chatgpt', 'chatgpt', 'chatgpt', 'claude', 'claude', 'gemini', 'gemini', 'perplexity', 'perplexity', 'copilot', 'copilot', 'copilot', 'meta', 'doubao', 'deepseek', 'deepseek', 'grok', 'mistral', 'kimi', 'kimi'], '') != '', transform(replaceRegexpOne(lower(session_replays.ReferrerHost), '^www\\.', ''), ['chatgpt.com', 'chat.openai.com', 'com.openai.chatgpt', 'claude.ai', 'com.anthropic.claude', 'gemini.google.com', 'bard.google.com', 'perplexity.ai', 'ai.perplexity.app.android', 'copilot.microsoft.com', 'copilot.cloud.microsoft', 'm365.cloud.microsoft', 'meta.ai', 'doubao.com', 'chat.deepseek.com', 'deepseek.com', 'grok.com', 'chat.mistral.ai', 'kimi.com', 'kimi.moonshot.cn'], ['chatgpt', 'chatgpt', 'chatgpt', 'claude', 'claude', 'gemini', 'gemini', 'perplexity', 'perplexity', 'copilot', 'copilot', 'copilot', 'meta', 'doubao', 'deepseek', 'deepseek', 'grok', 'mistral', 'kimi', 'kimi'], ''), transform(lower(session_replays.UtmSource), ['chatgpt.com', 'chatgpt', 'chat.openai.com', 'openai', 'claude.ai', 'claude', 'gemini.google.com', 'gemini', 'perplexity.ai', 'perplexity', 'copilot.microsoft.com', 'copilot.com', 'copilot', 'meta.ai', 'doubao.com', 'doubao', 'deepseek.com', 'deepseek', 'grok.com', 'grok', 'chat.mistral.ai', 'mistral', 'kimi.com', 'kimi'], ['chatgpt', 'chatgpt', 'chatgpt', 'chatgpt', 'claude', 'claude', 'gemini', 'gemini', 'perplexity', 'perplexity', 'copilot', 'copilot', 'copilot', 'meta', 'doubao', 'doubao', 'deepseek', 'deepseek', 'grok', 'grok', 'mistral', 'mistral', 'kimi', 'kimi'], '')) AS product,
          uniq(session_replays.SessionId) AS sessions
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          session_events.SessionId AS sessionId
        FROM session_events
        WHERE session_events.OrgId = 'org_sql_catalog'
          AND session_events.Timestamp >= '2026-01-01 10:30:00'
          AND session_events.Timestamp <= '2026-01-03 14:15:00'
          AND session_events.Type = 'navigation'
          AND domain(session_events.Url) = 'maple.dev'
          AND path(session_events.Url) = '/pricing'
        GROUP BY sessionId)
          AND session_replays.ReferrerHost = 't.co'
          AND session_replays.Country = 'DE'
          AND session_replays.DeviceType = 'desktop'
          AND session_replays.BrowserName = 'Chrome'
          AND session_replays.OsName = 'macOS'
          AND session_replays.Language = 'en-US'
          AND session_replays.UtmSource = 'twitter'
          AND session_replays.UtmMedium = 'social'
          AND session_replays.UtmCampaign = 'launch'
          AND session_replays.VisitorIsNew = 1
          AND session_replays.SessionId IN (SELECT
          session_events.SessionId AS sessionId
        FROM session_events
        WHERE session_events.OrgId = 'org_sql_catalog'
          AND session_events.Timestamp >= '2026-01-01 10:30:00'
          AND session_events.Timestamp <= '2026-01-03 14:15:00'
          AND session_events.Type = 'custom'
          AND session_events.Message = 'signup_started'
        GROUP BY sessionId)
          AND (replaceRegexpOne(lower(session_replays.ReferrerHost), '^www\\.', '') IN ('chatgpt.com', 'chat.openai.com', 'com.openai.chatgpt', 'claude.ai', 'com.anthropic.claude', 'gemini.google.com', 'bard.google.com', 'perplexity.ai', 'ai.perplexity.app.android', 'copilot.microsoft.com', 'copilot.cloud.microsoft', 'm365.cloud.microsoft', 'meta.ai', 'doubao.com', 'chat.deepseek.com', 'deepseek.com', 'grok.com', 'chat.mistral.ai', 'kimi.com', 'kimi.moonshot.cn') OR lower(session_replays.UtmSource) IN ('chatgpt.com', 'chatgpt', 'chat.openai.com', 'openai', 'claude.ai', 'claude', 'gemini.google.com', 'gemini', 'perplexity.ai', 'perplexity', 'copilot.microsoft.com', 'copilot.com', 'copilot', 'meta.ai', 'doubao.com', 'doubao', 'deepseek.com', 'deepseek', 'grok.com', 'grok', 'chat.mistral.ai', 'mistral', 'kimi.com', 'kimi'))
        GROUP BY bucket, product
        ORDER BY bucket ASC
        FORMAT JSON

-- builder:web-analytics-ai:webAnalyticsAiReferralsQuery:filtered-rollup  [192e250d]
SELECT
          toStartOfInterval(session_replays.StartTime, INTERVAL 3600 SECOND) AS bucket,
          if(transform(replaceRegexpOne(lower(session_replays.ReferrerHost), '^www\\.', ''), ['chatgpt.com', 'chat.openai.com', 'com.openai.chatgpt', 'claude.ai', 'com.anthropic.claude', 'gemini.google.com', 'bard.google.com', 'perplexity.ai', 'ai.perplexity.app.android', 'copilot.microsoft.com', 'copilot.cloud.microsoft', 'm365.cloud.microsoft', 'meta.ai', 'doubao.com', 'chat.deepseek.com', 'deepseek.com', 'grok.com', 'chat.mistral.ai', 'kimi.com', 'kimi.moonshot.cn'], ['chatgpt', 'chatgpt', 'chatgpt', 'claude', 'claude', 'gemini', 'gemini', 'perplexity', 'perplexity', 'copilot', 'copilot', 'copilot', 'meta', 'doubao', 'deepseek', 'deepseek', 'grok', 'mistral', 'kimi', 'kimi'], '') != '', transform(replaceRegexpOne(lower(session_replays.ReferrerHost), '^www\\.', ''), ['chatgpt.com', 'chat.openai.com', 'com.openai.chatgpt', 'claude.ai', 'com.anthropic.claude', 'gemini.google.com', 'bard.google.com', 'perplexity.ai', 'ai.perplexity.app.android', 'copilot.microsoft.com', 'copilot.cloud.microsoft', 'm365.cloud.microsoft', 'meta.ai', 'doubao.com', 'chat.deepseek.com', 'deepseek.com', 'grok.com', 'chat.mistral.ai', 'kimi.com', 'kimi.moonshot.cn'], ['chatgpt', 'chatgpt', 'chatgpt', 'claude', 'claude', 'gemini', 'gemini', 'perplexity', 'perplexity', 'copilot', 'copilot', 'copilot', 'meta', 'doubao', 'deepseek', 'deepseek', 'grok', 'mistral', 'kimi', 'kimi'], ''), transform(lower(session_replays.UtmSource), ['chatgpt.com', 'chatgpt', 'chat.openai.com', 'openai', 'claude.ai', 'claude', 'gemini.google.com', 'gemini', 'perplexity.ai', 'perplexity', 'copilot.microsoft.com', 'copilot.com', 'copilot', 'meta.ai', 'doubao.com', 'doubao', 'deepseek.com', 'deepseek', 'grok.com', 'grok', 'chat.mistral.ai', 'mistral', 'kimi.com', 'kimi'], ['chatgpt', 'chatgpt', 'chatgpt', 'chatgpt', 'claude', 'claude', 'gemini', 'gemini', 'perplexity', 'perplexity', 'copilot', 'copilot', 'copilot', 'meta', 'doubao', 'doubao', 'deepseek', 'deepseek', 'grok', 'grok', 'mistral', 'mistral', 'kimi', 'kimi'], '')) AS product,
          uniq(session_replays.SessionId) AS sessions
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS sessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'navigation'
          AND product_events.Host = 'maple.dev'
          AND product_events.PagePath = '/pricing'
        GROUP BY sessionId)
          AND session_replays.ReferrerHost = 't.co'
          AND session_replays.Country = 'DE'
          AND session_replays.DeviceType = 'desktop'
          AND session_replays.BrowserName = 'Chrome'
          AND session_replays.OsName = 'macOS'
          AND session_replays.Language = 'en-US'
          AND session_replays.UtmSource = 'twitter'
          AND session_replays.UtmMedium = 'social'
          AND session_replays.UtmCampaign = 'launch'
          AND session_replays.VisitorIsNew = 1
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS sessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'custom'
          AND product_events.EventName = 'signup_started'
        GROUP BY sessionId)
          AND (replaceRegexpOne(lower(session_replays.ReferrerHost), '^www\\.', '') IN ('chatgpt.com', 'chat.openai.com', 'com.openai.chatgpt', 'claude.ai', 'com.anthropic.claude', 'gemini.google.com', 'bard.google.com', 'perplexity.ai', 'ai.perplexity.app.android', 'copilot.microsoft.com', 'copilot.cloud.microsoft', 'm365.cloud.microsoft', 'meta.ai', 'doubao.com', 'chat.deepseek.com', 'deepseek.com', 'grok.com', 'chat.mistral.ai', 'kimi.com', 'kimi.moonshot.cn') OR lower(session_replays.UtmSource) IN ('chatgpt.com', 'chatgpt', 'chat.openai.com', 'openai', 'claude.ai', 'claude', 'gemini.google.com', 'gemini', 'perplexity.ai', 'perplexity', 'copilot.microsoft.com', 'copilot.com', 'copilot', 'meta.ai', 'doubao.com', 'doubao', 'deepseek.com', 'deepseek', 'grok.com', 'grok', 'chat.mistral.ai', 'mistral', 'kimi.com', 'kimi'))
        GROUP BY bucket, product
        ORDER BY bucket ASC
        FORMAT JSON

-- builder:web-analytics:webAnalyticsBreakdownsQuery:all-dimensions-filtered  [62be5a08]
SELECT
          if(session_replays.ReferrerHost = '', '(none)', session_replays.ReferrerHost) AS name,
          uniq(session_replays.SessionId) AS count,
          'referrerHost' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          session_events.SessionId AS sessionId
        FROM session_events
        WHERE session_events.OrgId = 'org_sql_catalog'
          AND session_events.Timestamp >= '2026-01-01 10:30:00'
          AND session_events.Timestamp <= '2026-01-03 14:15:00'
          AND session_events.Type = 'navigation'
          AND domain(session_events.Url) = 'maple.dev'
          AND path(session_events.Url) = '/pricing'
        GROUP BY sessionId)
          AND session_replays.Country = 'DE'
          AND session_replays.DeviceType = 'desktop'
          AND session_replays.BrowserName = 'Chrome'
          AND session_replays.OsName = 'macOS'
          AND session_replays.Language = 'en-US'
          AND session_replays.UtmSource = 'twitter'
          AND session_replays.UtmMedium = 'social'
          AND session_replays.UtmCampaign = 'launch'
          AND session_replays.VisitorIsNew = 1
          AND session_replays.SessionId IN (SELECT
          session_events.SessionId AS sessionId
        FROM session_events
        WHERE session_events.OrgId = 'org_sql_catalog'
          AND session_events.Timestamp >= '2026-01-01 10:30:00'
          AND session_events.Timestamp <= '2026-01-03 14:15:00'
          AND session_events.Type = 'custom'
          AND session_events.Message = 'signup_started'
        GROUP BY sessionId)
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          session_replays.Country AS name,
          uniq(session_replays.SessionId) AS count,
          'country' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          session_events.SessionId AS sessionId
        FROM session_events
        WHERE session_events.OrgId = 'org_sql_catalog'
          AND session_events.Timestamp >= '2026-01-01 10:30:00'
          AND session_events.Timestamp <= '2026-01-03 14:15:00'
          AND session_events.Type = 'navigation'
          AND domain(session_events.Url) = 'maple.dev'
          AND path(session_events.Url) = '/pricing'
        GROUP BY sessionId)
          AND session_replays.ReferrerHost = 't.co'
          AND session_replays.DeviceType = 'desktop'
          AND session_replays.BrowserName = 'Chrome'
          AND session_replays.OsName = 'macOS'
          AND session_replays.Language = 'en-US'
          AND session_replays.UtmSource = 'twitter'
          AND session_replays.UtmMedium = 'social'
          AND session_replays.UtmCampaign = 'launch'
          AND session_replays.VisitorIsNew = 1
          AND session_replays.SessionId IN (SELECT
          session_events.SessionId AS sessionId
        FROM session_events
        WHERE session_events.OrgId = 'org_sql_catalog'
          AND session_events.Timestamp >= '2026-01-01 10:30:00'
          AND session_events.Timestamp <= '2026-01-03 14:15:00'
          AND session_events.Type = 'custom'
          AND session_events.Message = 'signup_started'
        GROUP BY sessionId)
          AND session_replays.Country != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          session_replays.DeviceType AS name,
          uniq(session_replays.SessionId) AS count,
          'deviceType' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          session_events.SessionId AS sessionId
        FROM session_events
        WHERE session_events.OrgId = 'org_sql_catalog'
          AND session_events.Timestamp >= '2026-01-01 10:30:00'
          AND session_events.Timestamp <= '2026-01-03 14:15:00'
          AND session_events.Type = 'navigation'
          AND domain(session_events.Url) = 'maple.dev'
          AND path(session_events.Url) = '/pricing'
        GROUP BY sessionId)
          AND session_replays.ReferrerHost = 't.co'
          AND session_replays.Country = 'DE'
          AND session_replays.BrowserName = 'Chrome'
          AND session_replays.OsName = 'macOS'
          AND session_replays.Language = 'en-US'
          AND session_replays.UtmSource = 'twitter'
          AND session_replays.UtmMedium = 'social'
          AND session_replays.UtmCampaign = 'launch'
          AND session_replays.VisitorIsNew = 1
          AND session_replays.SessionId IN (SELECT
          session_events.SessionId AS sessionId
        FROM session_events
        WHERE session_events.OrgId = 'org_sql_catalog'
          AND session_events.Timestamp >= '2026-01-01 10:30:00'
          AND session_events.Timestamp <= '2026-01-03 14:15:00'
          AND session_events.Type = 'custom'
          AND session_events.Message = 'signup_started'
        GROUP BY sessionId)
          AND session_replays.DeviceType != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          session_replays.BrowserName AS name,
          uniq(session_replays.SessionId) AS count,
          'browserName' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          session_events.SessionId AS sessionId
        FROM session_events
        WHERE session_events.OrgId = 'org_sql_catalog'
          AND session_events.Timestamp >= '2026-01-01 10:30:00'
          AND session_events.Timestamp <= '2026-01-03 14:15:00'
          AND session_events.Type = 'navigation'
          AND domain(session_events.Url) = 'maple.dev'
          AND path(session_events.Url) = '/pricing'
        GROUP BY sessionId)
          AND session_replays.ReferrerHost = 't.co'
          AND session_replays.Country = 'DE'
          AND session_replays.DeviceType = 'desktop'
          AND session_replays.OsName = 'macOS'
          AND session_replays.Language = 'en-US'
          AND session_replays.UtmSource = 'twitter'
          AND session_replays.UtmMedium = 'social'
          AND session_replays.UtmCampaign = 'launch'
          AND session_replays.VisitorIsNew = 1
          AND session_replays.SessionId IN (SELECT
          session_events.SessionId AS sessionId
        FROM session_events
        WHERE session_events.OrgId = 'org_sql_catalog'
          AND session_events.Timestamp >= '2026-01-01 10:30:00'
          AND session_events.Timestamp <= '2026-01-03 14:15:00'
          AND session_events.Type = 'custom'
          AND session_events.Message = 'signup_started'
        GROUP BY sessionId)
          AND session_replays.BrowserName != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          session_replays.OsName AS name,
          uniq(session_replays.SessionId) AS count,
          'osName' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          session_events.SessionId AS sessionId
        FROM session_events
        WHERE session_events.OrgId = 'org_sql_catalog'
          AND session_events.Timestamp >= '2026-01-01 10:30:00'
          AND session_events.Timestamp <= '2026-01-03 14:15:00'
          AND session_events.Type = 'navigation'
          AND domain(session_events.Url) = 'maple.dev'
          AND path(session_events.Url) = '/pricing'
        GROUP BY sessionId)
          AND session_replays.ReferrerHost = 't.co'
          AND session_replays.Country = 'DE'
          AND session_replays.DeviceType = 'desktop'
          AND session_replays.BrowserName = 'Chrome'
          AND session_replays.Language = 'en-US'
          AND session_replays.UtmSource = 'twitter'
          AND session_replays.UtmMedium = 'social'
          AND session_replays.UtmCampaign = 'launch'
          AND session_replays.VisitorIsNew = 1
          AND session_replays.SessionId IN (SELECT
          session_events.SessionId AS sessionId
        FROM session_events
        WHERE session_events.OrgId = 'org_sql_catalog'
          AND session_events.Timestamp >= '2026-01-01 10:30:00'
          AND session_events.Timestamp <= '2026-01-03 14:15:00'
          AND session_events.Type = 'custom'
          AND session_events.Message = 'signup_started'
        GROUP BY sessionId)
          AND session_replays.OsName != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          session_replays.Language AS name,
          uniq(session_replays.SessionId) AS count,
          'language' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          session_events.SessionId AS sessionId
        FROM session_events
        WHERE session_events.OrgId = 'org_sql_catalog'
          AND session_events.Timestamp >= '2026-01-01 10:30:00'
          AND session_events.Timestamp <= '2026-01-03 14:15:00'
          AND session_events.Type = 'navigation'
          AND domain(session_events.Url) = 'maple.dev'
          AND path(session_events.Url) = '/pricing'
        GROUP BY sessionId)
          AND session_replays.ReferrerHost = 't.co'
          AND session_replays.Country = 'DE'
          AND session_replays.DeviceType = 'desktop'
          AND session_replays.BrowserName = 'Chrome'
          AND session_replays.OsName = 'macOS'
          AND session_replays.UtmSource = 'twitter'
          AND session_replays.UtmMedium = 'social'
          AND session_replays.UtmCampaign = 'launch'
          AND session_replays.VisitorIsNew = 1
          AND session_replays.SessionId IN (SELECT
          session_events.SessionId AS sessionId
        FROM session_events
        WHERE session_events.OrgId = 'org_sql_catalog'
          AND session_events.Timestamp >= '2026-01-01 10:30:00'
          AND session_events.Timestamp <= '2026-01-03 14:15:00'
          AND session_events.Type = 'custom'
          AND session_events.Message = 'signup_started'
        GROUP BY sessionId)
          AND session_replays.Language != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          if(session_replays.UtmSource = '', '(none)', session_replays.UtmSource) AS name,
          uniq(session_replays.SessionId) AS count,
          'utmSource' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          session_events.SessionId AS sessionId
        FROM session_events
        WHERE session_events.OrgId = 'org_sql_catalog'
          AND session_events.Timestamp >= '2026-01-01 10:30:00'
          AND session_events.Timestamp <= '2026-01-03 14:15:00'
          AND session_events.Type = 'navigation'
          AND domain(session_events.Url) = 'maple.dev'
          AND path(session_events.Url) = '/pricing'
        GROUP BY sessionId)
          AND session_replays.ReferrerHost = 't.co'
          AND session_replays.Country = 'DE'
          AND session_replays.DeviceType = 'desktop'
          AND session_replays.BrowserName = 'Chrome'
          AND session_replays.OsName = 'macOS'
          AND session_replays.Language = 'en-US'
          AND session_replays.UtmMedium = 'social'
          AND session_replays.UtmCampaign = 'launch'
          AND session_replays.VisitorIsNew = 1
          AND session_replays.SessionId IN (SELECT
          session_events.SessionId AS sessionId
        FROM session_events
        WHERE session_events.OrgId = 'org_sql_catalog'
          AND session_events.Timestamp >= '2026-01-01 10:30:00'
          AND session_events.Timestamp <= '2026-01-03 14:15:00'
          AND session_events.Type = 'custom'
          AND session_events.Message = 'signup_started'
        GROUP BY sessionId)
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          if(session_replays.UtmMedium = '', '(none)', session_replays.UtmMedium) AS name,
          uniq(session_replays.SessionId) AS count,
          'utmMedium' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          session_events.SessionId AS sessionId
        FROM session_events
        WHERE session_events.OrgId = 'org_sql_catalog'
          AND session_events.Timestamp >= '2026-01-01 10:30:00'
          AND session_events.Timestamp <= '2026-01-03 14:15:00'
          AND session_events.Type = 'navigation'
          AND domain(session_events.Url) = 'maple.dev'
          AND path(session_events.Url) = '/pricing'
        GROUP BY sessionId)
          AND session_replays.ReferrerHost = 't.co'
          AND session_replays.Country = 'DE'
          AND session_replays.DeviceType = 'desktop'
          AND session_replays.BrowserName = 'Chrome'
          AND session_replays.OsName = 'macOS'
          AND session_replays.Language = 'en-US'
          AND session_replays.UtmSource = 'twitter'
          AND session_replays.UtmCampaign = 'launch'
          AND session_replays.VisitorIsNew = 1
          AND session_replays.SessionId IN (SELECT
          session_events.SessionId AS sessionId
        FROM session_events
        WHERE session_events.OrgId = 'org_sql_catalog'
          AND session_events.Timestamp >= '2026-01-01 10:30:00'
          AND session_events.Timestamp <= '2026-01-03 14:15:00'
          AND session_events.Type = 'custom'
          AND session_events.Message = 'signup_started'
        GROUP BY sessionId)
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          if(session_replays.UtmCampaign = '', '(none)', session_replays.UtmCampaign) AS name,
          uniq(session_replays.SessionId) AS count,
          'utmCampaign' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          session_events.SessionId AS sessionId
        FROM session_events
        WHERE session_events.OrgId = 'org_sql_catalog'
          AND session_events.Timestamp >= '2026-01-01 10:30:00'
          AND session_events.Timestamp <= '2026-01-03 14:15:00'
          AND session_events.Type = 'navigation'
          AND domain(session_events.Url) = 'maple.dev'
          AND path(session_events.Url) = '/pricing'
        GROUP BY sessionId)
          AND session_replays.ReferrerHost = 't.co'
          AND session_replays.Country = 'DE'
          AND session_replays.DeviceType = 'desktop'
          AND session_replays.BrowserName = 'Chrome'
          AND session_replays.OsName = 'macOS'
          AND session_replays.Language = 'en-US'
          AND session_replays.UtmSource = 'twitter'
          AND session_replays.UtmMedium = 'social'
          AND session_replays.VisitorIsNew = 1
          AND session_replays.SessionId IN (SELECT
          session_events.SessionId AS sessionId
        FROM session_events
        WHERE session_events.OrgId = 'org_sql_catalog'
          AND session_events.Timestamp >= '2026-01-01 10:30:00'
          AND session_events.Timestamp <= '2026-01-03 14:15:00'
          AND session_events.Type = 'custom'
          AND session_events.Message = 'signup_started'
        GROUP BY sessionId)
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          session_replays.EntryPath AS name,
          uniq(session_replays.SessionId) AS count,
          'entryPath' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          session_events.SessionId AS sessionId
        FROM session_events
        WHERE session_events.OrgId = 'org_sql_catalog'
          AND session_events.Timestamp >= '2026-01-01 10:30:00'
          AND session_events.Timestamp <= '2026-01-03 14:15:00'
          AND session_events.Type = 'navigation'
          AND domain(session_events.Url) = 'maple.dev'
        GROUP BY sessionId)
          AND session_replays.ReferrerHost = 't.co'
          AND session_replays.Country = 'DE'
          AND session_replays.DeviceType = 'desktop'
          AND session_replays.BrowserName = 'Chrome'
          AND session_replays.OsName = 'macOS'
          AND session_replays.Language = 'en-US'
          AND session_replays.UtmSource = 'twitter'
          AND session_replays.UtmMedium = 'social'
          AND session_replays.UtmCampaign = 'launch'
          AND session_replays.VisitorIsNew = 1
          AND session_replays.SessionId IN (SELECT
          session_events.SessionId AS sessionId
        FROM session_events
        WHERE session_events.OrgId = 'org_sql_catalog'
          AND session_events.Timestamp >= '2026-01-01 10:30:00'
          AND session_events.Timestamp <= '2026-01-03 14:15:00'
          AND session_events.Type = 'custom'
          AND session_events.Message = 'signup_started'
        GROUP BY sessionId)
          AND session_replays.EntryPath != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          session_replays.ExitPath AS name,
          uniq(session_replays.SessionId) AS count,
          'exitPath' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          session_events.SessionId AS sessionId
        FROM session_events
        WHERE session_events.OrgId = 'org_sql_catalog'
          AND session_events.Timestamp >= '2026-01-01 10:30:00'
          AND session_events.Timestamp <= '2026-01-03 14:15:00'
          AND session_events.Type = 'navigation'
          AND domain(session_events.Url) = 'maple.dev'
        GROUP BY sessionId)
          AND session_replays.ReferrerHost = 't.co'
          AND session_replays.Country = 'DE'
          AND session_replays.DeviceType = 'desktop'
          AND session_replays.BrowserName = 'Chrome'
          AND session_replays.OsName = 'macOS'
          AND session_replays.Language = 'en-US'
          AND session_replays.UtmSource = 'twitter'
          AND session_replays.UtmMedium = 'social'
          AND session_replays.UtmCampaign = 'launch'
          AND session_replays.VisitorIsNew = 1
          AND session_replays.SessionId IN (SELECT
          session_events.SessionId AS sessionId
        FROM session_events
        WHERE session_events.OrgId = 'org_sql_catalog'
          AND session_events.Timestamp >= '2026-01-01 10:30:00'
          AND session_events.Timestamp <= '2026-01-03 14:15:00'
          AND session_events.Type = 'custom'
          AND session_events.Message = 'signup_started'
        GROUP BY sessionId)
          AND session_replays.ExitPath != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          session_replays.Host AS name,
          uniq(session_replays.SessionId) AS count,
          'host' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          session_events.SessionId AS sessionId
        FROM session_events
        WHERE session_events.OrgId = 'org_sql_catalog'
          AND session_events.Timestamp >= '2026-01-01 10:30:00'
          AND session_events.Timestamp <= '2026-01-03 14:15:00'
          AND session_events.Type = 'navigation'
          AND path(session_events.Url) = '/pricing'
        GROUP BY sessionId)
          AND session_replays.ReferrerHost = 't.co'
          AND session_replays.Country = 'DE'
          AND session_replays.DeviceType = 'desktop'
          AND session_replays.BrowserName = 'Chrome'
          AND session_replays.OsName = 'macOS'
          AND session_replays.Language = 'en-US'
          AND session_replays.UtmSource = 'twitter'
          AND session_replays.UtmMedium = 'social'
          AND session_replays.UtmCampaign = 'launch'
          AND session_replays.VisitorIsNew = 1
          AND session_replays.SessionId IN (SELECT
          session_events.SessionId AS sessionId
        FROM session_events
        WHERE session_events.OrgId = 'org_sql_catalog'
          AND session_events.Timestamp >= '2026-01-01 10:30:00'
          AND session_events.Timestamp <= '2026-01-03 14:15:00'
          AND session_events.Type = 'custom'
          AND session_events.Message = 'signup_started'
        GROUP BY sessionId)
          AND session_replays.Host != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
FORMAT JSON

-- builder:web-analytics:webAnalyticsBreakdownsQuery:all-dimensions-filtered-rollup  [b9c534d5]
SELECT
          if(session_replays.ReferrerHost = '', '(none)', session_replays.ReferrerHost) AS name,
          uniq(session_replays.SessionId) AS count,
          'referrerHost' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS sessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'navigation'
          AND product_events.Host = 'maple.dev'
          AND product_events.PagePath = '/pricing'
        GROUP BY sessionId)
          AND session_replays.Country = 'DE'
          AND session_replays.DeviceType = 'desktop'
          AND session_replays.BrowserName = 'Chrome'
          AND session_replays.OsName = 'macOS'
          AND session_replays.Language = 'en-US'
          AND session_replays.UtmSource = 'twitter'
          AND session_replays.UtmMedium = 'social'
          AND session_replays.UtmCampaign = 'launch'
          AND session_replays.VisitorIsNew = 1
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS sessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'custom'
          AND product_events.EventName = 'signup_started'
        GROUP BY sessionId)
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          session_replays.Country AS name,
          uniq(session_replays.SessionId) AS count,
          'country' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS sessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'navigation'
          AND product_events.Host = 'maple.dev'
          AND product_events.PagePath = '/pricing'
        GROUP BY sessionId)
          AND session_replays.ReferrerHost = 't.co'
          AND session_replays.DeviceType = 'desktop'
          AND session_replays.BrowserName = 'Chrome'
          AND session_replays.OsName = 'macOS'
          AND session_replays.Language = 'en-US'
          AND session_replays.UtmSource = 'twitter'
          AND session_replays.UtmMedium = 'social'
          AND session_replays.UtmCampaign = 'launch'
          AND session_replays.VisitorIsNew = 1
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS sessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'custom'
          AND product_events.EventName = 'signup_started'
        GROUP BY sessionId)
          AND session_replays.Country != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          session_replays.DeviceType AS name,
          uniq(session_replays.SessionId) AS count,
          'deviceType' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS sessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'navigation'
          AND product_events.Host = 'maple.dev'
          AND product_events.PagePath = '/pricing'
        GROUP BY sessionId)
          AND session_replays.ReferrerHost = 't.co'
          AND session_replays.Country = 'DE'
          AND session_replays.BrowserName = 'Chrome'
          AND session_replays.OsName = 'macOS'
          AND session_replays.Language = 'en-US'
          AND session_replays.UtmSource = 'twitter'
          AND session_replays.UtmMedium = 'social'
          AND session_replays.UtmCampaign = 'launch'
          AND session_replays.VisitorIsNew = 1
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS sessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'custom'
          AND product_events.EventName = 'signup_started'
        GROUP BY sessionId)
          AND session_replays.DeviceType != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          session_replays.BrowserName AS name,
          uniq(session_replays.SessionId) AS count,
          'browserName' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS sessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'navigation'
          AND product_events.Host = 'maple.dev'
          AND product_events.PagePath = '/pricing'
        GROUP BY sessionId)
          AND session_replays.ReferrerHost = 't.co'
          AND session_replays.Country = 'DE'
          AND session_replays.DeviceType = 'desktop'
          AND session_replays.OsName = 'macOS'
          AND session_replays.Language = 'en-US'
          AND session_replays.UtmSource = 'twitter'
          AND session_replays.UtmMedium = 'social'
          AND session_replays.UtmCampaign = 'launch'
          AND session_replays.VisitorIsNew = 1
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS sessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'custom'
          AND product_events.EventName = 'signup_started'
        GROUP BY sessionId)
          AND session_replays.BrowserName != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          session_replays.OsName AS name,
          uniq(session_replays.SessionId) AS count,
          'osName' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS sessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'navigation'
          AND product_events.Host = 'maple.dev'
          AND product_events.PagePath = '/pricing'
        GROUP BY sessionId)
          AND session_replays.ReferrerHost = 't.co'
          AND session_replays.Country = 'DE'
          AND session_replays.DeviceType = 'desktop'
          AND session_replays.BrowserName = 'Chrome'
          AND session_replays.Language = 'en-US'
          AND session_replays.UtmSource = 'twitter'
          AND session_replays.UtmMedium = 'social'
          AND session_replays.UtmCampaign = 'launch'
          AND session_replays.VisitorIsNew = 1
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS sessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'custom'
          AND product_events.EventName = 'signup_started'
        GROUP BY sessionId)
          AND session_replays.OsName != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          session_replays.Language AS name,
          uniq(session_replays.SessionId) AS count,
          'language' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS sessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'navigation'
          AND product_events.Host = 'maple.dev'
          AND product_events.PagePath = '/pricing'
        GROUP BY sessionId)
          AND session_replays.ReferrerHost = 't.co'
          AND session_replays.Country = 'DE'
          AND session_replays.DeviceType = 'desktop'
          AND session_replays.BrowserName = 'Chrome'
          AND session_replays.OsName = 'macOS'
          AND session_replays.UtmSource = 'twitter'
          AND session_replays.UtmMedium = 'social'
          AND session_replays.UtmCampaign = 'launch'
          AND session_replays.VisitorIsNew = 1
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS sessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'custom'
          AND product_events.EventName = 'signup_started'
        GROUP BY sessionId)
          AND session_replays.Language != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          if(session_replays.UtmSource = '', '(none)', session_replays.UtmSource) AS name,
          uniq(session_replays.SessionId) AS count,
          'utmSource' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS sessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'navigation'
          AND product_events.Host = 'maple.dev'
          AND product_events.PagePath = '/pricing'
        GROUP BY sessionId)
          AND session_replays.ReferrerHost = 't.co'
          AND session_replays.Country = 'DE'
          AND session_replays.DeviceType = 'desktop'
          AND session_replays.BrowserName = 'Chrome'
          AND session_replays.OsName = 'macOS'
          AND session_replays.Language = 'en-US'
          AND session_replays.UtmMedium = 'social'
          AND session_replays.UtmCampaign = 'launch'
          AND session_replays.VisitorIsNew = 1
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS sessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'custom'
          AND product_events.EventName = 'signup_started'
        GROUP BY sessionId)
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          if(session_replays.UtmMedium = '', '(none)', session_replays.UtmMedium) AS name,
          uniq(session_replays.SessionId) AS count,
          'utmMedium' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS sessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'navigation'
          AND product_events.Host = 'maple.dev'
          AND product_events.PagePath = '/pricing'
        GROUP BY sessionId)
          AND session_replays.ReferrerHost = 't.co'
          AND session_replays.Country = 'DE'
          AND session_replays.DeviceType = 'desktop'
          AND session_replays.BrowserName = 'Chrome'
          AND session_replays.OsName = 'macOS'
          AND session_replays.Language = 'en-US'
          AND session_replays.UtmSource = 'twitter'
          AND session_replays.UtmCampaign = 'launch'
          AND session_replays.VisitorIsNew = 1
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS sessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'custom'
          AND product_events.EventName = 'signup_started'
        GROUP BY sessionId)
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          if(session_replays.UtmCampaign = '', '(none)', session_replays.UtmCampaign) AS name,
          uniq(session_replays.SessionId) AS count,
          'utmCampaign' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS sessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'navigation'
          AND product_events.Host = 'maple.dev'
          AND product_events.PagePath = '/pricing'
        GROUP BY sessionId)
          AND session_replays.ReferrerHost = 't.co'
          AND session_replays.Country = 'DE'
          AND session_replays.DeviceType = 'desktop'
          AND session_replays.BrowserName = 'Chrome'
          AND session_replays.OsName = 'macOS'
          AND session_replays.Language = 'en-US'
          AND session_replays.UtmSource = 'twitter'
          AND session_replays.UtmMedium = 'social'
          AND session_replays.VisitorIsNew = 1
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS sessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'custom'
          AND product_events.EventName = 'signup_started'
        GROUP BY sessionId)
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          session_replays.EntryPath AS name,
          uniq(session_replays.SessionId) AS count,
          'entryPath' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS sessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'navigation'
          AND product_events.Host = 'maple.dev'
        GROUP BY sessionId)
          AND session_replays.ReferrerHost = 't.co'
          AND session_replays.Country = 'DE'
          AND session_replays.DeviceType = 'desktop'
          AND session_replays.BrowserName = 'Chrome'
          AND session_replays.OsName = 'macOS'
          AND session_replays.Language = 'en-US'
          AND session_replays.UtmSource = 'twitter'
          AND session_replays.UtmMedium = 'social'
          AND session_replays.UtmCampaign = 'launch'
          AND session_replays.VisitorIsNew = 1
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS sessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'custom'
          AND product_events.EventName = 'signup_started'
        GROUP BY sessionId)
          AND session_replays.EntryPath != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          session_replays.ExitPath AS name,
          uniq(session_replays.SessionId) AS count,
          'exitPath' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS sessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'navigation'
          AND product_events.Host = 'maple.dev'
        GROUP BY sessionId)
          AND session_replays.ReferrerHost = 't.co'
          AND session_replays.Country = 'DE'
          AND session_replays.DeviceType = 'desktop'
          AND session_replays.BrowserName = 'Chrome'
          AND session_replays.OsName = 'macOS'
          AND session_replays.Language = 'en-US'
          AND session_replays.UtmSource = 'twitter'
          AND session_replays.UtmMedium = 'social'
          AND session_replays.UtmCampaign = 'launch'
          AND session_replays.VisitorIsNew = 1
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS sessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'custom'
          AND product_events.EventName = 'signup_started'
        GROUP BY sessionId)
          AND session_replays.ExitPath != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          session_replays.Host AS name,
          uniq(session_replays.SessionId) AS count,
          'host' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS sessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'navigation'
          AND product_events.PagePath = '/pricing'
        GROUP BY sessionId)
          AND session_replays.ReferrerHost = 't.co'
          AND session_replays.Country = 'DE'
          AND session_replays.DeviceType = 'desktop'
          AND session_replays.BrowserName = 'Chrome'
          AND session_replays.OsName = 'macOS'
          AND session_replays.Language = 'en-US'
          AND session_replays.UtmSource = 'twitter'
          AND session_replays.UtmMedium = 'social'
          AND session_replays.UtmCampaign = 'launch'
          AND session_replays.VisitorIsNew = 1
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS sessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'custom'
          AND product_events.EventName = 'signup_started'
        GROUP BY sessionId)
          AND session_replays.Host != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
FORMAT JSON

-- builder:web-analytics:webAnalyticsBreakdownsQuery:default  [ed49640e]
SELECT
          if(session_replays.ReferrerHost = '', '(none)', session_replays.ReferrerHost) AS name,
          uniq(session_replays.SessionId) AS count,
          'referrerHost' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          session_replays.Country AS name,
          uniq(session_replays.SessionId) AS count,
          'country' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.Country != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          session_replays.DeviceType AS name,
          uniq(session_replays.SessionId) AS count,
          'deviceType' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.DeviceType != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          session_replays.BrowserName AS name,
          uniq(session_replays.SessionId) AS count,
          'browserName' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.BrowserName != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          session_replays.OsName AS name,
          uniq(session_replays.SessionId) AS count,
          'osName' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.OsName != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          session_replays.Language AS name,
          uniq(session_replays.SessionId) AS count,
          'language' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.Language != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          if(session_replays.UtmSource = '', '(none)', session_replays.UtmSource) AS name,
          uniq(session_replays.SessionId) AS count,
          'utmSource' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          if(session_replays.UtmMedium = '', '(none)', session_replays.UtmMedium) AS name,
          uniq(session_replays.SessionId) AS count,
          'utmMedium' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          if(session_replays.UtmCampaign = '', '(none)', session_replays.UtmCampaign) AS name,
          uniq(session_replays.SessionId) AS count,
          'utmCampaign' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          session_replays.EntryPath AS name,
          uniq(session_replays.SessionId) AS count,
          'entryPath' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.EntryPath != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          session_replays.ExitPath AS name,
          uniq(session_replays.SessionId) AS count,
          'exitPath' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.ExitPath != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          session_replays.Host AS name,
          uniq(session_replays.SessionId) AS count,
          'host' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.Host != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
FORMAT JSON

-- builder:web-analytics:webAnalyticsBreakdownsQuery:default-rollup  [ed49640e]
SELECT
          if(session_replays.ReferrerHost = '', '(none)', session_replays.ReferrerHost) AS name,
          uniq(session_replays.SessionId) AS count,
          'referrerHost' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          session_replays.Country AS name,
          uniq(session_replays.SessionId) AS count,
          'country' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.Country != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          session_replays.DeviceType AS name,
          uniq(session_replays.SessionId) AS count,
          'deviceType' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.DeviceType != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          session_replays.BrowserName AS name,
          uniq(session_replays.SessionId) AS count,
          'browserName' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.BrowserName != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          session_replays.OsName AS name,
          uniq(session_replays.SessionId) AS count,
          'osName' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.OsName != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          session_replays.Language AS name,
          uniq(session_replays.SessionId) AS count,
          'language' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.Language != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          if(session_replays.UtmSource = '', '(none)', session_replays.UtmSource) AS name,
          uniq(session_replays.SessionId) AS count,
          'utmSource' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          if(session_replays.UtmMedium = '', '(none)', session_replays.UtmMedium) AS name,
          uniq(session_replays.SessionId) AS count,
          'utmMedium' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          if(session_replays.UtmCampaign = '', '(none)', session_replays.UtmCampaign) AS name,
          uniq(session_replays.SessionId) AS count,
          'utmCampaign' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          session_replays.EntryPath AS name,
          uniq(session_replays.SessionId) AS count,
          'entryPath' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.EntryPath != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          session_replays.ExitPath AS name,
          uniq(session_replays.SessionId) AS count,
          'exitPath' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.ExitPath != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          session_replays.Host AS name,
          uniq(session_replays.SessionId) AS count,
          'host' AS facetType
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.Host != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
FORMAT JSON

-- builder:web-analytics:webAnalyticsEventsQuery:default  [8af6a16b]
SELECT
          session_events.Message AS name,
          count() AS events,
          uniq(session_events.SessionId) AS sessions
        FROM session_events
        WHERE session_events.OrgId = 'org_sql_catalog'
          AND session_events.Timestamp >= '2026-01-01 10:30:00'
          AND session_events.Timestamp <= '2026-01-03 14:15:00'
          AND session_events.Type = 'custom'
          AND session_events.Message != ''
        GROUP BY name
        ORDER BY events DESC
        LIMIT 100
        FORMAT JSON

-- builder:web-analytics:webAnalyticsEventsQuery:default-rollup  [2cd8befb]
SELECT
          product_events.EventName AS name,
          count() AS events,
          uniq(product_events.SessionId) AS sessions
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'custom'
          AND product_events.EventName != ''
        GROUP BY name
        ORDER BY events DESC
        LIMIT 100
        FORMAT JSON

-- builder:web-analytics:webAnalyticsEventsQuery:semi-joined  [6d49ff13]
SELECT
          session_events.Message AS name,
          count() AS events,
          uniq(session_events.SessionId) AS sessions
        FROM session_events
        WHERE session_events.OrgId = 'org_sql_catalog'
          AND session_events.Timestamp >= '2026-01-01 10:30:00'
          AND session_events.Timestamp <= '2026-01-03 14:15:00'
          AND session_events.Type = 'custom'
          AND session_events.SessionId IN (SELECT
          session_replays.SessionId AS sessionId
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.Country = 'DE'
        GROUP BY sessionId)
          AND session_events.Message != ''
        GROUP BY name
        ORDER BY events DESC
        LIMIT 100
        FORMAT JSON

-- builder:web-analytics:webAnalyticsEventsQuery:semi-joined-rollup  [5a489a16]
SELECT
          product_events.EventName AS name,
          count() AS events,
          uniq(product_events.SessionId) AS sessions
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'custom'
          AND product_events.SessionId IN (SELECT
          session_replays.SessionId AS sessionId
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.Country = 'DE'
        GROUP BY sessionId)
          AND product_events.EventName != ''
        GROUP BY name
        ORDER BY events DESC
        LIMIT 100
        FORMAT JSON

-- builder:web-analytics:webAnalyticsEventsQuery:url-filtered  [9e623494]
SELECT
          session_events.Message AS name,
          count() AS events,
          uniq(session_events.SessionId) AS sessions
        FROM session_events
        WHERE session_events.OrgId = 'org_sql_catalog'
          AND session_events.Timestamp >= '2026-01-01 10:30:00'
          AND session_events.Timestamp <= '2026-01-03 14:15:00'
          AND session_events.Type = 'custom'
          AND domain(session_events.Url) = 'maple.dev'
          AND session_events.Message != ''
        GROUP BY name
        ORDER BY events DESC
        LIMIT 100
        FORMAT JSON

-- builder:web-analytics:webAnalyticsEventsQuery:url-filtered-rollup  [79547def]
SELECT
          product_events.EventName AS name,
          count() AS events,
          uniq(product_events.SessionId) AS sessions
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'custom'
          AND product_events.Host = 'maple.dev'
          AND product_events.EventName != ''
        GROUP BY name
        ORDER BY events DESC
        LIMIT 100
        FORMAT JSON

-- builder:web-analytics:webAnalyticsLiveQuery:default  [bc4b0d44]
SELECT
          uniqIf(session_replays.VisitorId, session_replays.VisitorId != '') AS visitors,
          uniq(session_replays.SessionId) AS sessions
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND coalesce(session_replays.LastActivityAt, session_replays.StartTime) >= toDateTime('2026-01-03 14:15:00') - INTERVAL 300 SECOND
        FORMAT JSON

-- builder:web-analytics:webAnalyticsLiveQuery:default-rollup  [bc4b0d44]
SELECT
          uniqIf(session_replays.VisitorId, session_replays.VisitorId != '') AS visitors,
          uniq(session_replays.SessionId) AS sessions
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND coalesce(session_replays.LastActivityAt, session_replays.StartTime) >= toDateTime('2026-01-03 14:15:00') - INTERVAL 300 SECOND
        FORMAT JSON

-- builder:web-analytics:webAnalyticsLiveQuery:filtered  [eadd8484]
SELECT
          uniqIf(session_replays.VisitorId, session_replays.VisitorId != '') AS visitors,
          uniq(session_replays.SessionId) AS sessions
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          session_events.SessionId AS sessionId
        FROM session_events
        WHERE session_events.OrgId = 'org_sql_catalog'
          AND session_events.Timestamp >= '2026-01-01 10:30:00'
          AND session_events.Timestamp <= '2026-01-03 14:15:00'
          AND session_events.Type = 'navigation'
          AND domain(session_events.Url) = 'maple.dev'
          AND path(session_events.Url) = '/pricing'
        GROUP BY sessionId)
          AND session_replays.ReferrerHost = 't.co'
          AND session_replays.Country = 'DE'
          AND session_replays.DeviceType = 'desktop'
          AND session_replays.BrowserName = 'Chrome'
          AND session_replays.OsName = 'macOS'
          AND session_replays.Language = 'en-US'
          AND session_replays.UtmSource = 'twitter'
          AND session_replays.UtmMedium = 'social'
          AND session_replays.UtmCampaign = 'launch'
          AND session_replays.VisitorIsNew = 1
          AND session_replays.SessionId IN (SELECT
          session_events.SessionId AS sessionId
        FROM session_events
        WHERE session_events.OrgId = 'org_sql_catalog'
          AND session_events.Timestamp >= '2026-01-01 10:30:00'
          AND session_events.Timestamp <= '2026-01-03 14:15:00'
          AND session_events.Type = 'custom'
          AND session_events.Message = 'signup_started'
        GROUP BY sessionId)
          AND coalesce(session_replays.LastActivityAt, session_replays.StartTime) >= toDateTime('2026-01-03 14:15:00') - INTERVAL 300 SECOND
        FORMAT JSON

-- builder:web-analytics:webAnalyticsLiveQuery:filtered-rollup  [fa4bda02]
SELECT
          uniqIf(session_replays.VisitorId, session_replays.VisitorId != '') AS visitors,
          uniq(session_replays.SessionId) AS sessions
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS sessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'navigation'
          AND product_events.Host = 'maple.dev'
          AND product_events.PagePath = '/pricing'
        GROUP BY sessionId)
          AND session_replays.ReferrerHost = 't.co'
          AND session_replays.Country = 'DE'
          AND session_replays.DeviceType = 'desktop'
          AND session_replays.BrowserName = 'Chrome'
          AND session_replays.OsName = 'macOS'
          AND session_replays.Language = 'en-US'
          AND session_replays.UtmSource = 'twitter'
          AND session_replays.UtmMedium = 'social'
          AND session_replays.UtmCampaign = 'launch'
          AND session_replays.VisitorIsNew = 1
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS sessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'custom'
          AND product_events.EventName = 'signup_started'
        GROUP BY sessionId)
          AND coalesce(session_replays.LastActivityAt, session_replays.StartTime) >= toDateTime('2026-01-03 14:15:00') - INTERVAL 300 SECOND
        FORMAT JSON

-- builder:web-analytics:webAnalyticsPagesQuery:default  [579f362e]
SELECT
          domain(session_events.Url) AS host,
          path(session_events.Url) AS pagePath,
          count() AS pageViews,
          uniq(session_events.SessionId) AS sessions
        FROM session_events
        WHERE session_events.OrgId = 'org_sql_catalog'
          AND session_events.Timestamp >= '2026-01-01 10:30:00'
          AND session_events.Timestamp <= '2026-01-03 14:15:00'
          AND session_events.Type = 'navigation'
          AND domain(session_events.Url) != ''
        GROUP BY host, pagePath
        ORDER BY pageViews DESC
        LIMIT 100
        FORMAT JSON

-- builder:web-analytics:webAnalyticsPagesQuery:default-rollup  [8aa1070e]
SELECT
          product_events.Host AS host,
          product_events.PagePath AS pagePath,
          count() AS pageViews,
          uniq(product_events.SessionId) AS sessions
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'navigation'
          AND product_events.Host != ''
        GROUP BY host, pagePath
        ORDER BY pageViews DESC
        LIMIT 100
        FORMAT JSON

-- builder:web-analytics:webAnalyticsPagesQuery:semi-joined  [5b387af6]
SELECT
          domain(session_events.Url) AS host,
          path(session_events.Url) AS pagePath,
          count() AS pageViews,
          uniq(session_events.SessionId) AS sessions
        FROM session_events
        WHERE session_events.OrgId = 'org_sql_catalog'
          AND session_events.Timestamp >= '2026-01-01 10:30:00'
          AND session_events.Timestamp <= '2026-01-03 14:15:00'
          AND session_events.Type = 'navigation'
          AND session_events.SessionId IN (SELECT
          session_replays.SessionId AS sessionId
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.Country = 'DE'
        GROUP BY sessionId)
          AND domain(session_events.Url) != ''
        GROUP BY host, pagePath
        ORDER BY pageViews DESC
        LIMIT 100
        FORMAT JSON

-- builder:web-analytics:webAnalyticsPagesQuery:semi-joined-rollup  [fb16243f]
SELECT
          product_events.Host AS host,
          product_events.PagePath AS pagePath,
          count() AS pageViews,
          uniq(product_events.SessionId) AS sessions
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'navigation'
          AND product_events.SessionId IN (SELECT
          session_replays.SessionId AS sessionId
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.Country = 'DE'
        GROUP BY sessionId)
          AND product_events.Host != ''
        GROUP BY host, pagePath
        ORDER BY pageViews DESC
        LIMIT 100
        FORMAT JSON

-- builder:web-analytics:webAnalyticsPagesQuery:url-filtered  [2dcca3d1]
SELECT
          domain(session_events.Url) AS host,
          path(session_events.Url) AS pagePath,
          count() AS pageViews,
          uniq(session_events.SessionId) AS sessions
        FROM session_events
        WHERE session_events.OrgId = 'org_sql_catalog'
          AND session_events.Timestamp >= '2026-01-01 10:30:00'
          AND session_events.Timestamp <= '2026-01-03 14:15:00'
          AND session_events.Type = 'navigation'
          AND domain(session_events.Url) = 'maple.dev'
          AND domain(session_events.Url) != ''
        GROUP BY host, pagePath
        ORDER BY pageViews DESC
        LIMIT 100
        FORMAT JSON

-- builder:web-analytics:webAnalyticsPagesQuery:url-filtered-rollup  [ce4e3156]
SELECT
          product_events.Host AS host,
          product_events.PagePath AS pagePath,
          count() AS pageViews,
          uniq(product_events.SessionId) AS sessions
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'navigation'
          AND product_events.Host = 'maple.dev'
          AND product_events.Host != ''
        GROUP BY host, pagePath
        ORDER BY pageViews DESC
        LIMIT 100
        FORMAT JSON

-- builder:web-analytics:webAnalyticsPageviewsTimeseriesQuery:default  [c76443de]
SELECT
          toStartOfInterval(session_events.Timestamp, INTERVAL 3600 SECOND) AS bucket,
          count() AS pageViews,
          uniq(session_events.SessionId) AS sessions
        FROM session_events
        WHERE session_events.OrgId = 'org_sql_catalog'
          AND session_events.Timestamp >= '2026-01-01 10:30:00'
          AND session_events.Timestamp <= '2026-01-03 14:15:00'
          AND session_events.Type = 'navigation'
        GROUP BY bucket
        ORDER BY bucket ASC
        FORMAT JSON

-- builder:web-analytics:webAnalyticsPageviewsTimeseriesQuery:default-rollup  [2cadccb7]
SELECT
          toStartOfInterval(product_events.Timestamp, INTERVAL 3600 SECOND) AS bucket,
          count() AS pageViews,
          uniq(product_events.SessionId) AS sessions
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'navigation'
        GROUP BY bucket
        ORDER BY bucket ASC
        FORMAT JSON

-- builder:web-analytics:webAnalyticsPageviewsTimeseriesQuery:semi-joined  [acb8d197]
SELECT
          toStartOfInterval(session_events.Timestamp, INTERVAL 3600 SECOND) AS bucket,
          count() AS pageViews,
          uniq(session_events.SessionId) AS sessions
        FROM session_events
        WHERE session_events.OrgId = 'org_sql_catalog'
          AND session_events.Timestamp >= '2026-01-01 10:30:00'
          AND session_events.Timestamp <= '2026-01-03 14:15:00'
          AND session_events.Type = 'navigation'
          AND session_events.SessionId IN (SELECT
          session_replays.SessionId AS sessionId
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.ReferrerHost = 't.co'
          AND session_replays.VisitorIsNew = 0
        GROUP BY sessionId)
        GROUP BY bucket
        ORDER BY bucket ASC
        FORMAT JSON

-- builder:web-analytics:webAnalyticsPageviewsTimeseriesQuery:semi-joined-rollup  [6b687dbd]
SELECT
          toStartOfInterval(product_events.Timestamp, INTERVAL 3600 SECOND) AS bucket,
          count() AS pageViews,
          uniq(product_events.SessionId) AS sessions
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'navigation'
          AND product_events.SessionId IN (SELECT
          session_replays.SessionId AS sessionId
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.ReferrerHost = 't.co'
          AND session_replays.VisitorIsNew = 0
        GROUP BY sessionId)
        GROUP BY bucket
        ORDER BY bucket ASC
        FORMAT JSON

-- builder:web-analytics:webAnalyticsSummaryQuery:default  [cd960b9b]
SELECT
          uniqIf(session_replays.VisitorId, session_replays.VisitorId != '') AS visitors,
          uniq(session_replays.SessionId) AS sessions,
          uniqIf(session_replays.SessionId, session_replays.VisitorIsNew = 1) AS newSessions,
          uniqIf(session_replays.SessionId, session_replays.VisitorId != '') - uniqIf(session_replays.SessionId, (session_replays.PageViews > 1 AND session_replays.VisitorId != '')) AS bouncedSessions,
          uniqIf(session_replays.SessionId, session_replays.VisitorId != '') AS identifiedSessions,
          uniqIf(session_replays.SessionId, multiSearchAnyCaseInsensitive(session_replays.UserAgent, ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'PerplexityBot', 'Google-Extended', 'Applebot-Extended', 'meta-externalagent', 'meta-webindexer', 'Bytespider', 'CCBot', 'Amazonbot', 'DuckAssistBot', 'Googlebot', 'GoogleOther', 'AdsBot-Google', 'Google-Read-Aloud', 'bingbot', 'YandexBot', 'Baiduspider', 'DuckDuckBot', 'Applebot', 'Sogou', 'SeznamBot', 'AhrefsSiteAudit', 'AhrefsBot', 'SemrushBot', 'DataForSeoBot', 'DotBot', 'MJ12bot', 'Barkrowler', 'Screaming Frog', 'facebookexternalhit', 'Twitterbot', 'LinkedInBot', 'Slackbot', 'Discordbot', 'TelegramBot', 'Pinterest', 'HubSpot Crawler', 'Stripebot', 'UptimeRobot', 'Pingdom', 'StatusCake', 'Headless', 'bot/', 'bot\x3B', 'bot)', 'crawler', 'spider', '+http'])) AS botSessions,
          round(ifNull(ifNotFinite(avgIf(assumeNotNull(session_replays.DurationMs), session_replays.DurationMs > 0), 0), 0)) AS avgDurationMs
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
        FORMAT JSON

-- builder:web-analytics:webAnalyticsSummaryQuery:default-rollup  [cd960b9b]
SELECT
          uniqIf(session_replays.VisitorId, session_replays.VisitorId != '') AS visitors,
          uniq(session_replays.SessionId) AS sessions,
          uniqIf(session_replays.SessionId, session_replays.VisitorIsNew = 1) AS newSessions,
          uniqIf(session_replays.SessionId, session_replays.VisitorId != '') - uniqIf(session_replays.SessionId, (session_replays.PageViews > 1 AND session_replays.VisitorId != '')) AS bouncedSessions,
          uniqIf(session_replays.SessionId, session_replays.VisitorId != '') AS identifiedSessions,
          uniqIf(session_replays.SessionId, multiSearchAnyCaseInsensitive(session_replays.UserAgent, ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'PerplexityBot', 'Google-Extended', 'Applebot-Extended', 'meta-externalagent', 'meta-webindexer', 'Bytespider', 'CCBot', 'Amazonbot', 'DuckAssistBot', 'Googlebot', 'GoogleOther', 'AdsBot-Google', 'Google-Read-Aloud', 'bingbot', 'YandexBot', 'Baiduspider', 'DuckDuckBot', 'Applebot', 'Sogou', 'SeznamBot', 'AhrefsSiteAudit', 'AhrefsBot', 'SemrushBot', 'DataForSeoBot', 'DotBot', 'MJ12bot', 'Barkrowler', 'Screaming Frog', 'facebookexternalhit', 'Twitterbot', 'LinkedInBot', 'Slackbot', 'Discordbot', 'TelegramBot', 'Pinterest', 'HubSpot Crawler', 'Stripebot', 'UptimeRobot', 'Pingdom', 'StatusCake', 'Headless', 'bot/', 'bot\x3B', 'bot)', 'crawler', 'spider', '+http'])) AS botSessions,
          round(ifNull(ifNotFinite(avgIf(assumeNotNull(session_replays.DurationMs), session_replays.DurationMs > 0), 0), 0)) AS avgDurationMs
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
        FORMAT JSON

-- builder:web-analytics:webAnalyticsSummaryQuery:filtered  [8601ff7f]
SELECT
          uniqIf(session_replays.VisitorId, session_replays.VisitorId != '') AS visitors,
          uniq(session_replays.SessionId) AS sessions,
          uniqIf(session_replays.SessionId, session_replays.VisitorIsNew = 1) AS newSessions,
          uniqIf(session_replays.SessionId, session_replays.VisitorId != '') - uniqIf(session_replays.SessionId, (session_replays.PageViews > 1 AND session_replays.VisitorId != '')) AS bouncedSessions,
          uniqIf(session_replays.SessionId, session_replays.VisitorId != '') AS identifiedSessions,
          uniqIf(session_replays.SessionId, multiSearchAnyCaseInsensitive(session_replays.UserAgent, ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'PerplexityBot', 'Google-Extended', 'Applebot-Extended', 'meta-externalagent', 'meta-webindexer', 'Bytespider', 'CCBot', 'Amazonbot', 'DuckAssistBot', 'Googlebot', 'GoogleOther', 'AdsBot-Google', 'Google-Read-Aloud', 'bingbot', 'YandexBot', 'Baiduspider', 'DuckDuckBot', 'Applebot', 'Sogou', 'SeznamBot', 'AhrefsSiteAudit', 'AhrefsBot', 'SemrushBot', 'DataForSeoBot', 'DotBot', 'MJ12bot', 'Barkrowler', 'Screaming Frog', 'facebookexternalhit', 'Twitterbot', 'LinkedInBot', 'Slackbot', 'Discordbot', 'TelegramBot', 'Pinterest', 'HubSpot Crawler', 'Stripebot', 'UptimeRobot', 'Pingdom', 'StatusCake', 'Headless', 'bot/', 'bot\x3B', 'bot)', 'crawler', 'spider', '+http'])) AS botSessions,
          round(ifNull(ifNotFinite(avgIf(assumeNotNull(session_replays.DurationMs), session_replays.DurationMs > 0), 0), 0)) AS avgDurationMs
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          session_events.SessionId AS sessionId
        FROM session_events
        WHERE session_events.OrgId = 'org_sql_catalog'
          AND session_events.Timestamp >= '2026-01-01 10:30:00'
          AND session_events.Timestamp <= '2026-01-03 14:15:00'
          AND session_events.Type = 'navigation'
          AND domain(session_events.Url) = 'maple.dev'
          AND path(session_events.Url) = '/pricing'
        GROUP BY sessionId)
          AND session_replays.ReferrerHost = 't.co'
          AND session_replays.Country = 'DE'
          AND session_replays.DeviceType = 'desktop'
          AND session_replays.BrowserName = 'Chrome'
          AND session_replays.OsName = 'macOS'
          AND session_replays.Language = 'en-US'
          AND session_replays.UtmSource = 'twitter'
          AND session_replays.UtmMedium = 'social'
          AND session_replays.UtmCampaign = 'launch'
          AND session_replays.VisitorIsNew = 1
          AND session_replays.SessionId IN (SELECT
          session_events.SessionId AS sessionId
        FROM session_events
        WHERE session_events.OrgId = 'org_sql_catalog'
          AND session_events.Timestamp >= '2026-01-01 10:30:00'
          AND session_events.Timestamp <= '2026-01-03 14:15:00'
          AND session_events.Type = 'custom'
          AND session_events.Message = 'signup_started'
        GROUP BY sessionId)
        FORMAT JSON

-- builder:web-analytics:webAnalyticsSummaryQuery:filtered-rollup  [d9e8d975]
SELECT
          uniqIf(session_replays.VisitorId, session_replays.VisitorId != '') AS visitors,
          uniq(session_replays.SessionId) AS sessions,
          uniqIf(session_replays.SessionId, session_replays.VisitorIsNew = 1) AS newSessions,
          uniqIf(session_replays.SessionId, session_replays.VisitorId != '') - uniqIf(session_replays.SessionId, (session_replays.PageViews > 1 AND session_replays.VisitorId != '')) AS bouncedSessions,
          uniqIf(session_replays.SessionId, session_replays.VisitorId != '') AS identifiedSessions,
          uniqIf(session_replays.SessionId, multiSearchAnyCaseInsensitive(session_replays.UserAgent, ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'PerplexityBot', 'Google-Extended', 'Applebot-Extended', 'meta-externalagent', 'meta-webindexer', 'Bytespider', 'CCBot', 'Amazonbot', 'DuckAssistBot', 'Googlebot', 'GoogleOther', 'AdsBot-Google', 'Google-Read-Aloud', 'bingbot', 'YandexBot', 'Baiduspider', 'DuckDuckBot', 'Applebot', 'Sogou', 'SeznamBot', 'AhrefsSiteAudit', 'AhrefsBot', 'SemrushBot', 'DataForSeoBot', 'DotBot', 'MJ12bot', 'Barkrowler', 'Screaming Frog', 'facebookexternalhit', 'Twitterbot', 'LinkedInBot', 'Slackbot', 'Discordbot', 'TelegramBot', 'Pinterest', 'HubSpot Crawler', 'Stripebot', 'UptimeRobot', 'Pingdom', 'StatusCake', 'Headless', 'bot/', 'bot\x3B', 'bot)', 'crawler', 'spider', '+http'])) AS botSessions,
          round(ifNull(ifNotFinite(avgIf(assumeNotNull(session_replays.DurationMs), session_replays.DurationMs > 0), 0), 0)) AS avgDurationMs
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS sessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'navigation'
          AND product_events.Host = 'maple.dev'
          AND product_events.PagePath = '/pricing'
        GROUP BY sessionId)
          AND session_replays.ReferrerHost = 't.co'
          AND session_replays.Country = 'DE'
          AND session_replays.DeviceType = 'desktop'
          AND session_replays.BrowserName = 'Chrome'
          AND session_replays.OsName = 'macOS'
          AND session_replays.Language = 'en-US'
          AND session_replays.UtmSource = 'twitter'
          AND session_replays.UtmMedium = 'social'
          AND session_replays.UtmCampaign = 'launch'
          AND session_replays.VisitorIsNew = 1
          AND session_replays.SessionId IN (SELECT
          product_events.SessionId AS sessionId
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind = 'custom'
          AND product_events.EventName = 'signup_started'
        GROUP BY sessionId)
        FORMAT JSON

-- builder:web-analytics:webAnalyticsTimeseriesQuery:default  [ec93b790]
SELECT
          toStartOfInterval(session_replays.StartTime, INTERVAL 3600 SECOND) AS bucket,
          uniqIf(session_replays.VisitorId, session_replays.VisitorId != '') AS visitors,
          uniq(session_replays.SessionId) AS sessions,
          uniqIf(session_replays.SessionId, session_replays.VisitorIsNew = 1) AS newSessions,
          uniqIf(session_replays.SessionId, session_replays.VisitorId != '') - uniqIf(session_replays.SessionId, (session_replays.PageViews > 1 AND session_replays.VisitorId != '')) AS bouncedSessions,
          uniqIf(session_replays.SessionId, session_replays.VisitorId != '') AS identifiedSessions,
          round(ifNull(ifNotFinite(avgIf(assumeNotNull(session_replays.DurationMs), session_replays.DurationMs > 0), 0), 0)) AS avgDurationMs
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
        GROUP BY bucket
        ORDER BY bucket ASC
        FORMAT JSON

-- builder:web-analytics:webAnalyticsTimeseriesQuery:default-rollup  [ec93b790]
SELECT
          toStartOfInterval(session_replays.StartTime, INTERVAL 3600 SECOND) AS bucket,
          uniqIf(session_replays.VisitorId, session_replays.VisitorId != '') AS visitors,
          uniq(session_replays.SessionId) AS sessions,
          uniqIf(session_replays.SessionId, session_replays.VisitorIsNew = 1) AS newSessions,
          uniqIf(session_replays.SessionId, session_replays.VisitorId != '') - uniqIf(session_replays.SessionId, (session_replays.PageViews > 1 AND session_replays.VisitorId != '')) AS bouncedSessions,
          uniqIf(session_replays.SessionId, session_replays.VisitorId != '') AS identifiedSessions,
          round(ifNull(ifNotFinite(avgIf(assumeNotNull(session_replays.DurationMs), session_replays.DurationMs > 0), 0), 0)) AS avgDurationMs
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-01 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
        GROUP BY bucket
        ORDER BY bucket ASC
        FORMAT JSON

-- pipe:custom_traces_breakdown:all-root-only:baseline  [7f1ac5f3]
SELECT
          'all' AS name,
          sum(service_overview_spans.SampleRate) AS count,
          count() AS spanCount,
          avg(service_overview_spans.Duration) / 1000000 AS avgDuration,
          quantile(0.5)(service_overview_spans.Duration) / 1000000 AS p50Duration,
          quantile(0.95)(service_overview_spans.Duration) / 1000000 AS p95Duration,
          quantile(0.99)(service_overview_spans.Duration) / 1000000 AS p99Duration,
          if(sum(service_overview_spans.SampleRate) > 0, sumIf(service_overview_spans.SampleRate, service_overview_spans.StatusCode = 'Error') / sum(service_overview_spans.SampleRate), 0) AS errorRate,
          countIf((NOT (service_overview_spans.StatusCode = 'Error') AND service_overview_spans.Duration / 1000000 < 500)) AS satisfiedCount,
          countIf((NOT (service_overview_spans.StatusCode = 'Error') AND (service_overview_spans.Duration / 1000000 >= 500 AND service_overview_spans.Duration / 1000000 < 2000))) AS toleratingCount,
          if(count() > 0, round(countIf((NOT (service_overview_spans.StatusCode = 'Error') AND service_overview_spans.Duration / 1000000 < 500)) / count() + countIf((NOT (service_overview_spans.StatusCode = 'Error') AND (service_overview_spans.Duration / 1000000 >= 500 AND service_overview_spans.Duration / 1000000 < 2000))) * 0.5 / count(), 4), 0) AS apdexScore
        FROM service_overview_spans
        WHERE service_overview_spans.OrgId = 'org_sql_catalog'
          AND service_overview_spans.Timestamp >= '2026-01-01 10:30:00'
          AND service_overview_spans.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY name
        ORDER BY count DESC
        LIMIT 1
        FORMAT JSON

-- pipe:custom_traces_breakdown:all-scoped:baseline  [7415aa0d]
SELECT
          'all' AS name,
          sum(service_overview_spans.SampleRate) AS count,
          count() AS spanCount,
          avg(service_overview_spans.Duration) / 1000000 AS avgDuration,
          quantile(0.5)(service_overview_spans.Duration) / 1000000 AS p50Duration,
          quantile(0.95)(service_overview_spans.Duration) / 1000000 AS p95Duration,
          quantile(0.99)(service_overview_spans.Duration) / 1000000 AS p99Duration,
          if(sum(service_overview_spans.SampleRate) > 0, sumIf(service_overview_spans.SampleRate, service_overview_spans.StatusCode = 'Error') / sum(service_overview_spans.SampleRate), 0) AS errorRate,
          countIf((NOT (service_overview_spans.StatusCode = 'Error') AND service_overview_spans.Duration / 1000000 < 500)) AS satisfiedCount,
          countIf((NOT (service_overview_spans.StatusCode = 'Error') AND (service_overview_spans.Duration / 1000000 >= 500 AND service_overview_spans.Duration / 1000000 < 2000))) AS toleratingCount,
          if(count() > 0, round(countIf((NOT (service_overview_spans.StatusCode = 'Error') AND service_overview_spans.Duration / 1000000 < 500)) / count() + countIf((NOT (service_overview_spans.StatusCode = 'Error') AND (service_overview_spans.Duration / 1000000 >= 500 AND service_overview_spans.Duration / 1000000 < 2000))) * 0.5 / count(), 4), 0) AS apdexScore
        FROM service_overview_spans
        WHERE service_overview_spans.OrgId = 'org_sql_catalog'
          AND service_overview_spans.Timestamp >= '2026-01-01 10:30:00'
          AND service_overview_spans.Timestamp <= '2026-01-03 14:15:00'
          AND service_overview_spans.DeploymentEnv IN ('production')
          AND service_overview_spans.ServiceNamespace IN ('commerce')
        GROUP BY name
        ORDER BY count DESC
        LIMIT 1
        FORMAT JSON

-- pipe:custom_traces_breakdown:by-attribute:baseline  [be0963d3]
SELECT
          traces.SpanAttributes['http.route'] AS name,
          sum(traces.SampleRate) AS count,
          count() AS spanCount,
          avg(traces.Duration) / 1000000 AS avgDuration,
          quantile(0.5)(traces.Duration) / 1000000 AS p50Duration,
          quantile(0.95)(traces.Duration) / 1000000 AS p95Duration,
          quantile(0.99)(traces.Duration) / 1000000 AS p99Duration,
          if(sum(traces.SampleRate) > 0, sumIf(traces.SampleRate, traces.StatusCode = 'Error') / sum(traces.SampleRate), 0) AS errorRate,
          countIf((NOT (traces.StatusCode = 'Error') AND traces.Duration / 1000000 < 500)) AS satisfiedCount,
          countIf((NOT (traces.StatusCode = 'Error') AND (traces.Duration / 1000000 >= 500 AND traces.Duration / 1000000 < 2000))) AS toleratingCount,
          if(count() > 0, round(countIf((NOT (traces.StatusCode = 'Error') AND traces.Duration / 1000000 < 500)) / count() + countIf((NOT (traces.StatusCode = 'Error') AND (traces.Duration / 1000000 >= 500 AND traces.Duration / 1000000 < 2000))) * 0.5 / count(), 4), 0) AS apdexScore
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY name
        ORDER BY count DESC
        LIMIT 10
        FORMAT JSON

-- pipe:custom_traces_breakdown:by-attribute:bloom  [be0963d3]
SELECT
          traces.SpanAttributes['http.route'] AS name,
          sum(traces.SampleRate) AS count,
          count() AS spanCount,
          avg(traces.Duration) / 1000000 AS avgDuration,
          quantile(0.5)(traces.Duration) / 1000000 AS p50Duration,
          quantile(0.95)(traces.Duration) / 1000000 AS p95Duration,
          quantile(0.99)(traces.Duration) / 1000000 AS p99Duration,
          if(sum(traces.SampleRate) > 0, sumIf(traces.SampleRate, traces.StatusCode = 'Error') / sum(traces.SampleRate), 0) AS errorRate,
          countIf((NOT (traces.StatusCode = 'Error') AND traces.Duration / 1000000 < 500)) AS satisfiedCount,
          countIf((NOT (traces.StatusCode = 'Error') AND (traces.Duration / 1000000 >= 500 AND traces.Duration / 1000000 < 2000))) AS toleratingCount,
          if(count() > 0, round(countIf((NOT (traces.StatusCode = 'Error') AND traces.Duration / 1000000 < 500)) / count() + countIf((NOT (traces.StatusCode = 'Error') AND (traces.Duration / 1000000 >= 500 AND traces.Duration / 1000000 < 2000))) * 0.5 / count(), 4), 0) AS apdexScore
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY name
        ORDER BY count DESC
        LIMIT 10
        FORMAT JSON

-- pipe:custom_traces_breakdown:by-attribute:text  [be0963d3]
SELECT
          traces.SpanAttributes['http.route'] AS name,
          sum(traces.SampleRate) AS count,
          count() AS spanCount,
          avg(traces.Duration) / 1000000 AS avgDuration,
          quantile(0.5)(traces.Duration) / 1000000 AS p50Duration,
          quantile(0.95)(traces.Duration) / 1000000 AS p95Duration,
          quantile(0.99)(traces.Duration) / 1000000 AS p99Duration,
          if(sum(traces.SampleRate) > 0, sumIf(traces.SampleRate, traces.StatusCode = 'Error') / sum(traces.SampleRate), 0) AS errorRate,
          countIf((NOT (traces.StatusCode = 'Error') AND traces.Duration / 1000000 < 500)) AS satisfiedCount,
          countIf((NOT (traces.StatusCode = 'Error') AND (traces.Duration / 1000000 >= 500 AND traces.Duration / 1000000 < 2000))) AS toleratingCount,
          if(count() > 0, round(countIf((NOT (traces.StatusCode = 'Error') AND traces.Duration / 1000000 < 500)) / count() + countIf((NOT (traces.StatusCode = 'Error') AND (traces.Duration / 1000000 >= 500 AND traces.Duration / 1000000 < 2000))) * 0.5 / count(), 4), 0) AS apdexScore
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY name
        ORDER BY count DESC
        LIMIT 10
        FORMAT JSON

-- pipe:custom_traces_breakdown:by-environment:baseline  [cf11be63]
SELECT
          service_overview_spans.DeploymentEnv AS name,
          sum(service_overview_spans.SampleRate) AS count,
          count() AS spanCount,
          avg(service_overview_spans.Duration) / 1000000 AS avgDuration,
          quantile(0.5)(service_overview_spans.Duration) / 1000000 AS p50Duration,
          quantile(0.95)(service_overview_spans.Duration) / 1000000 AS p95Duration,
          quantile(0.99)(service_overview_spans.Duration) / 1000000 AS p99Duration,
          if(sum(service_overview_spans.SampleRate) > 0, sumIf(service_overview_spans.SampleRate, service_overview_spans.StatusCode = 'Error') / sum(service_overview_spans.SampleRate), 0) AS errorRate,
          countIf((NOT (service_overview_spans.StatusCode = 'Error') AND service_overview_spans.Duration / 1000000 < 500)) AS satisfiedCount,
          countIf((NOT (service_overview_spans.StatusCode = 'Error') AND (service_overview_spans.Duration / 1000000 >= 500 AND service_overview_spans.Duration / 1000000 < 2000))) AS toleratingCount,
          if(count() > 0, round(countIf((NOT (service_overview_spans.StatusCode = 'Error') AND service_overview_spans.Duration / 1000000 < 500)) / count() + countIf((NOT (service_overview_spans.StatusCode = 'Error') AND (service_overview_spans.Duration / 1000000 >= 500 AND service_overview_spans.Duration / 1000000 < 2000))) * 0.5 / count(), 4), 0) AS apdexScore
        FROM service_overview_spans
        WHERE service_overview_spans.OrgId = 'org_sql_catalog'
          AND service_overview_spans.Timestamp >= '2026-01-01 10:30:00'
          AND service_overview_spans.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY name
        ORDER BY count DESC
        LIMIT 10
        FORMAT JSON

-- pipe:custom_traces_breakdown:by-namespace:baseline  [6a34e437]
SELECT
          service_overview_spans.ServiceNamespace AS name,
          sum(service_overview_spans.SampleRate) AS count,
          count() AS spanCount,
          avg(service_overview_spans.Duration) / 1000000 AS avgDuration,
          quantile(0.5)(service_overview_spans.Duration) / 1000000 AS p50Duration,
          quantile(0.95)(service_overview_spans.Duration) / 1000000 AS p95Duration,
          quantile(0.99)(service_overview_spans.Duration) / 1000000 AS p99Duration,
          if(sum(service_overview_spans.SampleRate) > 0, sumIf(service_overview_spans.SampleRate, service_overview_spans.StatusCode = 'Error') / sum(service_overview_spans.SampleRate), 0) AS errorRate,
          countIf((NOT (service_overview_spans.StatusCode = 'Error') AND service_overview_spans.Duration / 1000000 < 500)) AS satisfiedCount,
          countIf((NOT (service_overview_spans.StatusCode = 'Error') AND (service_overview_spans.Duration / 1000000 >= 500 AND service_overview_spans.Duration / 1000000 < 2000))) AS toleratingCount,
          if(count() > 0, round(countIf((NOT (service_overview_spans.StatusCode = 'Error') AND service_overview_spans.Duration / 1000000 < 500)) / count() + countIf((NOT (service_overview_spans.StatusCode = 'Error') AND (service_overview_spans.Duration / 1000000 >= 500 AND service_overview_spans.Duration / 1000000 < 2000))) * 0.5 / count(), 4), 0) AS apdexScore
        FROM service_overview_spans
        WHERE service_overview_spans.OrgId = 'org_sql_catalog'
          AND service_overview_spans.Timestamp >= '2026-01-01 10:30:00'
          AND service_overview_spans.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY name
        ORDER BY count DESC
        LIMIT 10
        FORMAT JSON

-- pipe:custom_traces_breakdown:by-service:baseline  [82decd03]
SELECT
          traces.ServiceName AS name,
          sum(traces.SampleRate) AS count,
          count() AS spanCount,
          avg(traces.Duration) / 1000000 AS avgDuration,
          quantile(0.5)(traces.Duration) / 1000000 AS p50Duration,
          quantile(0.95)(traces.Duration) / 1000000 AS p95Duration,
          quantile(0.99)(traces.Duration) / 1000000 AS p99Duration,
          if(sum(traces.SampleRate) > 0, sumIf(traces.SampleRate, traces.StatusCode = 'Error') / sum(traces.SampleRate), 0) AS errorRate,
          countIf((NOT (traces.StatusCode = 'Error') AND traces.Duration / 1000000 < 500)) AS satisfiedCount,
          countIf((NOT (traces.StatusCode = 'Error') AND (traces.Duration / 1000000 >= 500 AND traces.Duration / 1000000 < 2000))) AS toleratingCount,
          if(count() > 0, round(countIf((NOT (traces.StatusCode = 'Error') AND traces.Duration / 1000000 < 500)) / count() + countIf((NOT (traces.StatusCode = 'Error') AND (traces.Duration / 1000000 >= 500 AND traces.Duration / 1000000 < 2000))) * 0.5 / count(), 4), 0) AS apdexScore
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY name
        ORDER BY count DESC
        LIMIT 10
        FORMAT JSON

-- pipe:custom_traces_timeseries:errors-only:baseline  [9b79a0d9]
SELECT
          toStartOfInterval(service_overview_spans.Timestamp, INTERVAL 3600 SECOND) AS bucket,
          'all' AS groupName,
          sum(service_overview_spans.SampleRate) AS count,
          count() AS spanCount,
          avg(service_overview_spans.Duration) / 1000000 AS avgDuration,
          quantile(0.5)(service_overview_spans.Duration) / 1000000 AS p50Duration,
          quantile(0.95)(service_overview_spans.Duration) / 1000000 AS p95Duration,
          quantile(0.99)(service_overview_spans.Duration) / 1000000 AS p99Duration,
          if(sum(service_overview_spans.SampleRate) > 0, sumIf(service_overview_spans.SampleRate, service_overview_spans.StatusCode = 'Error') / sum(service_overview_spans.SampleRate), 0) AS errorRate,
          countIf((NOT (service_overview_spans.StatusCode = 'Error') AND service_overview_spans.Duration / 1000000 < 500)) AS satisfiedCount,
          countIf((NOT (service_overview_spans.StatusCode = 'Error') AND (service_overview_spans.Duration / 1000000 >= 500 AND service_overview_spans.Duration / 1000000 < 2000))) AS toleratingCount,
          if(count() > 0, round(countIf((NOT (service_overview_spans.StatusCode = 'Error') AND service_overview_spans.Duration / 1000000 < 500)) / count() + countIf((NOT (service_overview_spans.StatusCode = 'Error') AND (service_overview_spans.Duration / 1000000 >= 500 AND service_overview_spans.Duration / 1000000 < 2000))) * 0.5 / count(), 4), 0) AS apdexScore,
          sum(service_overview_spans.SampleRate) AS estimatedSpanCount
        FROM service_overview_spans
        WHERE service_overview_spans.OrgId = 'org_sql_catalog'
          AND service_overview_spans.Timestamp >= '2026-01-01 10:30:00'
          AND service_overview_spans.Timestamp <= '2026-01-03 14:15:00'
          AND service_overview_spans.StatusCode = 'Error'
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- pipe:custom_traces_timeseries:grouped-by-attribute:baseline  [30103eb5]
SELECT
          toStartOfInterval(traces.Timestamp, INTERVAL 300 SECOND) AS bucket,
          coalesce(nullIf(arrayStringConcat([toString(traces.SpanAttributes['http.route']), toString(traces.SpanAttributes['http.method'])], ' · '), ''), 'all') AS groupName,
          sum(traces.SampleRate) AS count,
          count() AS spanCount,
          avg(traces.Duration) / 1000000 AS avgDuration,
          quantile(0.5)(traces.Duration) / 1000000 AS p50Duration,
          quantile(0.95)(traces.Duration) / 1000000 AS p95Duration,
          quantile(0.99)(traces.Duration) / 1000000 AS p99Duration,
          if(sum(traces.SampleRate) > 0, sumIf(traces.SampleRate, traces.StatusCode = 'Error') / sum(traces.SampleRate), 0) AS errorRate,
          countIf((NOT (traces.StatusCode = 'Error') AND traces.Duration / 1000000 < 500)) AS satisfiedCount,
          countIf((NOT (traces.StatusCode = 'Error') AND (traces.Duration / 1000000 >= 500 AND traces.Duration / 1000000 < 2000))) AS toleratingCount,
          if(count() > 0, round(countIf((NOT (traces.StatusCode = 'Error') AND traces.Duration / 1000000 < 500)) / count() + countIf((NOT (traces.StatusCode = 'Error') AND (traces.Duration / 1000000 >= 500 AND traces.Duration / 1000000 < 2000))) * 0.5 / count(), 4), 0) AS apdexScore,
          sum(traces.SampleRate) AS estimatedSpanCount
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- pipe:custom_traces_timeseries:grouped-by-attribute:bloom  [30103eb5]
SELECT
          toStartOfInterval(traces.Timestamp, INTERVAL 300 SECOND) AS bucket,
          coalesce(nullIf(arrayStringConcat([toString(traces.SpanAttributes['http.route']), toString(traces.SpanAttributes['http.method'])], ' · '), ''), 'all') AS groupName,
          sum(traces.SampleRate) AS count,
          count() AS spanCount,
          avg(traces.Duration) / 1000000 AS avgDuration,
          quantile(0.5)(traces.Duration) / 1000000 AS p50Duration,
          quantile(0.95)(traces.Duration) / 1000000 AS p95Duration,
          quantile(0.99)(traces.Duration) / 1000000 AS p99Duration,
          if(sum(traces.SampleRate) > 0, sumIf(traces.SampleRate, traces.StatusCode = 'Error') / sum(traces.SampleRate), 0) AS errorRate,
          countIf((NOT (traces.StatusCode = 'Error') AND traces.Duration / 1000000 < 500)) AS satisfiedCount,
          countIf((NOT (traces.StatusCode = 'Error') AND (traces.Duration / 1000000 >= 500 AND traces.Duration / 1000000 < 2000))) AS toleratingCount,
          if(count() > 0, round(countIf((NOT (traces.StatusCode = 'Error') AND traces.Duration / 1000000 < 500)) / count() + countIf((NOT (traces.StatusCode = 'Error') AND (traces.Duration / 1000000 >= 500 AND traces.Duration / 1000000 < 2000))) * 0.5 / count(), 4), 0) AS apdexScore,
          sum(traces.SampleRate) AS estimatedSpanCount
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- pipe:custom_traces_timeseries:grouped-by-attribute:text  [30103eb5]
SELECT
          toStartOfInterval(traces.Timestamp, INTERVAL 300 SECOND) AS bucket,
          coalesce(nullIf(arrayStringConcat([toString(traces.SpanAttributes['http.route']), toString(traces.SpanAttributes['http.method'])], ' · '), ''), 'all') AS groupName,
          sum(traces.SampleRate) AS count,
          count() AS spanCount,
          avg(traces.Duration) / 1000000 AS avgDuration,
          quantile(0.5)(traces.Duration) / 1000000 AS p50Duration,
          quantile(0.95)(traces.Duration) / 1000000 AS p95Duration,
          quantile(0.99)(traces.Duration) / 1000000 AS p99Duration,
          if(sum(traces.SampleRate) > 0, sumIf(traces.SampleRate, traces.StatusCode = 'Error') / sum(traces.SampleRate), 0) AS errorRate,
          countIf((NOT (traces.StatusCode = 'Error') AND traces.Duration / 1000000 < 500)) AS satisfiedCount,
          countIf((NOT (traces.StatusCode = 'Error') AND (traces.Duration / 1000000 >= 500 AND traces.Duration / 1000000 < 2000))) AS toleratingCount,
          if(count() > 0, round(countIf((NOT (traces.StatusCode = 'Error') AND traces.Duration / 1000000 < 500)) / count() + countIf((NOT (traces.StatusCode = 'Error') AND (traces.Duration / 1000000 >= 500 AND traces.Duration / 1000000 < 2000))) * 0.5 / count(), 4), 0) AS apdexScore,
          sum(traces.SampleRate) AS estimatedSpanCount
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- pipe:custom_traces_timeseries:grouped-by-service:baseline  [2bca0cde]
SELECT
          toStartOfInterval(traces.Timestamp, INTERVAL 60 SECOND) AS bucket,
          coalesce(nullIf(toString(traces.ServiceName), ''), 'all') AS groupName,
          sum(traces.SampleRate) AS count,
          count() AS spanCount,
          avg(traces.Duration) / 1000000 AS avgDuration,
          quantile(0.5)(traces.Duration) / 1000000 AS p50Duration,
          quantile(0.95)(traces.Duration) / 1000000 AS p95Duration,
          quantile(0.99)(traces.Duration) / 1000000 AS p99Duration,
          if(sum(traces.SampleRate) > 0, sumIf(traces.SampleRate, traces.StatusCode = 'Error') / sum(traces.SampleRate), 0) AS errorRate,
          countIf((NOT (traces.StatusCode = 'Error') AND traces.Duration / 1000000 < 500)) AS satisfiedCount,
          countIf((NOT (traces.StatusCode = 'Error') AND (traces.Duration / 1000000 >= 500 AND traces.Duration / 1000000 < 2000))) AS toleratingCount,
          if(count() > 0, round(countIf((NOT (traces.StatusCode = 'Error') AND traces.Duration / 1000000 < 500)) / count() + countIf((NOT (traces.StatusCode = 'Error') AND (traces.Duration / 1000000 >= 500 AND traces.Duration / 1000000 < 2000))) * 0.5 / count(), 4), 0) AS apdexScore,
          sum(traces.SampleRate) AS estimatedSpanCount
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- pipe:custom_traces_timeseries:grouped-by-service:bloom  [2bca0cde]
SELECT
          toStartOfInterval(traces.Timestamp, INTERVAL 60 SECOND) AS bucket,
          coalesce(nullIf(toString(traces.ServiceName), ''), 'all') AS groupName,
          sum(traces.SampleRate) AS count,
          count() AS spanCount,
          avg(traces.Duration) / 1000000 AS avgDuration,
          quantile(0.5)(traces.Duration) / 1000000 AS p50Duration,
          quantile(0.95)(traces.Duration) / 1000000 AS p95Duration,
          quantile(0.99)(traces.Duration) / 1000000 AS p99Duration,
          if(sum(traces.SampleRate) > 0, sumIf(traces.SampleRate, traces.StatusCode = 'Error') / sum(traces.SampleRate), 0) AS errorRate,
          countIf((NOT (traces.StatusCode = 'Error') AND traces.Duration / 1000000 < 500)) AS satisfiedCount,
          countIf((NOT (traces.StatusCode = 'Error') AND (traces.Duration / 1000000 >= 500 AND traces.Duration / 1000000 < 2000))) AS toleratingCount,
          if(count() > 0, round(countIf((NOT (traces.StatusCode = 'Error') AND traces.Duration / 1000000 < 500)) / count() + countIf((NOT (traces.StatusCode = 'Error') AND (traces.Duration / 1000000 >= 500 AND traces.Duration / 1000000 < 2000))) * 0.5 / count(), 4), 0) AS apdexScore,
          sum(traces.SampleRate) AS estimatedSpanCount
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- pipe:custom_traces_timeseries:grouped-by-service:text  [2bca0cde]
SELECT
          toStartOfInterval(traces.Timestamp, INTERVAL 60 SECOND) AS bucket,
          coalesce(nullIf(toString(traces.ServiceName), ''), 'all') AS groupName,
          sum(traces.SampleRate) AS count,
          count() AS spanCount,
          avg(traces.Duration) / 1000000 AS avgDuration,
          quantile(0.5)(traces.Duration) / 1000000 AS p50Duration,
          quantile(0.95)(traces.Duration) / 1000000 AS p95Duration,
          quantile(0.99)(traces.Duration) / 1000000 AS p99Duration,
          if(sum(traces.SampleRate) > 0, sumIf(traces.SampleRate, traces.StatusCode = 'Error') / sum(traces.SampleRate), 0) AS errorRate,
          countIf((NOT (traces.StatusCode = 'Error') AND traces.Duration / 1000000 < 500)) AS satisfiedCount,
          countIf((NOT (traces.StatusCode = 'Error') AND (traces.Duration / 1000000 >= 500 AND traces.Duration / 1000000 < 2000))) AS toleratingCount,
          if(count() > 0, round(countIf((NOT (traces.StatusCode = 'Error') AND traces.Duration / 1000000 < 500)) / count() + countIf((NOT (traces.StatusCode = 'Error') AND (traces.Duration / 1000000 >= 500 AND traces.Duration / 1000000 < 2000))) * 0.5 / count(), 4), 0) AS apdexScore,
          sum(traces.SampleRate) AS estimatedSpanCount
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- pipe:custom_traces_timeseries:root-only:baseline  [73156e58]
SELECT
          toStartOfInterval(service_overview_spans.Timestamp, INTERVAL 3600 SECOND) AS bucket,
          'all' AS groupName,
          sum(service_overview_spans.SampleRate) AS count,
          count() AS spanCount,
          avg(service_overview_spans.Duration) / 1000000 AS avgDuration,
          quantile(0.5)(service_overview_spans.Duration) / 1000000 AS p50Duration,
          quantile(0.95)(service_overview_spans.Duration) / 1000000 AS p95Duration,
          quantile(0.99)(service_overview_spans.Duration) / 1000000 AS p99Duration,
          if(sum(service_overview_spans.SampleRate) > 0, sumIf(service_overview_spans.SampleRate, service_overview_spans.StatusCode = 'Error') / sum(service_overview_spans.SampleRate), 0) AS errorRate,
          countIf((NOT (service_overview_spans.StatusCode = 'Error') AND service_overview_spans.Duration / 1000000 < 500)) AS satisfiedCount,
          countIf((NOT (service_overview_spans.StatusCode = 'Error') AND (service_overview_spans.Duration / 1000000 >= 500 AND service_overview_spans.Duration / 1000000 < 2000))) AS toleratingCount,
          if(count() > 0, round(countIf((NOT (service_overview_spans.StatusCode = 'Error') AND service_overview_spans.Duration / 1000000 < 500)) / count() + countIf((NOT (service_overview_spans.StatusCode = 'Error') AND (service_overview_spans.Duration / 1000000 >= 500 AND service_overview_spans.Duration / 1000000 < 2000))) * 0.5 / count(), 4), 0) AS apdexScore,
          sum(service_overview_spans.SampleRate) AS estimatedSpanCount
        FROM service_overview_spans
        WHERE service_overview_spans.OrgId = 'org_sql_catalog'
          AND service_overview_spans.Timestamp >= '2026-01-01 10:30:00'
          AND service_overview_spans.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- pipe:custom_traces_timeseries:ungrouped:baseline  [bf7e8cb7]
SELECT
          toStartOfInterval(traces.Timestamp, INTERVAL 3600 SECOND) AS bucket,
          'all' AS groupName,
          sum(traces.SampleRate) AS count,
          count() AS spanCount,
          avg(traces.Duration) / 1000000 AS avgDuration,
          quantile(0.5)(traces.Duration) / 1000000 AS p50Duration,
          quantile(0.95)(traces.Duration) / 1000000 AS p95Duration,
          quantile(0.99)(traces.Duration) / 1000000 AS p99Duration,
          if(sum(traces.SampleRate) > 0, sumIf(traces.SampleRate, traces.StatusCode = 'Error') / sum(traces.SampleRate), 0) AS errorRate,
          countIf((NOT (traces.StatusCode = 'Error') AND traces.Duration / 1000000 < 500)) AS satisfiedCount,
          countIf((NOT (traces.StatusCode = 'Error') AND (traces.Duration / 1000000 >= 500 AND traces.Duration / 1000000 < 2000))) AS toleratingCount,
          if(count() > 0, round(countIf((NOT (traces.StatusCode = 'Error') AND traces.Duration / 1000000 < 500)) / count() + countIf((NOT (traces.StatusCode = 'Error') AND (traces.Duration / 1000000 >= 500 AND traces.Duration / 1000000 < 2000))) * 0.5 / count(), 4), 0) AS apdexScore,
          sum(traces.SampleRate) AS estimatedSpanCount
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- pipe:error_detail_traces:default:baseline  [c69b9a20]
SELECT
          trace_detail_spans.TraceId AS traceId,
          min(trace_detail_spans.Timestamp) AS startTime,
          intDiv(max(trace_detail_spans.Duration), 1000) AS durationMicros,
          count() AS spanCount,
          groupUniqArray(trace_detail_spans.ServiceName) AS services,
          anyIf(trace_detail_spans.SpanName, trace_detail_spans.ParentSpanId = '') AS rootSpanName,
          anyIf(trace_detail_spans.StatusMessage, trace_detail_spans.SpanId = occurrence.occurrenceSpanId) AS errorMessage,
          anyIf(trace_detail_spans.SpanId, trace_detail_spans.SpanId = occurrence.occurrenceSpanId) AS errorSpanId,
          anyIf(trace_detail_spans.SpanName, trace_detail_spans.SpanId = occurrence.occurrenceSpanId) AS errorSpanName,
          anyIf(trace_detail_spans.ServiceName, trace_detail_spans.SpanId = occurrence.occurrenceSpanId) AS errorServiceName,
          anyIf(trace_detail_spans.SpanAttributes['gen_ai.request.model'], trace_detail_spans.SpanId = occurrence.occurrenceSpanId) AS errorModel,
          anyIf(trace_detail_spans.SpanAttributes['gen_ai.tool.name'], trace_detail_spans.SpanId = occurrence.occurrenceSpanId) AS errorToolName,
          anyIf(trace_detail_spans.SpanAttributes['http.request.method'], trace_detail_spans.SpanId = occurrence.occurrenceSpanId) AS errorHttpMethod,
          anyIf(trace_detail_spans.SpanAttributes['http.route'], trace_detail_spans.SpanId = occurrence.occurrenceSpanId) AS errorHttpRoute,
          anyIf(trace_detail_spans.SpanAttributes['query.context'], trace_detail_spans.SpanId = occurrence.occurrenceSpanId) AS errorQueryContext,
          anyIf(trace_detail_spans.SpanAttributes['error.type'], trace_detail_spans.SpanId = occurrence.occurrenceSpanId) AS errorType,
          any(occurrence.occurrenceLabel) AS errorLabel,
          any(occurrence.occurrenceExceptionType) AS exceptionType,
          any(occurrence.occurrenceExceptionMessage) AS exceptionMessage
        FROM trace_detail_spans
        INNER JOIN (SELECT
          error_events.TraceId AS TraceId,
          max(error_events.Timestamp) AS lastErrorSeen,
          argMax(error_events.SpanId, error_events.Timestamp) AS occurrenceSpanId,
          argMax(error_events.ErrorLabel, error_events.Timestamp) AS occurrenceLabel,
          argMax(error_events.ExceptionType, error_events.Timestamp) AS occurrenceExceptionType,
          argMax(error_events.ExceptionMessage, error_events.Timestamp) AS occurrenceExceptionMessage
        FROM error_events
        WHERE error_events.OrgId = 'org_sql_catalog'
          AND error_events.FingerprintHash = toUInt64('11640393269246331608')
          AND error_events.Timestamp >= '2026-01-01 10:30:00'
          AND error_events.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY TraceId
        ORDER BY lastErrorSeen DESC, TraceId DESC
        LIMIT 10) AS occurrence ON trace_detail_spans.TraceId = occurrence.TraceId
        WHERE trace_detail_spans.OrgId = 'org_sql_catalog'
          AND trace_detail_spans.TraceId IN (SELECT
          matching_traces.TraceId AS TraceId
        FROM (SELECT
          error_events.TraceId AS TraceId,
          max(error_events.Timestamp) AS lastErrorSeen,
          argMax(error_events.SpanId, error_events.Timestamp) AS occurrenceSpanId,
          argMax(error_events.ErrorLabel, error_events.Timestamp) AS occurrenceLabel,
          argMax(error_events.ExceptionType, error_events.Timestamp) AS occurrenceExceptionType,
          argMax(error_events.ExceptionMessage, error_events.Timestamp) AS occurrenceExceptionMessage
        FROM error_events
        WHERE error_events.OrgId = 'org_sql_catalog'
          AND error_events.FingerprintHash = toUInt64('11640393269246331608')
          AND error_events.Timestamp >= '2026-01-01 10:30:00'
          AND error_events.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY TraceId
        ORDER BY lastErrorSeen DESC, TraceId DESC
        LIMIT 10) AS matching_traces)
          AND trace_detail_spans.Timestamp >= '2026-01-01 10:30:00'
          AND trace_detail_spans.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY traceId
        ORDER BY startTime DESC
        FORMAT JSON

-- pipe:error_issue_environments:default:baseline  [ac20faf3]
SELECT
          error_events.DeploymentEnv AS name,
          count() AS count
        FROM error_events
        WHERE error_events.OrgId = 'org_sql_catalog'
          AND error_events.FingerprintHash = toUInt64('11640393269246331608')
          AND error_events.Timestamp >= '2026-01-01 10:30:00'
          AND error_events.Timestamp <= '2026-01-03 14:15:00'
          AND error_events.DeploymentEnv != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
        FORMAT JSON

-- pipe:error_issue_sample_traces:default:baseline  [2974a216]
SELECT
          error_events.TraceId AS traceId,
          error_events.SpanId AS spanId,
          error_events.ServiceName AS serviceName,
          error_events.Timestamp AS timestamp,
          error_events.ExceptionMessage AS exceptionMessage,
          intDiv(error_events.Duration, 1000) AS durationMicros
        FROM error_events
        WHERE error_events.OrgId = 'org_sql_catalog'
          AND error_events.FingerprintHash = toUInt64('11640393269246331608')
          AND error_events.Timestamp >= '2026-01-01 10:30:00'
          AND error_events.Timestamp <= '2026-01-03 14:15:00'
        ORDER BY timestamp DESC
        LIMIT 25
        FORMAT JSON

-- pipe:error_issue_timeseries:default:baseline  [6e698308]
SELECT
          toStartOfInterval(error_events.Timestamp, INTERVAL 3600 SECOND) AS bucket,
          count() AS count
        FROM error_events
        WHERE error_events.OrgId = 'org_sql_catalog'
          AND error_events.FingerprintHash = toUInt64('11640393269246331608')
          AND error_events.Timestamp >= '2026-01-01 10:30:00'
          AND error_events.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY bucket
        ORDER BY bucket ASC
        FORMAT JSON

-- pipe:error_issues:default:baseline  [9440ec9b]
SELECT
          toString(error_events_by_time.FingerprintHash) AS fingerprintHash,
          any(error_events_by_time.ServiceName) AS serviceName,
          any(error_events_by_time.ExceptionType) AS exceptionType,
          any(error_events_by_time.ExceptionMessage) AS exceptionMessage,
          any(error_events_by_time.ErrorLabel) AS errorLabel,
          any(error_events_by_time.TopFrame) AS topFrame,
          count() AS count,
          uniq(error_events_by_time.ServiceName) AS affectedServicesCount,
          min(error_events_by_time.Timestamp) AS firstSeen,
          max(error_events_by_time.Timestamp) AS lastSeen
        FROM error_events_by_time
        WHERE error_events_by_time.OrgId = 'org_sql_catalog'
          AND error_events_by_time.Timestamp >= '2026-01-01 10:30:00'
          AND error_events_by_time.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY fingerprintHash
        ORDER BY count DESC
        LIMIT 50
        FORMAT JSON

-- pipe:error_rate_by_service:default:baseline  [1ac6f87e]
SELECT
          rates.serviceName AS serviceName,
          sum(rates.bucketTotalLogs) AS totalLogs,
          sum(rates.bucketErrorLogs) AS errorLogs,
          ifNull(ifNotFinite(round(sum(rates.bucketErrorLogs) / sum(rates.bucketTotalLogs), 6), 0), 0) AS errorRate
        FROM (
SELECT
          logs.ServiceName AS serviceName,
          count() AS bucketTotalLogs,
          countIf(logs.SeverityText IN ('ERROR', 'FATAL')) AS bucketErrorLogs,
          0 AS errorRate
        FROM logs
        WHERE logs.OrgId = 'org_sql_catalog'
          AND logs.TimestampTime >= '2026-01-01 10:30:00'
          AND logs.TimestampTime <= '2026-01-03 14:15:00'
          AND logs.Timestamp >= '2026-01-01 10:30:00'
          AND logs.Timestamp <= '2026-01-03 14:15:00'
          AND (TimestampTime < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR TimestampTime >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
        GROUP BY serviceName
UNION ALL
SELECT
          logs_aggregates_hourly.ServiceName AS serviceName,
          sum(logs_aggregates_hourly.Count) AS bucketTotalLogs,
          sumIf(logs_aggregates_hourly.Count, logs_aggregates_hourly.SeverityText IN ('ERROR', 'FATAL')) AS bucketErrorLogs,
          0 AS errorRate
        FROM logs_aggregates_hourly
        WHERE logs_aggregates_hourly.OrgId = 'org_sql_catalog'
          AND logs_aggregates_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND logs_aggregates_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY serviceName
) AS rates
        GROUP BY serviceName
        ORDER BY errorRate DESC
        FORMAT JSON

-- pipe:errors_by_type:default:baseline  [62482a6d]
SELECT
          toString(error_events_by_time.FingerprintHash) AS fingerprintHash,
          any(error_events_by_time.ErrorLabel) AS errorLabel,
          any(error_events_by_time.StatusMessage) AS sampleMessage,
          count() AS count,
          uniq(error_events_by_time.ServiceName) AS affectedServicesCount,
          arraySort(groupUniqArrayIf(3)(error_events_by_time.ServiceName, error_events_by_time.ServiceName != '')) AS serviceNames,
          min(error_events_by_time.Timestamp) AS firstSeen,
          max(error_events_by_time.Timestamp) AS lastSeen
        FROM error_events_by_time
        WHERE error_events_by_time.OrgId = 'org_sql_catalog'
          AND error_events_by_time.Timestamp >= '2026-01-01 10:30:00'
          AND error_events_by_time.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY fingerprintHash
        ORDER BY count DESC
        LIMIT 50
        FORMAT JSON

-- pipe:errors_by_type:fingerprint-scoped:baseline  [c49f93bf]
SELECT
          toString(error_events.FingerprintHash) AS fingerprintHash,
          any(error_events.ErrorLabel) AS errorLabel,
          any(error_events.StatusMessage) AS sampleMessage,
          count() AS count,
          uniq(error_events.ServiceName) AS affectedServicesCount,
          arraySort(groupUniqArrayIf(3)(error_events.ServiceName, error_events.ServiceName != '')) AS serviceNames,
          min(error_events.Timestamp) AS firstSeen,
          max(error_events.Timestamp) AS lastSeen
        FROM error_events
        WHERE error_events.OrgId = 'org_sql_catalog'
          AND error_events.Timestamp >= '2026-01-01 10:30:00'
          AND error_events.Timestamp <= '2026-01-03 14:15:00'
          AND error_events.DeploymentEnv IN ('production')
          AND error_events.FingerprintHash IN (toUInt64('11640393269246331608'))
        GROUP BY fingerprintHash
        ORDER BY count DESC
        LIMIT 1
        FORMAT JSON

-- pipe:errors_by_type:unexpected-identity:baseline  [7b200407]
SELECT
          toString(error_events_by_time.FingerprintHash) AS fingerprintHash,
          any(error_events_by_time.ErrorLabel) AS errorLabel,
          any(error_events_by_time.StatusMessage) AS sampleMessage,
          count() AS count,
          uniq(error_events_by_time.ServiceName) AS affectedServicesCount,
          arraySort(groupUniqArrayIf(3)(error_events_by_time.ServiceName, error_events_by_time.ServiceName != '')) AS serviceNames,
          min(error_events_by_time.Timestamp) AS firstSeen,
          max(error_events_by_time.Timestamp) AS lastSeen
        FROM error_events_by_time
        WHERE error_events_by_time.OrgId = 'org_sql_catalog'
          AND error_events_by_time.Timestamp >= '2026-01-01 10:30:00'
          AND error_events_by_time.Timestamp <= '2026-01-03 14:15:00'
          AND (error_events_by_time.ErrorLabel NOT LIKE '@maple/%' OR error_events_by_time.ErrorLabel IN ('HttpServerErrorResponse', '@maple/api/http/Http5xxResponseError', '@maple/http/v2/UnexpectedError', '@maple/http/v1/V1UnexpectedError'))
        GROUP BY fingerprintHash
        ORDER BY count DESC
        LIMIT 50
        FORMAT JSON

-- pipe:errors_facets:default:baseline  [6182994a]
SELECT
          error_events_by_time.ServiceName AS name,
          uniq(error_events_by_time.FingerprintHash) AS count,
          'service' AS facetType
        FROM error_events_by_time
        WHERE error_events_by_time.OrgId = 'org_sql_catalog'
          AND error_events_by_time.Timestamp >= '2026-01-01 10:30:00'
          AND error_events_by_time.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY name
        ORDER BY count DESC
        LIMIT 100
UNION ALL
SELECT
          error_events_by_time.DeploymentEnv AS name,
          uniq(error_events_by_time.FingerprintHash) AS count,
          'environment' AS facetType
        FROM error_events_by_time
        WHERE error_events_by_time.OrgId = 'org_sql_catalog'
          AND error_events_by_time.Timestamp >= '2026-01-01 10:30:00'
          AND error_events_by_time.Timestamp <= '2026-01-03 14:15:00'
          AND error_events_by_time.DeploymentEnv != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 100
UNION ALL
SELECT
          error_events_by_time.ErrorLabel AS name,
          uniq(error_events_by_time.FingerprintHash) AS count,
          'error_type' AS facetType
        FROM error_events_by_time
        WHERE error_events_by_time.OrgId = 'org_sql_catalog'
          AND error_events_by_time.Timestamp >= '2026-01-01 10:30:00'
          AND error_events_by_time.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          error_events_by_time.ServiceVersion AS name,
          uniq(error_events_by_time.FingerprintHash) AS count,
          'version' AS facetType
        FROM error_events_by_time
        WHERE error_events_by_time.OrgId = 'org_sql_catalog'
          AND error_events_by_time.Timestamp >= '2026-01-01 10:30:00'
          AND error_events_by_time.Timestamp <= '2026-01-03 14:15:00'
          AND error_events_by_time.ServiceVersion != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
FORMAT JSON

-- pipe:errors_summary:default:baseline  [ca33c746]
SELECT
          e.totalErrors AS totalErrors,
          s.totalSpans AS totalSpans,
          ifNull(ifNotFinite(round(e.totalErrors / s.totalSpans, 6), 0), 0) AS errorRate,
          e.affectedServicesCount AS affectedServicesCount,
          e.affectedTracesCount AS affectedTracesCount
        FROM (SELECT
          count() AS totalErrors,
          uniq(error_events_by_time.ServiceName) AS affectedServicesCount,
          uniq(error_events_by_time.TraceId) AS affectedTracesCount
        FROM error_events_by_time
        WHERE error_events_by_time.OrgId = 'org_sql_catalog'
          AND error_events_by_time.Timestamp >= '2026-01-01 10:30:00'
          AND error_events_by_time.Timestamp <= '2026-01-03 14:15:00') AS e
        CROSS JOIN (SELECT
          sum(usage.bucketSpans) AS totalSpans
        FROM (
SELECT
          sum(service_usage.TraceCount) AS bucketSpans
        FROM service_usage
        WHERE service_usage.OrgId = 'org_sql_catalog'
          AND service_usage.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND service_usage.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
UNION ALL
SELECT
          count() AS bucketSpans
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
) AS usage) AS s
        FORMAT JSON

-- pipe:errors_timeseries:default:baseline  [6e698308]
SELECT
          toStartOfInterval(error_events.Timestamp, INTERVAL 3600 SECOND) AS bucket,
          count() AS count
        FROM error_events
        WHERE error_events.OrgId = 'org_sql_catalog'
          AND error_events.FingerprintHash = toUInt64('11640393269246331608')
          AND error_events.Timestamp >= '2026-01-01 10:30:00'
          AND error_events.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY bucket
        ORDER BY bucket ASC
        FORMAT JSON

-- pipe:get_service_usage_compare:by-services:baseline  [791a871a]
SELECT 'current' AS period, * FROM (
SELECT
          service_usage.ServiceName AS serviceName,
          sum(service_usage.LogCount) AS totalLogCount,
          sum(service_usage.LogSizeBytes) AS totalLogSizeBytes,
          sum(service_usage.TraceCount) AS totalTraceCount,
          sum(service_usage.TraceSizeBytes) AS totalTraceSizeBytes,
          sum(service_usage.SumMetricCount) AS totalSumMetricCount,
          sum(service_usage.SumMetricSizeBytes) AS totalSumMetricSizeBytes,
          sum(service_usage.GaugeMetricCount) AS totalGaugeMetricCount,
          sum(service_usage.GaugeMetricSizeBytes) AS totalGaugeMetricSizeBytes,
          sum(service_usage.HistogramMetricCount) AS totalHistogramMetricCount,
          sum(service_usage.HistogramMetricSizeBytes) AS totalHistogramMetricSizeBytes,
          sum(service_usage.ExpHistogramMetricCount) AS totalExpHistogramMetricCount,
          sum(service_usage.ExpHistogramMetricSizeBytes) AS totalExpHistogramMetricSizeBytes,
          sum(service_usage.LogSizeBytes) + sum(service_usage.TraceSizeBytes) + sum(service_usage.SumMetricSizeBytes) + sum(service_usage.GaugeMetricSizeBytes) + sum(service_usage.HistogramMetricSizeBytes) + sum(service_usage.ExpHistogramMetricSizeBytes) AS totalSizeBytes
        FROM service_usage
        WHERE service_usage.OrgId = 'org_sql_catalog'
          AND service_usage.Hour >= toStartOfHour(toDateTime('2026-01-01 10:30:00'))
          AND service_usage.Hour <= toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND service_usage.ServiceName IN ('api', 'checkout')
        GROUP BY serviceName
        ORDER BY totalSizeBytes DESC
)
UNION ALL
SELECT 'previous' AS period, * FROM (
SELECT
          service_usage.ServiceName AS serviceName,
          sum(service_usage.LogCount) AS totalLogCount,
          sum(service_usage.LogSizeBytes) AS totalLogSizeBytes,
          sum(service_usage.TraceCount) AS totalTraceCount,
          sum(service_usage.TraceSizeBytes) AS totalTraceSizeBytes,
          sum(service_usage.SumMetricCount) AS totalSumMetricCount,
          sum(service_usage.SumMetricSizeBytes) AS totalSumMetricSizeBytes,
          sum(service_usage.GaugeMetricCount) AS totalGaugeMetricCount,
          sum(service_usage.GaugeMetricSizeBytes) AS totalGaugeMetricSizeBytes,
          sum(service_usage.HistogramMetricCount) AS totalHistogramMetricCount,
          sum(service_usage.HistogramMetricSizeBytes) AS totalHistogramMetricSizeBytes,
          sum(service_usage.ExpHistogramMetricCount) AS totalExpHistogramMetricCount,
          sum(service_usage.ExpHistogramMetricSizeBytes) AS totalExpHistogramMetricSizeBytes,
          sum(service_usage.LogSizeBytes) + sum(service_usage.TraceSizeBytes) + sum(service_usage.SumMetricSizeBytes) + sum(service_usage.GaugeMetricSizeBytes) + sum(service_usage.HistogramMetricSizeBytes) + sum(service_usage.ExpHistogramMetricSizeBytes) AS totalSizeBytes
        FROM service_usage
        WHERE service_usage.OrgId = 'org_sql_catalog'
          AND service_usage.Hour >= toStartOfHour(toDateTime('2025-12-30 10:30:00'))
          AND service_usage.Hour <= toStartOfHour(toDateTime('2026-01-01 14:15:00'))
          AND service_usage.ServiceName IN ('api', 'checkout')
        GROUP BY serviceName
        ORDER BY totalSizeBytes DESC
)
FORMAT JSON

-- pipe:get_service_usage_compare:default:baseline  [2cf735de]
SELECT 'current' AS period, * FROM (
SELECT
          service_usage.ServiceName AS serviceName,
          sum(service_usage.LogCount) AS totalLogCount,
          sum(service_usage.LogSizeBytes) AS totalLogSizeBytes,
          sum(service_usage.TraceCount) AS totalTraceCount,
          sum(service_usage.TraceSizeBytes) AS totalTraceSizeBytes,
          sum(service_usage.SumMetricCount) AS totalSumMetricCount,
          sum(service_usage.SumMetricSizeBytes) AS totalSumMetricSizeBytes,
          sum(service_usage.GaugeMetricCount) AS totalGaugeMetricCount,
          sum(service_usage.GaugeMetricSizeBytes) AS totalGaugeMetricSizeBytes,
          sum(service_usage.HistogramMetricCount) AS totalHistogramMetricCount,
          sum(service_usage.HistogramMetricSizeBytes) AS totalHistogramMetricSizeBytes,
          sum(service_usage.ExpHistogramMetricCount) AS totalExpHistogramMetricCount,
          sum(service_usage.ExpHistogramMetricSizeBytes) AS totalExpHistogramMetricSizeBytes,
          sum(service_usage.LogSizeBytes) + sum(service_usage.TraceSizeBytes) + sum(service_usage.SumMetricSizeBytes) + sum(service_usage.GaugeMetricSizeBytes) + sum(service_usage.HistogramMetricSizeBytes) + sum(service_usage.ExpHistogramMetricSizeBytes) AS totalSizeBytes
        FROM service_usage
        WHERE service_usage.OrgId = 'org_sql_catalog'
          AND service_usage.Hour >= toStartOfHour(toDateTime('2026-01-01 10:30:00'))
          AND service_usage.Hour <= toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND service_usage.ServiceName = 'api'
        GROUP BY serviceName
        ORDER BY totalSizeBytes DESC
)
UNION ALL
SELECT 'previous' AS period, * FROM (
SELECT
          service_usage.ServiceName AS serviceName,
          sum(service_usage.LogCount) AS totalLogCount,
          sum(service_usage.LogSizeBytes) AS totalLogSizeBytes,
          sum(service_usage.TraceCount) AS totalTraceCount,
          sum(service_usage.TraceSizeBytes) AS totalTraceSizeBytes,
          sum(service_usage.SumMetricCount) AS totalSumMetricCount,
          sum(service_usage.SumMetricSizeBytes) AS totalSumMetricSizeBytes,
          sum(service_usage.GaugeMetricCount) AS totalGaugeMetricCount,
          sum(service_usage.GaugeMetricSizeBytes) AS totalGaugeMetricSizeBytes,
          sum(service_usage.HistogramMetricCount) AS totalHistogramMetricCount,
          sum(service_usage.HistogramMetricSizeBytes) AS totalHistogramMetricSizeBytes,
          sum(service_usage.ExpHistogramMetricCount) AS totalExpHistogramMetricCount,
          sum(service_usage.ExpHistogramMetricSizeBytes) AS totalExpHistogramMetricSizeBytes,
          sum(service_usage.LogSizeBytes) + sum(service_usage.TraceSizeBytes) + sum(service_usage.SumMetricSizeBytes) + sum(service_usage.GaugeMetricSizeBytes) + sum(service_usage.HistogramMetricSizeBytes) + sum(service_usage.ExpHistogramMetricSizeBytes) AS totalSizeBytes
        FROM service_usage
        WHERE service_usage.OrgId = 'org_sql_catalog'
          AND service_usage.Hour >= toStartOfHour(toDateTime('2025-12-30 10:30:00'))
          AND service_usage.Hour <= toStartOfHour(toDateTime('2026-01-01 14:15:00'))
          AND service_usage.ServiceName = 'api'
        GROUP BY serviceName
        ORDER BY totalSizeBytes DESC
)
FORMAT JSON

-- pipe:get_service_usage:by-services:baseline  [feee94a2]
SELECT
          service_usage.ServiceName AS serviceName,
          sum(service_usage.LogCount) AS totalLogCount,
          sum(service_usage.LogSizeBytes) AS totalLogSizeBytes,
          sum(service_usage.TraceCount) AS totalTraceCount,
          sum(service_usage.TraceSizeBytes) AS totalTraceSizeBytes,
          sum(service_usage.SumMetricCount) AS totalSumMetricCount,
          sum(service_usage.SumMetricSizeBytes) AS totalSumMetricSizeBytes,
          sum(service_usage.GaugeMetricCount) AS totalGaugeMetricCount,
          sum(service_usage.GaugeMetricSizeBytes) AS totalGaugeMetricSizeBytes,
          sum(service_usage.HistogramMetricCount) AS totalHistogramMetricCount,
          sum(service_usage.HistogramMetricSizeBytes) AS totalHistogramMetricSizeBytes,
          sum(service_usage.ExpHistogramMetricCount) AS totalExpHistogramMetricCount,
          sum(service_usage.ExpHistogramMetricSizeBytes) AS totalExpHistogramMetricSizeBytes,
          sum(service_usage.LogSizeBytes) + sum(service_usage.TraceSizeBytes) + sum(service_usage.SumMetricSizeBytes) + sum(service_usage.GaugeMetricSizeBytes) + sum(service_usage.HistogramMetricSizeBytes) + sum(service_usage.ExpHistogramMetricSizeBytes) AS totalSizeBytes
        FROM service_usage
        WHERE service_usage.OrgId = 'org_sql_catalog'
          AND service_usage.Hour >= toStartOfHour(toDateTime('2026-01-01 10:30:00'))
          AND service_usage.Hour <= toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND service_usage.ServiceName IN ('api', 'checkout')
        GROUP BY serviceName
        ORDER BY totalSizeBytes DESC
        FORMAT JSON

-- pipe:get_service_usage:default:baseline  [8b0026c6]
SELECT
          service_usage.ServiceName AS serviceName,
          sum(service_usage.LogCount) AS totalLogCount,
          sum(service_usage.LogSizeBytes) AS totalLogSizeBytes,
          sum(service_usage.TraceCount) AS totalTraceCount,
          sum(service_usage.TraceSizeBytes) AS totalTraceSizeBytes,
          sum(service_usage.SumMetricCount) AS totalSumMetricCount,
          sum(service_usage.SumMetricSizeBytes) AS totalSumMetricSizeBytes,
          sum(service_usage.GaugeMetricCount) AS totalGaugeMetricCount,
          sum(service_usage.GaugeMetricSizeBytes) AS totalGaugeMetricSizeBytes,
          sum(service_usage.HistogramMetricCount) AS totalHistogramMetricCount,
          sum(service_usage.HistogramMetricSizeBytes) AS totalHistogramMetricSizeBytes,
          sum(service_usage.ExpHistogramMetricCount) AS totalExpHistogramMetricCount,
          sum(service_usage.ExpHistogramMetricSizeBytes) AS totalExpHistogramMetricSizeBytes,
          sum(service_usage.LogSizeBytes) + sum(service_usage.TraceSizeBytes) + sum(service_usage.SumMetricSizeBytes) + sum(service_usage.GaugeMetricSizeBytes) + sum(service_usage.HistogramMetricSizeBytes) + sum(service_usage.ExpHistogramMetricSizeBytes) AS totalSizeBytes
        FROM service_usage
        WHERE service_usage.OrgId = 'org_sql_catalog'
          AND service_usage.Hour >= toStartOfHour(toDateTime('2026-01-01 10:30:00'))
          AND service_usage.Hour <= toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND service_usage.ServiceName = 'api'
        GROUP BY serviceName
        ORDER BY totalSizeBytes DESC
        FORMAT JSON

-- pipe:list_logs:default:baseline  [3e0dd5a5]
SELECT
          logs.Timestamp AS timestamp,
          logs.SeverityText AS severityText,
          logs.SeverityNumber AS severityNumber,
          logs.ServiceName AS serviceName,
          logs.Body AS body,
          logs.TraceId AS traceId,
          logs.SpanId AS spanId,
          hex(MD5(toJSONString(tuple(logs.Timestamp, logs.TraceId, logs.SpanId, logs.TraceFlags, logs.SeverityText, logs.SeverityNumber, logs.ServiceName, logs.Body, logs.ResourceSchemaUrl, logs.ResourceAttributes, logs.ScopeSchemaUrl, logs.ScopeName, logs.ScopeVersion, logs.ScopeAttributes, logs.LogAttributes)))) AS recordIdentity,
          toJSONString(logs.LogAttributes) AS logAttributes,
          toJSONString(logs.ResourceAttributes) AS resourceAttributes
        FROM logs
        WHERE logs.OrgId = 'org_sql_catalog'
          AND logs.TimestampTime >= '2026-01-01 10:30:00'
          AND logs.TimestampTime <= '2026-01-03 14:15:00'
          AND logs.Timestamp >= '2026-01-01 10:30:00'
          AND logs.Timestamp <= '2026-01-03 14:15:00'
          AND logs.Timestamp >= (SELECT min(ts) FROM (SELECT
          logs.Timestamp AS ts
        FROM logs
        WHERE logs.OrgId = 'org_sql_catalog'
          AND logs.TimestampTime >= '2026-01-01 10:30:00'
          AND logs.TimestampTime <= '2026-01-03 14:15:00'
          AND logs.Timestamp >= '2026-01-01 10:30:00'
          AND logs.Timestamp <= '2026-01-03 14:15:00'
        ORDER BY ts DESC
        LIMIT 50))
        ORDER BY timestamp DESC, serviceName ASC, traceId ASC, spanId ASC, recordIdentity ASC
        LIMIT 50
        FORMAT JSON

-- pipe:list_logs:default:bloom  [3e0dd5a5]
SELECT
          logs.Timestamp AS timestamp,
          logs.SeverityText AS severityText,
          logs.SeverityNumber AS severityNumber,
          logs.ServiceName AS serviceName,
          logs.Body AS body,
          logs.TraceId AS traceId,
          logs.SpanId AS spanId,
          hex(MD5(toJSONString(tuple(logs.Timestamp, logs.TraceId, logs.SpanId, logs.TraceFlags, logs.SeverityText, logs.SeverityNumber, logs.ServiceName, logs.Body, logs.ResourceSchemaUrl, logs.ResourceAttributes, logs.ScopeSchemaUrl, logs.ScopeName, logs.ScopeVersion, logs.ScopeAttributes, logs.LogAttributes)))) AS recordIdentity,
          toJSONString(logs.LogAttributes) AS logAttributes,
          toJSONString(logs.ResourceAttributes) AS resourceAttributes
        FROM logs
        WHERE logs.OrgId = 'org_sql_catalog'
          AND logs.TimestampTime >= '2026-01-01 10:30:00'
          AND logs.TimestampTime <= '2026-01-03 14:15:00'
          AND logs.Timestamp >= '2026-01-01 10:30:00'
          AND logs.Timestamp <= '2026-01-03 14:15:00'
          AND logs.Timestamp >= (SELECT min(ts) FROM (SELECT
          logs.Timestamp AS ts
        FROM logs
        WHERE logs.OrgId = 'org_sql_catalog'
          AND logs.TimestampTime >= '2026-01-01 10:30:00'
          AND logs.TimestampTime <= '2026-01-03 14:15:00'
          AND logs.Timestamp >= '2026-01-01 10:30:00'
          AND logs.Timestamp <= '2026-01-03 14:15:00'
        ORDER BY ts DESC
        LIMIT 50))
        ORDER BY timestamp DESC, serviceName ASC, traceId ASC, spanId ASC, recordIdentity ASC
        LIMIT 50
        FORMAT JSON

-- pipe:list_logs:default:text  [3e0dd5a5]
SELECT
          logs.Timestamp AS timestamp,
          logs.SeverityText AS severityText,
          logs.SeverityNumber AS severityNumber,
          logs.ServiceName AS serviceName,
          logs.Body AS body,
          logs.TraceId AS traceId,
          logs.SpanId AS spanId,
          hex(MD5(toJSONString(tuple(logs.Timestamp, logs.TraceId, logs.SpanId, logs.TraceFlags, logs.SeverityText, logs.SeverityNumber, logs.ServiceName, logs.Body, logs.ResourceSchemaUrl, logs.ResourceAttributes, logs.ScopeSchemaUrl, logs.ScopeName, logs.ScopeVersion, logs.ScopeAttributes, logs.LogAttributes)))) AS recordIdentity,
          toJSONString(logs.LogAttributes) AS logAttributes,
          toJSONString(logs.ResourceAttributes) AS resourceAttributes
        FROM logs
        WHERE logs.OrgId = 'org_sql_catalog'
          AND logs.TimestampTime >= '2026-01-01 10:30:00'
          AND logs.TimestampTime <= '2026-01-03 14:15:00'
          AND logs.Timestamp >= '2026-01-01 10:30:00'
          AND logs.Timestamp <= '2026-01-03 14:15:00'
          AND logs.Timestamp >= (SELECT min(ts) FROM (SELECT
          logs.Timestamp AS ts
        FROM logs
        WHERE logs.OrgId = 'org_sql_catalog'
          AND logs.TimestampTime >= '2026-01-01 10:30:00'
          AND logs.TimestampTime <= '2026-01-03 14:15:00'
          AND logs.Timestamp >= '2026-01-01 10:30:00'
          AND logs.Timestamp <= '2026-01-03 14:15:00'
        ORDER BY ts DESC
        LIMIT 50))
        ORDER BY timestamp DESC, serviceName ASC, traceId ASC, spanId ASC, recordIdentity ASC
        LIMIT 50
        FORMAT JSON

-- pipe:list_logs:searched:baseline  [12ccde13]
SELECT
          logs.Timestamp AS timestamp,
          logs.SeverityText AS severityText,
          logs.SeverityNumber AS severityNumber,
          logs.ServiceName AS serviceName,
          logs.Body AS body,
          logs.TraceId AS traceId,
          logs.SpanId AS spanId,
          hex(MD5(toJSONString(tuple(logs.Timestamp, logs.TraceId, logs.SpanId, logs.TraceFlags, logs.SeverityText, logs.SeverityNumber, logs.ServiceName, logs.Body, logs.ResourceSchemaUrl, logs.ResourceAttributes, logs.ScopeSchemaUrl, logs.ScopeName, logs.ScopeVersion, logs.ScopeAttributes, logs.LogAttributes)))) AS recordIdentity,
          toJSONString(logs.LogAttributes) AS logAttributes,
          toJSONString(logs.ResourceAttributes) AS resourceAttributes
        FROM logs
        WHERE logs.OrgId = 'org_sql_catalog'
          AND logs.TimestampTime >= '2026-01-01 10:30:00'
          AND logs.TimestampTime <= '2026-01-03 14:15:00'
          AND logs.Timestamp >= '2026-01-01 10:30:00'
          AND logs.Timestamp <= '2026-01-03 14:15:00'
          AND logs.ServiceName = 'api'
          AND logs.SeverityText IN ('ERROR', 'Error', 'error')
          AND logs.TraceId = '0af7651916cd43dd8448eb211c80319c'
          AND logs.Body ILIKE '%upstream connection refused by peer%'
          AND logs.Timestamp >= (SELECT min(ts) FROM (SELECT
          logs.Timestamp AS ts
        FROM logs
        WHERE logs.OrgId = 'org_sql_catalog'
          AND logs.TimestampTime >= '2026-01-01 10:30:00'
          AND logs.TimestampTime <= '2026-01-03 14:15:00'
          AND logs.Timestamp >= '2026-01-01 10:30:00'
          AND logs.Timestamp <= '2026-01-03 14:15:00'
          AND logs.ServiceName = 'api'
          AND logs.SeverityText IN ('ERROR', 'Error', 'error')
          AND logs.TraceId = '0af7651916cd43dd8448eb211c80319c'
          AND logs.Body ILIKE '%upstream connection refused by peer%'
        ORDER BY ts DESC
        LIMIT 50))
        ORDER BY timestamp DESC, serviceName ASC, traceId ASC, spanId ASC, recordIdentity ASC
        LIMIT 50
        FORMAT JSON

-- pipe:list_logs:searched:bloom  [ca3b875f]
SELECT
          logs.Timestamp AS timestamp,
          logs.SeverityText AS severityText,
          logs.SeverityNumber AS severityNumber,
          logs.ServiceName AS serviceName,
          logs.Body AS body,
          logs.TraceId AS traceId,
          logs.SpanId AS spanId,
          hex(MD5(toJSONString(tuple(logs.Timestamp, logs.TraceId, logs.SpanId, logs.TraceFlags, logs.SeverityText, logs.SeverityNumber, logs.ServiceName, logs.Body, logs.ResourceSchemaUrl, logs.ResourceAttributes, logs.ScopeSchemaUrl, logs.ScopeName, logs.ScopeVersion, logs.ScopeAttributes, logs.LogAttributes)))) AS recordIdentity,
          toJSONString(logs.LogAttributes) AS logAttributes,
          toJSONString(logs.ResourceAttributes) AS resourceAttributes
        FROM logs
        WHERE logs.OrgId = 'org_sql_catalog'
          AND logs.TimestampTime >= '2026-01-01 10:30:00'
          AND logs.TimestampTime <= '2026-01-03 14:15:00'
          AND logs.Timestamp >= '2026-01-01 10:30:00'
          AND logs.Timestamp <= '2026-01-03 14:15:00'
          AND logs.ServiceName = 'api'
          AND logs.SeverityText IN ('ERROR', 'Error', 'error')
          AND logs.TraceId = '0af7651916cd43dd8448eb211c80319c'
          AND (((hasToken(lower(logs.Body), 'connection') AND hasToken(lower(logs.Body), 'refused')) AND hasToken(lower(logs.Body), 'by')) AND logs.Body ILIKE '%upstream connection refused by peer%')
          AND logs.Timestamp >= (SELECT min(ts) FROM (SELECT
          logs.Timestamp AS ts
        FROM logs
        WHERE logs.OrgId = 'org_sql_catalog'
          AND logs.TimestampTime >= '2026-01-01 10:30:00'
          AND logs.TimestampTime <= '2026-01-03 14:15:00'
          AND logs.Timestamp >= '2026-01-01 10:30:00'
          AND logs.Timestamp <= '2026-01-03 14:15:00'
          AND logs.ServiceName = 'api'
          AND logs.SeverityText IN ('ERROR', 'Error', 'error')
          AND logs.TraceId = '0af7651916cd43dd8448eb211c80319c'
          AND (((hasToken(lower(logs.Body), 'connection') AND hasToken(lower(logs.Body), 'refused')) AND hasToken(lower(logs.Body), 'by')) AND logs.Body ILIKE '%upstream connection refused by peer%')
        ORDER BY ts DESC
        LIMIT 50))
        ORDER BY timestamp DESC, serviceName ASC, traceId ASC, spanId ASC, recordIdentity ASC
        LIMIT 50
        FORMAT JSON

-- pipe:list_logs:searched:text  [7ac1f4bb]
SELECT
          logs.Timestamp AS timestamp,
          logs.SeverityText AS severityText,
          logs.SeverityNumber AS severityNumber,
          logs.ServiceName AS serviceName,
          logs.Body AS body,
          logs.TraceId AS traceId,
          logs.SpanId AS spanId,
          hex(MD5(toJSONString(tuple(logs.Timestamp, logs.TraceId, logs.SpanId, logs.TraceFlags, logs.SeverityText, logs.SeverityNumber, logs.ServiceName, logs.Body, logs.ResourceSchemaUrl, logs.ResourceAttributes, logs.ScopeSchemaUrl, logs.ScopeName, logs.ScopeVersion, logs.ScopeAttributes, logs.LogAttributes)))) AS recordIdentity,
          toJSONString(logs.LogAttributes) AS logAttributes,
          toJSONString(logs.ResourceAttributes) AS resourceAttributes
        FROM logs
        WHERE logs.OrgId = 'org_sql_catalog'
          AND logs.TimestampTime >= '2026-01-01 10:30:00'
          AND logs.TimestampTime <= '2026-01-03 14:15:00'
          AND logs.Timestamp >= '2026-01-01 10:30:00'
          AND logs.Timestamp <= '2026-01-03 14:15:00'
          AND logs.ServiceName = 'api'
          AND logs.SeverityText IN ('ERROR', 'Error', 'error')
          AND logs.TraceId = '0af7651916cd43dd8448eb211c80319c'
          AND (hasAllTokens(lower(logs.Body), 'connection refused by') AND logs.Body ILIKE '%upstream connection refused by peer%')
          AND logs.Timestamp >= (SELECT min(ts) FROM (SELECT
          logs.Timestamp AS ts
        FROM logs
        WHERE logs.OrgId = 'org_sql_catalog'
          AND logs.TimestampTime >= '2026-01-01 10:30:00'
          AND logs.TimestampTime <= '2026-01-03 14:15:00'
          AND logs.Timestamp >= '2026-01-01 10:30:00'
          AND logs.Timestamp <= '2026-01-03 14:15:00'
          AND logs.ServiceName = 'api'
          AND logs.SeverityText IN ('ERROR', 'Error', 'error')
          AND logs.TraceId = '0af7651916cd43dd8448eb211c80319c'
          AND (hasAllTokens(lower(logs.Body), 'connection refused by') AND logs.Body ILIKE '%upstream connection refused by peer%')
        ORDER BY ts DESC
        LIMIT 50))
        ORDER BY timestamp DESC, serviceName ASC, traceId ASC, spanId ASC, recordIdentity ASC
        LIMIT 50
        FORMAT JSON

-- pipe:list_metrics:default:baseline  [5f2ca142]
SELECT
          metric_catalog.MetricName AS metricName,
          metric_catalog.MetricType AS metricType,
          metric_catalog.ServiceName AS serviceName,
          any(metric_catalog.MetricDescription) AS metricDescription,
          any(metric_catalog.MetricUnit) AS metricUnit,
          sum(metric_catalog.DataPointCount) AS dataPointCount,
          min(metric_catalog.FirstSeen) AS firstSeen,
          max(metric_catalog.LastSeen) AS lastSeen,
          any(metric_catalog.IsMonotonic) AS isMonotonic
        FROM metric_catalog
        WHERE metric_catalog.OrgId = 'org_sql_catalog'
          AND metric_catalog.Hour >= toStartOfInterval(toDateTime('2026-01-01 10:30:00'), INTERVAL 3600 SECOND)
          AND metric_catalog.Hour <= '2026-01-03 14:15:00'
        GROUP BY metricName, metricType, serviceName
        ORDER BY lastSeen DESC, metricName ASC, metricType ASC, serviceName ASC
        LIMIT 100
        OFFSET 0
        FORMAT JSON

-- pipe:list_traces:contains-match:baseline  [d9eea35a]
SELECT
          traces.TraceId AS traceId,
          traces.Timestamp AS startTime,
          traces.Timestamp AS endTime,
          intDiv(traces.Duration, 1000) AS durationMicros,
          toUInt64(1) AS spanCount,
          [traces.ServiceName] AS services,
          traces.SpanId AS rootSpanId,
          traces.SpanName AS rootSpanName,
          traces.SpanKind AS rootSpanKind,
          traces.StatusCode AS rootSpanStatusCode,
          traces.StatusMessage AS rootSpanStatusMessage,
          if(traces.SpanAttributes['http.method'] != '', traces.SpanAttributes['http.method'], traces.SpanAttributes['http.request.method']) AS rootHttpMethod,
          traces.SpanAttributes['http.route'] AS rootHttpRoute,
          if(traces.SpanAttributes['http.status_code'] != '', traces.SpanAttributes['http.status_code'], traces.SpanAttributes['http.response.status_code']) AS rootHttpStatusCode,
          toJSONString(map('http.method', SpanAttributes['http.method'], 'http.request.method', SpanAttributes['http.request.method'], 'http.route', SpanAttributes['http.route'], 'http.target', SpanAttributes['http.target'], 'http.status_code', SpanAttributes['http.status_code'], 'http.response.status_code', SpanAttributes['http.response.status_code'], 'http.url', SpanAttributes['http.url'], 'url.full', SpanAttributes['url.full'], 'url.path', SpanAttributes['url.path'], 'server.address', SpanAttributes['server.address'], 'net.peer.name', SpanAttributes['net.peer.name'], 'screen.name', SpanAttributes['screen.name'])) AS rootSpanAttributes,
          if(traces.StatusCode = 'Error', 1, 0) AS hasError
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(traces.ServiceName, 'ap') > 0
          AND (traces.SpanKind IN ('Server', 'Consumer') OR traces.ParentSpanId = '')
          AND traces.Timestamp >= (SELECT min(ts) FROM (SELECT
          traces.Timestamp AS ts
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(traces.ServiceName, 'ap') > 0
          AND (traces.SpanKind IN ('Server', 'Consumer') OR traces.ParentSpanId = '')
        ORDER BY ts DESC
        LIMIT 100))
        ORDER BY startTime DESC
        LIMIT 100
        FORMAT JSON

-- pipe:list_traces:contains-match:bloom  [d9eea35a]
SELECT
          traces.TraceId AS traceId,
          traces.Timestamp AS startTime,
          traces.Timestamp AS endTime,
          intDiv(traces.Duration, 1000) AS durationMicros,
          toUInt64(1) AS spanCount,
          [traces.ServiceName] AS services,
          traces.SpanId AS rootSpanId,
          traces.SpanName AS rootSpanName,
          traces.SpanKind AS rootSpanKind,
          traces.StatusCode AS rootSpanStatusCode,
          traces.StatusMessage AS rootSpanStatusMessage,
          if(traces.SpanAttributes['http.method'] != '', traces.SpanAttributes['http.method'], traces.SpanAttributes['http.request.method']) AS rootHttpMethod,
          traces.SpanAttributes['http.route'] AS rootHttpRoute,
          if(traces.SpanAttributes['http.status_code'] != '', traces.SpanAttributes['http.status_code'], traces.SpanAttributes['http.response.status_code']) AS rootHttpStatusCode,
          toJSONString(map('http.method', SpanAttributes['http.method'], 'http.request.method', SpanAttributes['http.request.method'], 'http.route', SpanAttributes['http.route'], 'http.target', SpanAttributes['http.target'], 'http.status_code', SpanAttributes['http.status_code'], 'http.response.status_code', SpanAttributes['http.response.status_code'], 'http.url', SpanAttributes['http.url'], 'url.full', SpanAttributes['url.full'], 'url.path', SpanAttributes['url.path'], 'server.address', SpanAttributes['server.address'], 'net.peer.name', SpanAttributes['net.peer.name'], 'screen.name', SpanAttributes['screen.name'])) AS rootSpanAttributes,
          if(traces.StatusCode = 'Error', 1, 0) AS hasError
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(traces.ServiceName, 'ap') > 0
          AND (traces.SpanKind IN ('Server', 'Consumer') OR traces.ParentSpanId = '')
          AND traces.Timestamp >= (SELECT min(ts) FROM (SELECT
          traces.Timestamp AS ts
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(traces.ServiceName, 'ap') > 0
          AND (traces.SpanKind IN ('Server', 'Consumer') OR traces.ParentSpanId = '')
        ORDER BY ts DESC
        LIMIT 100))
        ORDER BY startTime DESC
        LIMIT 100
        FORMAT JSON

-- pipe:list_traces:contains-match:text  [d9eea35a]
SELECT
          traces.TraceId AS traceId,
          traces.Timestamp AS startTime,
          traces.Timestamp AS endTime,
          intDiv(traces.Duration, 1000) AS durationMicros,
          toUInt64(1) AS spanCount,
          [traces.ServiceName] AS services,
          traces.SpanId AS rootSpanId,
          traces.SpanName AS rootSpanName,
          traces.SpanKind AS rootSpanKind,
          traces.StatusCode AS rootSpanStatusCode,
          traces.StatusMessage AS rootSpanStatusMessage,
          if(traces.SpanAttributes['http.method'] != '', traces.SpanAttributes['http.method'], traces.SpanAttributes['http.request.method']) AS rootHttpMethod,
          traces.SpanAttributes['http.route'] AS rootHttpRoute,
          if(traces.SpanAttributes['http.status_code'] != '', traces.SpanAttributes['http.status_code'], traces.SpanAttributes['http.response.status_code']) AS rootHttpStatusCode,
          toJSONString(map('http.method', SpanAttributes['http.method'], 'http.request.method', SpanAttributes['http.request.method'], 'http.route', SpanAttributes['http.route'], 'http.target', SpanAttributes['http.target'], 'http.status_code', SpanAttributes['http.status_code'], 'http.response.status_code', SpanAttributes['http.response.status_code'], 'http.url', SpanAttributes['http.url'], 'url.full', SpanAttributes['url.full'], 'url.path', SpanAttributes['url.path'], 'server.address', SpanAttributes['server.address'], 'net.peer.name', SpanAttributes['net.peer.name'], 'screen.name', SpanAttributes['screen.name'])) AS rootSpanAttributes,
          if(traces.StatusCode = 'Error', 1, 0) AS hasError
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(traces.ServiceName, 'ap') > 0
          AND (traces.SpanKind IN ('Server', 'Consumer') OR traces.ParentSpanId = '')
          AND traces.Timestamp >= (SELECT min(ts) FROM (SELECT
          traces.Timestamp AS ts
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(traces.ServiceName, 'ap') > 0
          AND (traces.SpanKind IN ('Server', 'Consumer') OR traces.ParentSpanId = '')
        ORDER BY ts DESC
        LIMIT 100))
        ORDER BY startTime DESC
        LIMIT 100
        FORMAT JSON

-- pipe:list_traces:default:baseline  [96e8b328]
SELECT
          traces.TraceId AS traceId,
          traces.Timestamp AS startTime,
          traces.Timestamp AS endTime,
          intDiv(traces.Duration, 1000) AS durationMicros,
          toUInt64(1) AS spanCount,
          [traces.ServiceName] AS services,
          traces.SpanId AS rootSpanId,
          traces.SpanName AS rootSpanName,
          traces.SpanKind AS rootSpanKind,
          traces.StatusCode AS rootSpanStatusCode,
          traces.StatusMessage AS rootSpanStatusMessage,
          if(traces.SpanAttributes['http.method'] != '', traces.SpanAttributes['http.method'], traces.SpanAttributes['http.request.method']) AS rootHttpMethod,
          traces.SpanAttributes['http.route'] AS rootHttpRoute,
          if(traces.SpanAttributes['http.status_code'] != '', traces.SpanAttributes['http.status_code'], traces.SpanAttributes['http.response.status_code']) AS rootHttpStatusCode,
          toJSONString(map('http.method', SpanAttributes['http.method'], 'http.request.method', SpanAttributes['http.request.method'], 'http.route', SpanAttributes['http.route'], 'http.target', SpanAttributes['http.target'], 'http.status_code', SpanAttributes['http.status_code'], 'http.response.status_code', SpanAttributes['http.response.status_code'], 'http.url', SpanAttributes['http.url'], 'url.full', SpanAttributes['url.full'], 'url.path', SpanAttributes['url.path'], 'server.address', SpanAttributes['server.address'], 'net.peer.name', SpanAttributes['net.peer.name'], 'screen.name', SpanAttributes['screen.name'])) AS rootSpanAttributes,
          if(traces.StatusCode = 'Error', 1, 0) AS hasError
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND (traces.SpanKind IN ('Server', 'Consumer') OR traces.ParentSpanId = '')
          AND traces.Timestamp >= (SELECT min(ts) FROM (SELECT
          traces.Timestamp AS ts
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND (traces.SpanKind IN ('Server', 'Consumer') OR traces.ParentSpanId = '')
        ORDER BY ts DESC
        LIMIT 100))
        ORDER BY startTime DESC
        LIMIT 100
        FORMAT JSON

-- pipe:list_traces:default:bloom  [96e8b328]
SELECT
          traces.TraceId AS traceId,
          traces.Timestamp AS startTime,
          traces.Timestamp AS endTime,
          intDiv(traces.Duration, 1000) AS durationMicros,
          toUInt64(1) AS spanCount,
          [traces.ServiceName] AS services,
          traces.SpanId AS rootSpanId,
          traces.SpanName AS rootSpanName,
          traces.SpanKind AS rootSpanKind,
          traces.StatusCode AS rootSpanStatusCode,
          traces.StatusMessage AS rootSpanStatusMessage,
          if(traces.SpanAttributes['http.method'] != '', traces.SpanAttributes['http.method'], traces.SpanAttributes['http.request.method']) AS rootHttpMethod,
          traces.SpanAttributes['http.route'] AS rootHttpRoute,
          if(traces.SpanAttributes['http.status_code'] != '', traces.SpanAttributes['http.status_code'], traces.SpanAttributes['http.response.status_code']) AS rootHttpStatusCode,
          toJSONString(map('http.method', SpanAttributes['http.method'], 'http.request.method', SpanAttributes['http.request.method'], 'http.route', SpanAttributes['http.route'], 'http.target', SpanAttributes['http.target'], 'http.status_code', SpanAttributes['http.status_code'], 'http.response.status_code', SpanAttributes['http.response.status_code'], 'http.url', SpanAttributes['http.url'], 'url.full', SpanAttributes['url.full'], 'url.path', SpanAttributes['url.path'], 'server.address', SpanAttributes['server.address'], 'net.peer.name', SpanAttributes['net.peer.name'], 'screen.name', SpanAttributes['screen.name'])) AS rootSpanAttributes,
          if(traces.StatusCode = 'Error', 1, 0) AS hasError
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND (traces.SpanKind IN ('Server', 'Consumer') OR traces.ParentSpanId = '')
          AND traces.Timestamp >= (SELECT min(ts) FROM (SELECT
          traces.Timestamp AS ts
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND (traces.SpanKind IN ('Server', 'Consumer') OR traces.ParentSpanId = '')
        ORDER BY ts DESC
        LIMIT 100))
        ORDER BY startTime DESC
        LIMIT 100
        FORMAT JSON

-- pipe:list_traces:default:text  [96e8b328]
SELECT
          traces.TraceId AS traceId,
          traces.Timestamp AS startTime,
          traces.Timestamp AS endTime,
          intDiv(traces.Duration, 1000) AS durationMicros,
          toUInt64(1) AS spanCount,
          [traces.ServiceName] AS services,
          traces.SpanId AS rootSpanId,
          traces.SpanName AS rootSpanName,
          traces.SpanKind AS rootSpanKind,
          traces.StatusCode AS rootSpanStatusCode,
          traces.StatusMessage AS rootSpanStatusMessage,
          if(traces.SpanAttributes['http.method'] != '', traces.SpanAttributes['http.method'], traces.SpanAttributes['http.request.method']) AS rootHttpMethod,
          traces.SpanAttributes['http.route'] AS rootHttpRoute,
          if(traces.SpanAttributes['http.status_code'] != '', traces.SpanAttributes['http.status_code'], traces.SpanAttributes['http.response.status_code']) AS rootHttpStatusCode,
          toJSONString(map('http.method', SpanAttributes['http.method'], 'http.request.method', SpanAttributes['http.request.method'], 'http.route', SpanAttributes['http.route'], 'http.target', SpanAttributes['http.target'], 'http.status_code', SpanAttributes['http.status_code'], 'http.response.status_code', SpanAttributes['http.response.status_code'], 'http.url', SpanAttributes['http.url'], 'url.full', SpanAttributes['url.full'], 'url.path', SpanAttributes['url.path'], 'server.address', SpanAttributes['server.address'], 'net.peer.name', SpanAttributes['net.peer.name'], 'screen.name', SpanAttributes['screen.name'])) AS rootSpanAttributes,
          if(traces.StatusCode = 'Error', 1, 0) AS hasError
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND (traces.SpanKind IN ('Server', 'Consumer') OR traces.ParentSpanId = '')
          AND traces.Timestamp >= (SELECT min(ts) FROM (SELECT
          traces.Timestamp AS ts
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND (traces.SpanKind IN ('Server', 'Consumer') OR traces.ParentSpanId = '')
        ORDER BY ts DESC
        LIMIT 100))
        ORDER BY startTime DESC
        LIMIT 100
        FORMAT JSON

-- pipe:list_traces:filtered:baseline  [f20e3a8c]
SELECT
          traces.TraceId AS traceId,
          traces.Timestamp AS startTime,
          traces.Timestamp AS endTime,
          intDiv(traces.Duration, 1000) AS durationMicros,
          toUInt64(1) AS spanCount,
          [traces.ServiceName] AS services,
          traces.SpanId AS rootSpanId,
          traces.SpanName AS rootSpanName,
          traces.SpanKind AS rootSpanKind,
          traces.StatusCode AS rootSpanStatusCode,
          traces.StatusMessage AS rootSpanStatusMessage,
          if(traces.SpanAttributes['http.method'] != '', traces.SpanAttributes['http.method'], traces.SpanAttributes['http.request.method']) AS rootHttpMethod,
          traces.SpanAttributes['http.route'] AS rootHttpRoute,
          if(traces.SpanAttributes['http.status_code'] != '', traces.SpanAttributes['http.status_code'], traces.SpanAttributes['http.response.status_code']) AS rootHttpStatusCode,
          toJSONString(map('http.method', SpanAttributes['http.method'], 'http.request.method', SpanAttributes['http.request.method'], 'http.route', SpanAttributes['http.route'], 'http.target', SpanAttributes['http.target'], 'http.status_code', SpanAttributes['http.status_code'], 'http.response.status_code', SpanAttributes['http.response.status_code'], 'http.url', SpanAttributes['http.url'], 'url.full', SpanAttributes['url.full'], 'url.path', SpanAttributes['url.path'], 'server.address', SpanAttributes['server.address'], 'net.peer.name', SpanAttributes['net.peer.name'], 'screen.name', SpanAttributes['screen.name'])) AS rootSpanAttributes,
          if(traces.StatusCode = 'Error', 1, 0) AS hasError
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND traces.ServiceName = 'api'
          AND (traces.SpanName = 'GET /v1/x' OR if(((traces.SpanName LIKE 'http.server %' OR traces.SpanName IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')) AND (traces.SpanAttributes['http.route'] != '' OR traces.SpanAttributes['url.path'] != '')), concat(if(traces.SpanName LIKE 'http.server %', replaceOne(traces.SpanName, 'http.server ', ''), traces.SpanName), ' ', if(traces.SpanAttributes['http.route'] != '', traces.SpanAttributes['http.route'], traces.SpanAttributes['url.path'])), traces.SpanName) = 'GET /v1/x')
          AND (traces.SpanKind IN ('Server', 'Consumer') OR traces.ParentSpanId = '')
          AND traces.StatusCode = 'Error'
          AND traces.Duration >= 5000000
          AND traces.Duration <= 5000000000
          AND coalesce(nullIf(traces.ResourceAttributes['deployment.environment.name'], ''), traces.ResourceAttributes['deployment.environment']) IN ('production')
          AND if(SpanAttributes['http.method'] != '', SpanAttributes['http.method'], SpanAttributes['http.request.method']) = 'GET'
          AND ResourceAttributes['service.namespace'] = 'core'
          AND traces.Timestamp >= (SELECT min(ts) FROM (SELECT
          traces.Timestamp AS ts
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND traces.ServiceName = 'api'
          AND (traces.SpanName = 'GET /v1/x' OR if(((traces.SpanName LIKE 'http.server %' OR traces.SpanName IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')) AND (traces.SpanAttributes['http.route'] != '' OR traces.SpanAttributes['url.path'] != '')), concat(if(traces.SpanName LIKE 'http.server %', replaceOne(traces.SpanName, 'http.server ', ''), traces.SpanName), ' ', if(traces.SpanAttributes['http.route'] != '', traces.SpanAttributes['http.route'], traces.SpanAttributes['url.path'])), traces.SpanName) = 'GET /v1/x')
          AND (traces.SpanKind IN ('Server', 'Consumer') OR traces.ParentSpanId = '')
          AND traces.StatusCode = 'Error'
          AND traces.Duration >= 5000000
          AND traces.Duration <= 5000000000
          AND coalesce(nullIf(traces.ResourceAttributes['deployment.environment.name'], ''), traces.ResourceAttributes['deployment.environment']) IN ('production')
          AND if(SpanAttributes['http.method'] != '', SpanAttributes['http.method'], SpanAttributes['http.request.method']) = 'GET'
          AND ResourceAttributes['service.namespace'] = 'core'
        ORDER BY ts DESC
        LIMIT 25))
        ORDER BY startTime DESC
        LIMIT 25
        FORMAT JSON

-- pipe:list_traces:filtered:bloom  [6d102b3c]
SELECT
          traces.TraceId AS traceId,
          traces.Timestamp AS startTime,
          traces.Timestamp AS endTime,
          intDiv(traces.Duration, 1000) AS durationMicros,
          toUInt64(1) AS spanCount,
          [traces.ServiceName] AS services,
          traces.SpanId AS rootSpanId,
          traces.SpanName AS rootSpanName,
          traces.SpanKind AS rootSpanKind,
          traces.StatusCode AS rootSpanStatusCode,
          traces.StatusMessage AS rootSpanStatusMessage,
          if(traces.SpanAttributes['http.method'] != '', traces.SpanAttributes['http.method'], traces.SpanAttributes['http.request.method']) AS rootHttpMethod,
          traces.SpanAttributes['http.route'] AS rootHttpRoute,
          if(traces.SpanAttributes['http.status_code'] != '', traces.SpanAttributes['http.status_code'], traces.SpanAttributes['http.response.status_code']) AS rootHttpStatusCode,
          toJSONString(map('http.method', SpanAttributes['http.method'], 'http.request.method', SpanAttributes['http.request.method'], 'http.route', SpanAttributes['http.route'], 'http.target', SpanAttributes['http.target'], 'http.status_code', SpanAttributes['http.status_code'], 'http.response.status_code', SpanAttributes['http.response.status_code'], 'http.url', SpanAttributes['http.url'], 'url.full', SpanAttributes['url.full'], 'url.path', SpanAttributes['url.path'], 'server.address', SpanAttributes['server.address'], 'net.peer.name', SpanAttributes['net.peer.name'], 'screen.name', SpanAttributes['screen.name'])) AS rootSpanAttributes,
          if(traces.StatusCode = 'Error', 1, 0) AS hasError
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND traces.ServiceName = 'api'
          AND (traces.SpanName = 'GET /v1/x' OR if(((traces.SpanName LIKE 'http.server %' OR traces.SpanName IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')) AND (traces.SpanAttributes['http.route'] != '' OR traces.SpanAttributes['url.path'] != '')), concat(if(traces.SpanName LIKE 'http.server %', replaceOne(traces.SpanName, 'http.server ', ''), traces.SpanName), ' ', if(traces.SpanAttributes['http.route'] != '', traces.SpanAttributes['http.route'], traces.SpanAttributes['url.path'])), traces.SpanName) = 'GET /v1/x')
          AND (traces.SpanKind IN ('Server', 'Consumer') OR traces.ParentSpanId = '')
          AND traces.StatusCode = 'Error'
          AND traces.Duration >= 5000000
          AND traces.Duration <= 5000000000
          AND coalesce(nullIf(traces.ResourceAttributes['deployment.environment.name'], ''), traces.ResourceAttributes['deployment.environment']) IN ('production')
          AND (((has(mapKeys(SpanAttributes), 'http.method') OR has(mapKeys(SpanAttributes), 'http.request.method')) AND has(mapValues(SpanAttributes), 'GET')) AND if(SpanAttributes['http.method'] != '', SpanAttributes['http.method'], SpanAttributes['http.request.method']) = 'GET')
          AND ((has(mapKeys(ResourceAttributes), 'service.namespace') AND has(mapValues(ResourceAttributes), 'core')) AND ResourceAttributes['service.namespace'] = 'core')
          AND traces.Timestamp >= (SELECT min(ts) FROM (SELECT
          traces.Timestamp AS ts
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND traces.ServiceName = 'api'
          AND (traces.SpanName = 'GET /v1/x' OR if(((traces.SpanName LIKE 'http.server %' OR traces.SpanName IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')) AND (traces.SpanAttributes['http.route'] != '' OR traces.SpanAttributes['url.path'] != '')), concat(if(traces.SpanName LIKE 'http.server %', replaceOne(traces.SpanName, 'http.server ', ''), traces.SpanName), ' ', if(traces.SpanAttributes['http.route'] != '', traces.SpanAttributes['http.route'], traces.SpanAttributes['url.path'])), traces.SpanName) = 'GET /v1/x')
          AND (traces.SpanKind IN ('Server', 'Consumer') OR traces.ParentSpanId = '')
          AND traces.StatusCode = 'Error'
          AND traces.Duration >= 5000000
          AND traces.Duration <= 5000000000
          AND coalesce(nullIf(traces.ResourceAttributes['deployment.environment.name'], ''), traces.ResourceAttributes['deployment.environment']) IN ('production')
          AND (((has(mapKeys(SpanAttributes), 'http.method') OR has(mapKeys(SpanAttributes), 'http.request.method')) AND has(mapValues(SpanAttributes), 'GET')) AND if(SpanAttributes['http.method'] != '', SpanAttributes['http.method'], SpanAttributes['http.request.method']) = 'GET')
          AND ((has(mapKeys(ResourceAttributes), 'service.namespace') AND has(mapValues(ResourceAttributes), 'core')) AND ResourceAttributes['service.namespace'] = 'core')
        ORDER BY ts DESC
        LIMIT 25))
        ORDER BY startTime DESC
        LIMIT 25
        FORMAT JSON

-- pipe:list_traces:filtered:text  [7a685c3c]
SELECT
          traces.TraceId AS traceId,
          traces.Timestamp AS startTime,
          traces.Timestamp AS endTime,
          intDiv(traces.Duration, 1000) AS durationMicros,
          toUInt64(1) AS spanCount,
          [traces.ServiceName] AS services,
          traces.SpanId AS rootSpanId,
          traces.SpanName AS rootSpanName,
          traces.SpanKind AS rootSpanKind,
          traces.StatusCode AS rootSpanStatusCode,
          traces.StatusMessage AS rootSpanStatusMessage,
          if(traces.SpanAttributes['http.method'] != '', traces.SpanAttributes['http.method'], traces.SpanAttributes['http.request.method']) AS rootHttpMethod,
          traces.SpanAttributes['http.route'] AS rootHttpRoute,
          if(traces.SpanAttributes['http.status_code'] != '', traces.SpanAttributes['http.status_code'], traces.SpanAttributes['http.response.status_code']) AS rootHttpStatusCode,
          toJSONString(map('http.method', SpanAttributes['http.method'], 'http.request.method', SpanAttributes['http.request.method'], 'http.route', SpanAttributes['http.route'], 'http.target', SpanAttributes['http.target'], 'http.status_code', SpanAttributes['http.status_code'], 'http.response.status_code', SpanAttributes['http.response.status_code'], 'http.url', SpanAttributes['http.url'], 'url.full', SpanAttributes['url.full'], 'url.path', SpanAttributes['url.path'], 'server.address', SpanAttributes['server.address'], 'net.peer.name', SpanAttributes['net.peer.name'], 'screen.name', SpanAttributes['screen.name'])) AS rootSpanAttributes,
          if(traces.StatusCode = 'Error', 1, 0) AS hasError
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND traces.ServiceName = 'api'
          AND (traces.SpanName = 'GET /v1/x' OR if(((traces.SpanName LIKE 'http.server %' OR traces.SpanName IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')) AND (traces.SpanAttributes['http.route'] != '' OR traces.SpanAttributes['url.path'] != '')), concat(if(traces.SpanName LIKE 'http.server %', replaceOne(traces.SpanName, 'http.server ', ''), traces.SpanName), ' ', if(traces.SpanAttributes['http.route'] != '', traces.SpanAttributes['http.route'], traces.SpanAttributes['url.path'])), traces.SpanName) = 'GET /v1/x')
          AND (traces.SpanKind IN ('Server', 'Consumer') OR traces.ParentSpanId = '')
          AND traces.StatusCode = 'Error'
          AND traces.Duration >= 5000000
          AND traces.Duration <= 5000000000
          AND coalesce(nullIf(traces.ResourceAttributes['deployment.environment.name'], ''), traces.ResourceAttributes['deployment.environment']) IN ('production')
          AND ((has(SpanAttributeItems, concat('http.method', char(31), 'GET')) OR has(SpanAttributeItems, concat('http.request.method', char(31), 'GET'))) AND if(SpanAttributes['http.method'] != '', SpanAttributes['http.method'], SpanAttributes['http.request.method']) = 'GET')
          AND (has(ResourceAttributeItems, concat('service.namespace', char(31), 'core')) AND ResourceAttributes['service.namespace'] = 'core')
          AND traces.Timestamp >= (SELECT min(ts) FROM (SELECT
          traces.Timestamp AS ts
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND traces.ServiceName = 'api'
          AND (traces.SpanName = 'GET /v1/x' OR if(((traces.SpanName LIKE 'http.server %' OR traces.SpanName IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')) AND (traces.SpanAttributes['http.route'] != '' OR traces.SpanAttributes['url.path'] != '')), concat(if(traces.SpanName LIKE 'http.server %', replaceOne(traces.SpanName, 'http.server ', ''), traces.SpanName), ' ', if(traces.SpanAttributes['http.route'] != '', traces.SpanAttributes['http.route'], traces.SpanAttributes['url.path'])), traces.SpanName) = 'GET /v1/x')
          AND (traces.SpanKind IN ('Server', 'Consumer') OR traces.ParentSpanId = '')
          AND traces.StatusCode = 'Error'
          AND traces.Duration >= 5000000
          AND traces.Duration <= 5000000000
          AND coalesce(nullIf(traces.ResourceAttributes['deployment.environment.name'], ''), traces.ResourceAttributes['deployment.environment']) IN ('production')
          AND ((has(SpanAttributeItems, concat('http.method', char(31), 'GET')) OR has(SpanAttributeItems, concat('http.request.method', char(31), 'GET'))) AND if(SpanAttributes['http.method'] != '', SpanAttributes['http.method'], SpanAttributes['http.request.method']) = 'GET')
          AND (has(ResourceAttributeItems, concat('service.namespace', char(31), 'core')) AND ResourceAttributes['service.namespace'] = 'core')
        ORDER BY ts DESC
        LIMIT 25))
        ORDER BY startTime DESC
        LIMIT 25
        FORMAT JSON

-- pipe:logs_count:default:baseline  [fa7ccb7f]
SELECT
          sum(counts.total) AS total
        FROM (
SELECT
          count() AS total
        FROM logs
        WHERE logs.OrgId = 'org_sql_catalog'
          AND logs.TimestampTime >= '2026-01-01 10:30:00'
          AND logs.TimestampTime <= '2026-01-03 14:15:00'
          AND logs.Timestamp >= '2026-01-01 10:30:00'
          AND logs.Timestamp <= '2026-01-03 14:15:00'
          AND (TimestampTime < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR TimestampTime >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
UNION ALL
SELECT
          sum(logs_aggregates_hourly.Count) AS total
        FROM logs_aggregates_hourly
        WHERE logs_aggregates_hourly.OrgId = 'org_sql_catalog'
          AND logs_aggregates_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND logs_aggregates_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
) AS counts
        FORMAT JSON

-- pipe:logs_count:default:bloom  [fa7ccb7f]
SELECT
          sum(counts.total) AS total
        FROM (
SELECT
          count() AS total
        FROM logs
        WHERE logs.OrgId = 'org_sql_catalog'
          AND logs.TimestampTime >= '2026-01-01 10:30:00'
          AND logs.TimestampTime <= '2026-01-03 14:15:00'
          AND logs.Timestamp >= '2026-01-01 10:30:00'
          AND logs.Timestamp <= '2026-01-03 14:15:00'
          AND (TimestampTime < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR TimestampTime >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
UNION ALL
SELECT
          sum(logs_aggregates_hourly.Count) AS total
        FROM logs_aggregates_hourly
        WHERE logs_aggregates_hourly.OrgId = 'org_sql_catalog'
          AND logs_aggregates_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND logs_aggregates_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
) AS counts
        FORMAT JSON

-- pipe:logs_count:default:text  [fa7ccb7f]
SELECT
          sum(counts.total) AS total
        FROM (
SELECT
          count() AS total
        FROM logs
        WHERE logs.OrgId = 'org_sql_catalog'
          AND logs.TimestampTime >= '2026-01-01 10:30:00'
          AND logs.TimestampTime <= '2026-01-03 14:15:00'
          AND logs.Timestamp >= '2026-01-01 10:30:00'
          AND logs.Timestamp <= '2026-01-03 14:15:00'
          AND (TimestampTime < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR TimestampTime >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
UNION ALL
SELECT
          sum(logs_aggregates_hourly.Count) AS total
        FROM logs_aggregates_hourly
        WHERE logs_aggregates_hourly.OrgId = 'org_sql_catalog'
          AND logs_aggregates_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND logs_aggregates_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
) AS counts
        FORMAT JSON

-- pipe:logs_count:searched:baseline  [637adf41]
SELECT
          count() AS total
        FROM logs
        WHERE logs.OrgId = 'org_sql_catalog'
          AND logs.TimestampTime >= '2026-01-01 10:30:00'
          AND logs.TimestampTime <= '2026-01-03 14:15:00'
          AND logs.Timestamp >= '2026-01-01 10:30:00'
          AND logs.Timestamp <= '2026-01-03 14:15:00'
          AND logs.Body ILIKE '%timeout%'
        FORMAT JSON

-- pipe:logs_count:searched:bloom  [637adf41]
SELECT
          count() AS total
        FROM logs
        WHERE logs.OrgId = 'org_sql_catalog'
          AND logs.TimestampTime >= '2026-01-01 10:30:00'
          AND logs.TimestampTime <= '2026-01-03 14:15:00'
          AND logs.Timestamp >= '2026-01-01 10:30:00'
          AND logs.Timestamp <= '2026-01-03 14:15:00'
          AND logs.Body ILIKE '%timeout%'
        FORMAT JSON

-- pipe:logs_count:searched:text  [637adf41]
SELECT
          count() AS total
        FROM logs
        WHERE logs.OrgId = 'org_sql_catalog'
          AND logs.TimestampTime >= '2026-01-01 10:30:00'
          AND logs.TimestampTime <= '2026-01-03 14:15:00'
          AND logs.Timestamp >= '2026-01-01 10:30:00'
          AND logs.Timestamp <= '2026-01-03 14:15:00'
          AND logs.Body ILIKE '%timeout%'
        FORMAT JSON

-- pipe:logs_facets:default:baseline  [0214fa9d]
SELECT * FROM (
SELECT
          logs_aggregates_hourly.SeverityText AS severityText,
          '' AS serviceName,
          '' AS deploymentEnv,
          '' AS namespace,
          sum(logs_aggregates_hourly.Count) AS count,
          'severity' AS facetType
        FROM logs_aggregates_hourly
        WHERE logs_aggregates_hourly.OrgId = 'org_sql_catalog'
          AND logs_aggregates_hourly.Hour >= '2026-01-01 10:30:00'
          AND logs_aggregates_hourly.Hour <= '2026-01-03 14:15:00'
        GROUP BY severityText
UNION ALL
SELECT
          '' AS severityText,
          logs_aggregates_hourly.ServiceName AS serviceName,
          '' AS deploymentEnv,
          '' AS namespace,
          sum(logs_aggregates_hourly.Count) AS count,
          'service' AS facetType
        FROM logs_aggregates_hourly
        WHERE logs_aggregates_hourly.OrgId = 'org_sql_catalog'
          AND logs_aggregates_hourly.Hour >= '2026-01-01 10:30:00'
          AND logs_aggregates_hourly.Hour <= '2026-01-03 14:15:00'
        GROUP BY serviceName
UNION ALL
SELECT
          '' AS severityText,
          '' AS serviceName,
          logs_aggregates_hourly.DeploymentEnv AS deploymentEnv,
          '' AS namespace,
          sum(logs_aggregates_hourly.Count) AS count,
          'deploymentEnv' AS facetType
        FROM logs_aggregates_hourly
        WHERE logs_aggregates_hourly.OrgId = 'org_sql_catalog'
          AND logs_aggregates_hourly.Hour >= '2026-01-01 10:30:00'
          AND logs_aggregates_hourly.Hour <= '2026-01-03 14:15:00'
          AND logs_aggregates_hourly.DeploymentEnv != ''
        GROUP BY deploymentEnv
UNION ALL
SELECT
          '' AS severityText,
          '' AS serviceName,
          '' AS deploymentEnv,
          logs_aggregates_hourly.ServiceNamespace AS namespace,
          sum(logs_aggregates_hourly.Count) AS count,
          'namespace' AS facetType
        FROM logs_aggregates_hourly
        WHERE logs_aggregates_hourly.OrgId = 'org_sql_catalog'
          AND logs_aggregates_hourly.Hour >= '2026-01-01 10:30:00'
          AND logs_aggregates_hourly.Hour <= '2026-01-03 14:15:00'
          AND logs_aggregates_hourly.ServiceNamespace != ''
        GROUP BY namespace
)
ORDER BY count DESC
LIMIT 500
FORMAT JSON

-- pipe:logs_facets:default:bloom  [0214fa9d]
SELECT * FROM (
SELECT
          logs_aggregates_hourly.SeverityText AS severityText,
          '' AS serviceName,
          '' AS deploymentEnv,
          '' AS namespace,
          sum(logs_aggregates_hourly.Count) AS count,
          'severity' AS facetType
        FROM logs_aggregates_hourly
        WHERE logs_aggregates_hourly.OrgId = 'org_sql_catalog'
          AND logs_aggregates_hourly.Hour >= '2026-01-01 10:30:00'
          AND logs_aggregates_hourly.Hour <= '2026-01-03 14:15:00'
        GROUP BY severityText
UNION ALL
SELECT
          '' AS severityText,
          logs_aggregates_hourly.ServiceName AS serviceName,
          '' AS deploymentEnv,
          '' AS namespace,
          sum(logs_aggregates_hourly.Count) AS count,
          'service' AS facetType
        FROM logs_aggregates_hourly
        WHERE logs_aggregates_hourly.OrgId = 'org_sql_catalog'
          AND logs_aggregates_hourly.Hour >= '2026-01-01 10:30:00'
          AND logs_aggregates_hourly.Hour <= '2026-01-03 14:15:00'
        GROUP BY serviceName
UNION ALL
SELECT
          '' AS severityText,
          '' AS serviceName,
          logs_aggregates_hourly.DeploymentEnv AS deploymentEnv,
          '' AS namespace,
          sum(logs_aggregates_hourly.Count) AS count,
          'deploymentEnv' AS facetType
        FROM logs_aggregates_hourly
        WHERE logs_aggregates_hourly.OrgId = 'org_sql_catalog'
          AND logs_aggregates_hourly.Hour >= '2026-01-01 10:30:00'
          AND logs_aggregates_hourly.Hour <= '2026-01-03 14:15:00'
          AND logs_aggregates_hourly.DeploymentEnv != ''
        GROUP BY deploymentEnv
UNION ALL
SELECT
          '' AS severityText,
          '' AS serviceName,
          '' AS deploymentEnv,
          logs_aggregates_hourly.ServiceNamespace AS namespace,
          sum(logs_aggregates_hourly.Count) AS count,
          'namespace' AS facetType
        FROM logs_aggregates_hourly
        WHERE logs_aggregates_hourly.OrgId = 'org_sql_catalog'
          AND logs_aggregates_hourly.Hour >= '2026-01-01 10:30:00'
          AND logs_aggregates_hourly.Hour <= '2026-01-03 14:15:00'
          AND logs_aggregates_hourly.ServiceNamespace != ''
        GROUP BY namespace
)
ORDER BY count DESC
LIMIT 500
FORMAT JSON

-- pipe:logs_facets:default:text  [0214fa9d]
SELECT * FROM (
SELECT
          logs_aggregates_hourly.SeverityText AS severityText,
          '' AS serviceName,
          '' AS deploymentEnv,
          '' AS namespace,
          sum(logs_aggregates_hourly.Count) AS count,
          'severity' AS facetType
        FROM logs_aggregates_hourly
        WHERE logs_aggregates_hourly.OrgId = 'org_sql_catalog'
          AND logs_aggregates_hourly.Hour >= '2026-01-01 10:30:00'
          AND logs_aggregates_hourly.Hour <= '2026-01-03 14:15:00'
        GROUP BY severityText
UNION ALL
SELECT
          '' AS severityText,
          logs_aggregates_hourly.ServiceName AS serviceName,
          '' AS deploymentEnv,
          '' AS namespace,
          sum(logs_aggregates_hourly.Count) AS count,
          'service' AS facetType
        FROM logs_aggregates_hourly
        WHERE logs_aggregates_hourly.OrgId = 'org_sql_catalog'
          AND logs_aggregates_hourly.Hour >= '2026-01-01 10:30:00'
          AND logs_aggregates_hourly.Hour <= '2026-01-03 14:15:00'
        GROUP BY serviceName
UNION ALL
SELECT
          '' AS severityText,
          '' AS serviceName,
          logs_aggregates_hourly.DeploymentEnv AS deploymentEnv,
          '' AS namespace,
          sum(logs_aggregates_hourly.Count) AS count,
          'deploymentEnv' AS facetType
        FROM logs_aggregates_hourly
        WHERE logs_aggregates_hourly.OrgId = 'org_sql_catalog'
          AND logs_aggregates_hourly.Hour >= '2026-01-01 10:30:00'
          AND logs_aggregates_hourly.Hour <= '2026-01-03 14:15:00'
          AND logs_aggregates_hourly.DeploymentEnv != ''
        GROUP BY deploymentEnv
UNION ALL
SELECT
          '' AS severityText,
          '' AS serviceName,
          '' AS deploymentEnv,
          logs_aggregates_hourly.ServiceNamespace AS namespace,
          sum(logs_aggregates_hourly.Count) AS count,
          'namespace' AS facetType
        FROM logs_aggregates_hourly
        WHERE logs_aggregates_hourly.OrgId = 'org_sql_catalog'
          AND logs_aggregates_hourly.Hour >= '2026-01-01 10:30:00'
          AND logs_aggregates_hourly.Hour <= '2026-01-03 14:15:00'
          AND logs_aggregates_hourly.ServiceNamespace != ''
        GROUP BY namespace
)
ORDER BY count DESC
LIMIT 500
FORMAT JSON

-- pipe:metric_attribute_keys:default:baseline  [585437ff]
SELECT
          attribute_keys_hourly.AttributeKey AS attributeKey,
          sum(attribute_keys_hourly.UsageCount) AS usageCount
        FROM attribute_keys_hourly
        WHERE attribute_keys_hourly.OrgId = 'org_sql_catalog'
          AND attribute_keys_hourly.Hour >= '2026-01-01 10:30:00'
          AND attribute_keys_hourly.Hour <= '2026-01-03 14:15:00'
          AND attribute_keys_hourly.AttributeScope = 'metric'
        GROUP BY attributeKey
        ORDER BY usageCount DESC
        LIMIT 200
        FORMAT JSON

-- pipe:metric_attribute_keys:metric-scoped:baseline  [a5e0b7f8]
SELECT
          arrayJoin(mapKeys(metrics_histogram.Attributes)) AS attributeKey,
          count() AS usageCount
        FROM metrics_histogram
        WHERE metrics_histogram.OrgId = 'org_sql_catalog'
          AND metrics_histogram.MetricName = 'http.server.duration'
          AND metrics_histogram.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_histogram.TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY attributeKey
        ORDER BY usageCount DESC
        LIMIT 200
        FORMAT JSON

-- pipe:metric_attribute_values:default:baseline  [c6d7887c]
SELECT
          attribute_values_hourly.AttributeValue AS attributeValue,
          sum(attribute_values_hourly.UsageCount) AS usageCount
        FROM attribute_values_hourly
        WHERE attribute_values_hourly.OrgId = 'org_sql_catalog'
          AND attribute_values_hourly.Hour >= '2026-01-01 10:30:00'
          AND attribute_values_hourly.Hour <= '2026-01-03 14:15:00'
          AND attribute_values_hourly.AttributeScope = 'metric'
          AND attribute_values_hourly.AttributeKey = 'http.route'
        GROUP BY attributeValue
        ORDER BY usageCount DESC
        LIMIT 50
        FORMAT JSON

-- pipe:metric_attribute_values:metric-scoped:baseline  [0ac5197a]
SELECT
          metrics_histogram.Attributes['http.route'] AS attributeValue,
          count() AS usageCount
        FROM metrics_histogram
        WHERE metrics_histogram.OrgId = 'org_sql_catalog'
          AND metrics_histogram.MetricName = 'http.server.duration'
          AND metrics_histogram.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_histogram.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_histogram.Attributes['http.route'] != ''
        GROUP BY attributeValue
        ORDER BY usageCount DESC
        LIMIT 50
        FORMAT JSON

-- pipe:metrics_summary:default:baseline  [8c5fb613]
SELECT
          metric_catalog.MetricType AS metricType,
          uniq(metric_catalog.MetricName) AS metricCount,
          sum(metric_catalog.DataPointCount) AS dataPointCount
        FROM metric_catalog
        WHERE metric_catalog.OrgId = 'org_sql_catalog'
          AND metric_catalog.Hour >= toStartOfInterval(toDateTime('2026-01-01 10:30:00'), INTERVAL 3600 SECOND)
          AND metric_catalog.Hour <= '2026-01-03 14:15:00'
        GROUP BY metricType
        FORMAT JSON

-- pipe:resource_attribute_keys:default:baseline  [585437ff]
SELECT
          attribute_keys_hourly.AttributeKey AS attributeKey,
          sum(attribute_keys_hourly.UsageCount) AS usageCount
        FROM attribute_keys_hourly
        WHERE attribute_keys_hourly.OrgId = 'org_sql_catalog'
          AND attribute_keys_hourly.Hour >= '2026-01-01 10:30:00'
          AND attribute_keys_hourly.Hour <= '2026-01-03 14:15:00'
          AND attribute_keys_hourly.AttributeScope = 'resource'
        GROUP BY attributeKey
        ORDER BY usageCount DESC
        LIMIT 200
        FORMAT JSON

-- pipe:resource_attribute_keys:default:bloom  [585437ff]
SELECT
          attribute_keys_hourly.AttributeKey AS attributeKey,
          sum(attribute_keys_hourly.UsageCount) AS usageCount
        FROM attribute_keys_hourly
        WHERE attribute_keys_hourly.OrgId = 'org_sql_catalog'
          AND attribute_keys_hourly.Hour >= '2026-01-01 10:30:00'
          AND attribute_keys_hourly.Hour <= '2026-01-03 14:15:00'
          AND attribute_keys_hourly.AttributeScope = 'resource'
        GROUP BY attributeKey
        ORDER BY usageCount DESC
        LIMIT 200
        FORMAT JSON

-- pipe:resource_attribute_keys:default:text  [585437ff]
SELECT
          attribute_keys_hourly.AttributeKey AS attributeKey,
          sum(attribute_keys_hourly.UsageCount) AS usageCount
        FROM attribute_keys_hourly
        WHERE attribute_keys_hourly.OrgId = 'org_sql_catalog'
          AND attribute_keys_hourly.Hour >= '2026-01-01 10:30:00'
          AND attribute_keys_hourly.Hour <= '2026-01-03 14:15:00'
          AND attribute_keys_hourly.AttributeScope = 'resource'
        GROUP BY attributeKey
        ORDER BY usageCount DESC
        LIMIT 200
        FORMAT JSON

-- pipe:resource_attribute_values:default:baseline  [c6d7887c]
SELECT
          attribute_values_hourly.AttributeValue AS attributeValue,
          sum(attribute_values_hourly.UsageCount) AS usageCount
        FROM attribute_values_hourly
        WHERE attribute_values_hourly.OrgId = 'org_sql_catalog'
          AND attribute_values_hourly.Hour >= '2026-01-01 10:30:00'
          AND attribute_values_hourly.Hour <= '2026-01-03 14:15:00'
          AND attribute_values_hourly.AttributeScope = 'resource'
          AND attribute_values_hourly.AttributeKey = 'service.namespace'
        GROUP BY attributeValue
        ORDER BY usageCount DESC
        LIMIT 50
        FORMAT JSON

-- pipe:resource_attribute_values:default:bloom  [c6d7887c]
SELECT
          attribute_values_hourly.AttributeValue AS attributeValue,
          sum(attribute_values_hourly.UsageCount) AS usageCount
        FROM attribute_values_hourly
        WHERE attribute_values_hourly.OrgId = 'org_sql_catalog'
          AND attribute_values_hourly.Hour >= '2026-01-01 10:30:00'
          AND attribute_values_hourly.Hour <= '2026-01-03 14:15:00'
          AND attribute_values_hourly.AttributeScope = 'resource'
          AND attribute_values_hourly.AttributeKey = 'service.namespace'
        GROUP BY attributeValue
        ORDER BY usageCount DESC
        LIMIT 50
        FORMAT JSON

-- pipe:resource_attribute_values:default:text  [c6d7887c]
SELECT
          attribute_values_hourly.AttributeValue AS attributeValue,
          sum(attribute_values_hourly.UsageCount) AS usageCount
        FROM attribute_values_hourly
        WHERE attribute_values_hourly.OrgId = 'org_sql_catalog'
          AND attribute_values_hourly.Hour >= '2026-01-01 10:30:00'
          AND attribute_values_hourly.Hour <= '2026-01-03 14:15:00'
          AND attribute_values_hourly.AttributeScope = 'resource'
          AND attribute_values_hourly.AttributeKey = 'service.namespace'
        GROUP BY attributeValue
        ORDER BY usageCount DESC
        LIMIT 50
        FORMAT JSON

-- pipe:service_apdex_time_series:custom-threshold:baseline  [50ac037a]
SELECT
          toStartOfInterval(service_overview_spans.Timestamp, INTERVAL 3600 SECOND) AS bucket,
          count() AS totalCount,
          countIf((NOT (service_overview_spans.StatusCode = 'Error') AND service_overview_spans.Duration / 1000000 < 250)) AS satisfiedCount,
          countIf((NOT (service_overview_spans.StatusCode = 'Error') AND (service_overview_spans.Duration / 1000000 >= 250 AND service_overview_spans.Duration / 1000000 < 1000))) AS toleratingCount,
          if(count() > 0, round(countIf((NOT (service_overview_spans.StatusCode = 'Error') AND service_overview_spans.Duration / 1000000 < 250)) / count() + countIf((NOT (service_overview_spans.StatusCode = 'Error') AND (service_overview_spans.Duration / 1000000 >= 250 AND service_overview_spans.Duration / 1000000 < 1000))) * 0.5 / count(), 4), 0) AS apdexScore
        FROM service_overview_spans
        WHERE service_overview_spans.OrgId = 'org_sql_catalog'
          AND service_overview_spans.Timestamp >= '2026-01-01 10:30:00'
          AND service_overview_spans.Timestamp <= '2026-01-03 14:15:00'
          AND service_overview_spans.ServiceName = 'api'
        GROUP BY bucket
        ORDER BY bucket ASC
        FORMAT JSON

-- pipe:service_apdex_time_series:default:baseline  [c8ecb321]
SELECT
          toStartOfInterval(service_windows.bBucket, INTERVAL 60 SECOND) AS bucket,
          sum(service_windows.bSpanCount) AS totalCount,
          sum(service_windows.bApdexSatisfiedCount) AS satisfiedCount,
          sum(service_windows.bApdexToleratingCount) AS toleratingCount,
          if(sum(service_windows.bSpanCount) > 0, round(sum(service_windows.bApdexSatisfiedCount) / sum(service_windows.bSpanCount) + sum(service_windows.bApdexToleratingCount) * 0.5 / sum(service_windows.bSpanCount), 4), 0) AS apdexScore
        FROM (
SELECT
          toStartOfMinute(service_overview_spans.Timestamp) AS bBucket,
          service_overview_spans.ServiceName AS bServiceName,
          service_overview_spans.ServiceNamespace AS bServiceNamespace,
          service_overview_spans.DeploymentEnv AS bEnvironment,
          service_overview_spans.CommitSha AS bCommitSha,
          count() AS bSpanCount,
          sum(service_overview_spans.SampleRate) AS bEstimatedSpanCount,
          countIf(service_overview_spans.StatusCode = 'Error') AS bErrorCount,
          sumIf(service_overview_spans.SampleRate, service_overview_spans.StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          min(service_overview_spans.Timestamp) AS bFirstSeen,
          countIf((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration < 500000000)) AS bApdexSatisfiedCount,
          countIf(((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration >= 500000000) AND service_overview_spans.Duration < 2000000000)) AS bApdexToleratingCount
        FROM service_overview_spans
        WHERE service_overview_spans.OrgId = 'org_sql_catalog'
          AND service_overview_spans.Timestamp >= '2026-01-01 10:30:00'
          AND service_overview_spans.Timestamp <= '2026-01-03 14:15:00'
          AND service_overview_spans.ServiceName = 'api'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 MINUTE) OR Timestamp >= toStartOfMinute(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
UNION ALL
SELECT
          service_overview_minutely.Minute AS bBucket,
          service_overview_minutely.ServiceName AS bServiceName,
          service_overview_minutely.ServiceNamespace AS bServiceNamespace,
          service_overview_minutely.DeploymentEnv AS bEnvironment,
          service_overview_minutely.CommitSha AS bCommitSha,
          sum(service_overview_minutely.SpanCount) AS bSpanCount,
          sum(service_overview_minutely.EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(service_overview_minutely.ErrorCount) AS bErrorCount,
          sum(service_overview_minutely.EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(service_overview_minutely.DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          min(service_overview_minutely.FirstSeen) AS bFirstSeen,
          sum(service_overview_minutely.ApdexSatisfiedCount) AS bApdexSatisfiedCount,
          sum(service_overview_minutely.ApdexToleratingCount) AS bApdexToleratingCount
        FROM service_overview_minutely
        WHERE service_overview_minutely.OrgId = 'org_sql_catalog'
          AND service_overview_minutely.ServiceName = 'api'
          AND service_overview_minutely.Minute >= if(toDateTime('2026-01-01 10:30:00') = toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 MINUTE)
          AND service_overview_minutely.Minute < toStartOfMinute(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
) AS service_windows
        GROUP BY bucket
        ORDER BY bucket ASC
        FORMAT JSON

-- pipe:service_dependencies:default:baseline  [3f463d3e]
SELECT
          edges.sourceService AS sourceService,
          edges.targetService AS targetService,
          sum(edges.bucketCallCount) AS callCount,
          sum(edges.bucketErrorCount) AS errorCount,
          ifNull(ifNotFinite(sum(edges.bucketDurationSumMs) / nullIf(sum(edges.bucketCallCount), 0), 0), 0) AS avgDurationMs,
          max(edges.bucketMaxDurationMs) AS maxDurationMs,
          sum(edges.bucketEstimatedSpanCount) AS estimatedSpanCount
        FROM (
SELECT
          service_map_edges_hourly.SourceService AS sourceService,
          service_map_edges_hourly.TargetService AS targetService,
          sum(service_map_edges_hourly.CallCount) AS bucketCallCount,
          sum(service_map_edges_hourly.ErrorCount) AS bucketErrorCount,
          sum(service_map_edges_hourly.DurationSumMs) AS bucketDurationSumMs,
          max(service_map_edges_hourly.MaxDurationMs) AS bucketMaxDurationMs,
          sum(if(service_map_edges_hourly.SampleRateSum > 0, service_map_edges_hourly.SampleRateSum, toFloat64(service_map_edges_hourly.CallCount))) AS bucketEstimatedSpanCount
        FROM service_map_edges_hourly
        WHERE service_map_edges_hourly.OrgId = 'org_sql_catalog'
          AND service_map_edges_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND service_map_edges_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND service_map_edges_hourly.DeploymentEnv = 'production'
        GROUP BY sourceService, targetService
UNION ALL
SELECT
          p.ServiceName AS sourceService,
          c.ServiceName AS targetService,
          count() AS bucketCallCount,
          countIf(c.StatusCode = 'Error') AS bucketErrorCount,
          sum(c.Duration / 1000000) AS bucketDurationSumMs,
          max(c.Duration / 1000000) AS bucketMaxDurationMs,
          sum(multiIf(match(c.TraceState, 'th:[0-9a-f]+'), 1.0 / greatest(1.0 - reinterpretAsUInt64(reverse(unhex(rightPad(extract(c.TraceState, 'th:([0-9a-f]+)'), 16, '0')))) / pow(2.0, 64), 0.0001), 1.0)) AS bucketEstimatedSpanCount
        FROM (SELECT
          service_map_spans.OrgId AS OrgId,
          service_map_spans.Timestamp AS Timestamp,
          service_map_spans.TraceId AS TraceId,
          service_map_spans.SpanId AS SpanId,
          service_map_spans.ServiceName AS ServiceName,
          service_map_spans.DeploymentEnv AS DeploymentEnv
        FROM service_map_spans
        WHERE service_map_spans.SpanKind IN ('Client', 'Producer')
          AND service_map_spans.Timestamp >= toDateTime('2026-01-01 10:30:00')
          AND service_map_spans.Timestamp < toDateTime('2026-01-03 14:15:00')
          AND service_map_spans.OrgId = 'org_sql_catalog'
          AND service_map_spans.DeploymentEnv = 'production'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))) AS p
        INNER JOIN (SELECT
          service_map_children.TraceId AS TraceId,
          service_map_children.ParentSpanId AS ParentSpanId,
          service_map_children.ServiceName AS ServiceName,
          service_map_children.Duration AS Duration,
          service_map_children.StatusCode AS StatusCode,
          service_map_children.TraceState AS TraceState
        FROM service_map_children
        WHERE service_map_children.Timestamp >= toDateTime('2026-01-01 10:30:00')
          AND service_map_children.Timestamp < toDateTime('2026-01-03 14:15:00')
          AND service_map_children.OrgId = 'org_sql_catalog'
          AND service_map_children.DeploymentEnv = 'production'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))) AS c ON (p.SpanId = c.ParentSpanId AND p.TraceId = c.TraceId)
        WHERE p.ServiceName != c.ServiceName
        GROUP BY sourceService, targetService
) AS edges
        GROUP BY sourceService, targetService
        ORDER BY callCount DESC
        LIMIT 200
        FORMAT JSON

-- pipe:service_overview_compare:default:baseline  [1ed706a2]
SELECT 'current' AS period, * FROM (
SELECT
          service_commit_rows.cServiceName AS serviceName,
          service_commit_rows.cEnvironment AS environment,
          argMax(cServiceNamespace, cEstimatedSpanCount) AS serviceNamespace,
          sum(service_commit_rows.cSpanCount) AS throughput,
          sum(service_commit_rows.cErrorCount) AS errorCount,
          sum(service_commit_rows.cEstimatedErrorCount) AS estimatedErrorCount,
          sum(service_commit_rows.cSpanCount) AS spanCount,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(cDurationQuantiles), 1) / 1000000 AS p50LatencyMs,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(cDurationQuantiles), 2) / 1000000 AS p95LatencyMs,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(cDurationQuantiles), 3) / 1000000 AS p99LatencyMs,
          sum(service_commit_rows.cEstimatedSpanCount) AS estimatedSpanCount,
          min(service_commit_rows.cFirstSeen) AS firstSeen,
          arraySlice(arrayReverseSort(x -> x.2, groupArray(tuple(cCommitSha, cSpanCount, cErrorCount, toString(cFirstSeen)))), 1, 20) AS commits
        FROM (SELECT
          service_windows.bServiceName AS cServiceName,
          service_windows.bServiceNamespace AS cServiceNamespace,
          service_windows.bEnvironment AS cEnvironment,
          service_windows.bCommitSha AS cCommitSha,
          sum(service_windows.bSpanCount) AS cSpanCount,
          sum(service_windows.bErrorCount) AS cErrorCount,
          sum(service_windows.bEstimatedErrorCount) AS cEstimatedErrorCount,
          sum(service_windows.bEstimatedSpanCount) AS cEstimatedSpanCount,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(bDurationQuantiles) AS cDurationQuantiles,
          min(service_windows.bFirstSeen) AS cFirstSeen
        FROM (
SELECT
          toStartOfHour(service_overview_spans.Timestamp) AS bBucket,
          service_overview_spans.ServiceName AS bServiceName,
          service_overview_spans.ServiceNamespace AS bServiceNamespace,
          service_overview_spans.DeploymentEnv AS bEnvironment,
          service_overview_spans.CommitSha AS bCommitSha,
          count() AS bSpanCount,
          sum(service_overview_spans.SampleRate) AS bEstimatedSpanCount,
          countIf(service_overview_spans.StatusCode = 'Error') AS bErrorCount,
          sumIf(service_overview_spans.SampleRate, service_overview_spans.StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          min(service_overview_spans.Timestamp) AS bFirstSeen,
          countIf((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration < 500000000)) AS bApdexSatisfiedCount,
          countIf(((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration >= 500000000) AND service_overview_spans.Duration < 2000000000)) AS bApdexToleratingCount
        FROM service_overview_spans
        WHERE service_overview_spans.OrgId = 'org_sql_catalog'
          AND service_overview_spans.Timestamp >= '2026-01-01 10:30:00'
          AND service_overview_spans.Timestamp <= '2026-01-03 14:15:00'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
UNION ALL
SELECT
          service_overview_hourly.Hour AS bBucket,
          service_overview_hourly.ServiceName AS bServiceName,
          service_overview_hourly.ServiceNamespace AS bServiceNamespace,
          service_overview_hourly.DeploymentEnv AS bEnvironment,
          service_overview_hourly.CommitSha AS bCommitSha,
          sum(service_overview_hourly.SpanCount) AS bSpanCount,
          sum(service_overview_hourly.EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(service_overview_hourly.ErrorCount) AS bErrorCount,
          sum(service_overview_hourly.EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(service_overview_hourly.DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          min(service_overview_hourly.FirstSeen) AS bFirstSeen,
          sum(service_overview_hourly.ApdexSatisfiedCount) AS bApdexSatisfiedCount,
          sum(service_overview_hourly.ApdexToleratingCount) AS bApdexToleratingCount
        FROM service_overview_hourly
        WHERE service_overview_hourly.OrgId = 'org_sql_catalog'
          AND service_overview_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND service_overview_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
) AS service_windows
        GROUP BY cServiceName, cServiceNamespace, cEnvironment, cCommitSha) AS service_commit_rows
        GROUP BY serviceName, environment
        ORDER BY throughput DESC
        LIMIT 500
)
UNION ALL
SELECT 'previous' AS period, * FROM (
SELECT
          service_commit_rows.cServiceName AS serviceName,
          service_commit_rows.cEnvironment AS environment,
          argMax(cServiceNamespace, cEstimatedSpanCount) AS serviceNamespace,
          sum(service_commit_rows.cSpanCount) AS throughput,
          sum(service_commit_rows.cErrorCount) AS errorCount,
          sum(service_commit_rows.cEstimatedErrorCount) AS estimatedErrorCount,
          sum(service_commit_rows.cSpanCount) AS spanCount,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(cDurationQuantiles), 1) / 1000000 AS p50LatencyMs,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(cDurationQuantiles), 2) / 1000000 AS p95LatencyMs,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(cDurationQuantiles), 3) / 1000000 AS p99LatencyMs,
          sum(service_commit_rows.cEstimatedSpanCount) AS estimatedSpanCount,
          min(service_commit_rows.cFirstSeen) AS firstSeen,
          arraySlice(arrayReverseSort(x -> x.2, groupArray(tuple(cCommitSha, cSpanCount, cErrorCount, toString(cFirstSeen)))), 1, 20) AS commits
        FROM (SELECT
          service_windows.bServiceName AS cServiceName,
          service_windows.bServiceNamespace AS cServiceNamespace,
          service_windows.bEnvironment AS cEnvironment,
          service_windows.bCommitSha AS cCommitSha,
          sum(service_windows.bSpanCount) AS cSpanCount,
          sum(service_windows.bErrorCount) AS cErrorCount,
          sum(service_windows.bEstimatedErrorCount) AS cEstimatedErrorCount,
          sum(service_windows.bEstimatedSpanCount) AS cEstimatedSpanCount,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(bDurationQuantiles) AS cDurationQuantiles,
          min(service_windows.bFirstSeen) AS cFirstSeen
        FROM (
SELECT
          toStartOfHour(service_overview_spans.Timestamp) AS bBucket,
          service_overview_spans.ServiceName AS bServiceName,
          service_overview_spans.ServiceNamespace AS bServiceNamespace,
          service_overview_spans.DeploymentEnv AS bEnvironment,
          service_overview_spans.CommitSha AS bCommitSha,
          count() AS bSpanCount,
          sum(service_overview_spans.SampleRate) AS bEstimatedSpanCount,
          countIf(service_overview_spans.StatusCode = 'Error') AS bErrorCount,
          sumIf(service_overview_spans.SampleRate, service_overview_spans.StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          min(service_overview_spans.Timestamp) AS bFirstSeen,
          countIf((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration < 500000000)) AS bApdexSatisfiedCount,
          countIf(((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration >= 500000000) AND service_overview_spans.Duration < 2000000000)) AS bApdexToleratingCount
        FROM service_overview_spans
        WHERE service_overview_spans.OrgId = 'org_sql_catalog'
          AND service_overview_spans.Timestamp >= '2025-12-30 10:30:00'
          AND service_overview_spans.Timestamp <= '2026-01-01 14:15:00'
          AND (Timestamp < if(toDateTime('2025-12-30 10:30:00') = toStartOfHour(toDateTime('2025-12-30 10:30:00')), toStartOfHour(toDateTime('2025-12-30 10:30:00')), toStartOfHour(toDateTime('2025-12-30 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-01 14:15:00')))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
UNION ALL
SELECT
          service_overview_hourly.Hour AS bBucket,
          service_overview_hourly.ServiceName AS bServiceName,
          service_overview_hourly.ServiceNamespace AS bServiceNamespace,
          service_overview_hourly.DeploymentEnv AS bEnvironment,
          service_overview_hourly.CommitSha AS bCommitSha,
          sum(service_overview_hourly.SpanCount) AS bSpanCount,
          sum(service_overview_hourly.EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(service_overview_hourly.ErrorCount) AS bErrorCount,
          sum(service_overview_hourly.EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(service_overview_hourly.DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          min(service_overview_hourly.FirstSeen) AS bFirstSeen,
          sum(service_overview_hourly.ApdexSatisfiedCount) AS bApdexSatisfiedCount,
          sum(service_overview_hourly.ApdexToleratingCount) AS bApdexToleratingCount
        FROM service_overview_hourly
        WHERE service_overview_hourly.OrgId = 'org_sql_catalog'
          AND service_overview_hourly.Hour >= if(toDateTime('2025-12-30 10:30:00') = toStartOfHour(toDateTime('2025-12-30 10:30:00')), toStartOfHour(toDateTime('2025-12-30 10:30:00')), toStartOfHour(toDateTime('2025-12-30 10:30:00')) + INTERVAL 1 HOUR)
          AND service_overview_hourly.Hour < toStartOfHour(toDateTime('2026-01-01 14:15:00'))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
) AS service_windows
        GROUP BY cServiceName, cServiceNamespace, cEnvironment, cCommitSha) AS service_commit_rows
        GROUP BY serviceName, environment
        ORDER BY throughput DESC
        LIMIT 500
)
FORMAT JSON

-- pipe:service_overview_compare:namespace-scoped:baseline  [b7968dfe]
SELECT 'current' AS period, * FROM (
SELECT
          service_commit_rows.cServiceName AS serviceName,
          service_commit_rows.cEnvironment AS environment,
          argMax(cServiceNamespace, cEstimatedSpanCount) AS serviceNamespace,
          sum(service_commit_rows.cSpanCount) AS throughput,
          sum(service_commit_rows.cErrorCount) AS errorCount,
          sum(service_commit_rows.cEstimatedErrorCount) AS estimatedErrorCount,
          sum(service_commit_rows.cSpanCount) AS spanCount,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(cDurationQuantiles), 1) / 1000000 AS p50LatencyMs,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(cDurationQuantiles), 2) / 1000000 AS p95LatencyMs,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(cDurationQuantiles), 3) / 1000000 AS p99LatencyMs,
          sum(service_commit_rows.cEstimatedSpanCount) AS estimatedSpanCount,
          min(service_commit_rows.cFirstSeen) AS firstSeen,
          arraySlice(arrayReverseSort(x -> x.2, groupArray(tuple(cCommitSha, cSpanCount, cErrorCount, toString(cFirstSeen)))), 1, 20) AS commits
        FROM (SELECT
          service_windows.bServiceName AS cServiceName,
          service_windows.bServiceNamespace AS cServiceNamespace,
          service_windows.bEnvironment AS cEnvironment,
          service_windows.bCommitSha AS cCommitSha,
          sum(service_windows.bSpanCount) AS cSpanCount,
          sum(service_windows.bErrorCount) AS cErrorCount,
          sum(service_windows.bEstimatedErrorCount) AS cEstimatedErrorCount,
          sum(service_windows.bEstimatedSpanCount) AS cEstimatedSpanCount,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(bDurationQuantiles) AS cDurationQuantiles,
          min(service_windows.bFirstSeen) AS cFirstSeen
        FROM (
SELECT
          toStartOfHour(service_overview_spans.Timestamp) AS bBucket,
          service_overview_spans.ServiceName AS bServiceName,
          service_overview_spans.ServiceNamespace AS bServiceNamespace,
          service_overview_spans.DeploymentEnv AS bEnvironment,
          service_overview_spans.CommitSha AS bCommitSha,
          count() AS bSpanCount,
          sum(service_overview_spans.SampleRate) AS bEstimatedSpanCount,
          countIf(service_overview_spans.StatusCode = 'Error') AS bErrorCount,
          sumIf(service_overview_spans.SampleRate, service_overview_spans.StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          min(service_overview_spans.Timestamp) AS bFirstSeen,
          countIf((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration < 500000000)) AS bApdexSatisfiedCount,
          countIf(((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration >= 500000000) AND service_overview_spans.Duration < 2000000000)) AS bApdexToleratingCount
        FROM service_overview_spans
        WHERE service_overview_spans.OrgId = 'org_sql_catalog'
          AND service_overview_spans.Timestamp >= '2026-01-01 10:30:00'
          AND service_overview_spans.Timestamp <= '2026-01-03 14:15:00'
          AND service_overview_spans.DeploymentEnv IN ('production')
          AND service_overview_spans.ServiceNamespace IN ('commerce')
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
UNION ALL
SELECT
          service_overview_hourly.Hour AS bBucket,
          service_overview_hourly.ServiceName AS bServiceName,
          service_overview_hourly.ServiceNamespace AS bServiceNamespace,
          service_overview_hourly.DeploymentEnv AS bEnvironment,
          service_overview_hourly.CommitSha AS bCommitSha,
          sum(service_overview_hourly.SpanCount) AS bSpanCount,
          sum(service_overview_hourly.EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(service_overview_hourly.ErrorCount) AS bErrorCount,
          sum(service_overview_hourly.EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(service_overview_hourly.DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          min(service_overview_hourly.FirstSeen) AS bFirstSeen,
          sum(service_overview_hourly.ApdexSatisfiedCount) AS bApdexSatisfiedCount,
          sum(service_overview_hourly.ApdexToleratingCount) AS bApdexToleratingCount
        FROM service_overview_hourly
        WHERE service_overview_hourly.OrgId = 'org_sql_catalog'
          AND service_overview_hourly.DeploymentEnv IN ('production')
          AND service_overview_hourly.ServiceNamespace IN ('commerce')
          AND service_overview_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND service_overview_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
) AS service_windows
        GROUP BY cServiceName, cServiceNamespace, cEnvironment, cCommitSha) AS service_commit_rows
        GROUP BY serviceName, environment
        ORDER BY throughput DESC
        LIMIT 500
)
UNION ALL
SELECT 'previous' AS period, * FROM (
SELECT
          service_commit_rows.cServiceName AS serviceName,
          service_commit_rows.cEnvironment AS environment,
          argMax(cServiceNamespace, cEstimatedSpanCount) AS serviceNamespace,
          sum(service_commit_rows.cSpanCount) AS throughput,
          sum(service_commit_rows.cErrorCount) AS errorCount,
          sum(service_commit_rows.cEstimatedErrorCount) AS estimatedErrorCount,
          sum(service_commit_rows.cSpanCount) AS spanCount,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(cDurationQuantiles), 1) / 1000000 AS p50LatencyMs,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(cDurationQuantiles), 2) / 1000000 AS p95LatencyMs,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(cDurationQuantiles), 3) / 1000000 AS p99LatencyMs,
          sum(service_commit_rows.cEstimatedSpanCount) AS estimatedSpanCount,
          min(service_commit_rows.cFirstSeen) AS firstSeen,
          arraySlice(arrayReverseSort(x -> x.2, groupArray(tuple(cCommitSha, cSpanCount, cErrorCount, toString(cFirstSeen)))), 1, 20) AS commits
        FROM (SELECT
          service_windows.bServiceName AS cServiceName,
          service_windows.bServiceNamespace AS cServiceNamespace,
          service_windows.bEnvironment AS cEnvironment,
          service_windows.bCommitSha AS cCommitSha,
          sum(service_windows.bSpanCount) AS cSpanCount,
          sum(service_windows.bErrorCount) AS cErrorCount,
          sum(service_windows.bEstimatedErrorCount) AS cEstimatedErrorCount,
          sum(service_windows.bEstimatedSpanCount) AS cEstimatedSpanCount,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(bDurationQuantiles) AS cDurationQuantiles,
          min(service_windows.bFirstSeen) AS cFirstSeen
        FROM (
SELECT
          toStartOfHour(service_overview_spans.Timestamp) AS bBucket,
          service_overview_spans.ServiceName AS bServiceName,
          service_overview_spans.ServiceNamespace AS bServiceNamespace,
          service_overview_spans.DeploymentEnv AS bEnvironment,
          service_overview_spans.CommitSha AS bCommitSha,
          count() AS bSpanCount,
          sum(service_overview_spans.SampleRate) AS bEstimatedSpanCount,
          countIf(service_overview_spans.StatusCode = 'Error') AS bErrorCount,
          sumIf(service_overview_spans.SampleRate, service_overview_spans.StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          min(service_overview_spans.Timestamp) AS bFirstSeen,
          countIf((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration < 500000000)) AS bApdexSatisfiedCount,
          countIf(((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration >= 500000000) AND service_overview_spans.Duration < 2000000000)) AS bApdexToleratingCount
        FROM service_overview_spans
        WHERE service_overview_spans.OrgId = 'org_sql_catalog'
          AND service_overview_spans.Timestamp >= '2025-12-30 10:30:00'
          AND service_overview_spans.Timestamp <= '2026-01-01 14:15:00'
          AND service_overview_spans.DeploymentEnv IN ('production')
          AND service_overview_spans.ServiceNamespace IN ('commerce')
          AND (Timestamp < if(toDateTime('2025-12-30 10:30:00') = toStartOfHour(toDateTime('2025-12-30 10:30:00')), toStartOfHour(toDateTime('2025-12-30 10:30:00')), toStartOfHour(toDateTime('2025-12-30 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-01 14:15:00')))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
UNION ALL
SELECT
          service_overview_hourly.Hour AS bBucket,
          service_overview_hourly.ServiceName AS bServiceName,
          service_overview_hourly.ServiceNamespace AS bServiceNamespace,
          service_overview_hourly.DeploymentEnv AS bEnvironment,
          service_overview_hourly.CommitSha AS bCommitSha,
          sum(service_overview_hourly.SpanCount) AS bSpanCount,
          sum(service_overview_hourly.EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(service_overview_hourly.ErrorCount) AS bErrorCount,
          sum(service_overview_hourly.EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(service_overview_hourly.DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          min(service_overview_hourly.FirstSeen) AS bFirstSeen,
          sum(service_overview_hourly.ApdexSatisfiedCount) AS bApdexSatisfiedCount,
          sum(service_overview_hourly.ApdexToleratingCount) AS bApdexToleratingCount
        FROM service_overview_hourly
        WHERE service_overview_hourly.OrgId = 'org_sql_catalog'
          AND service_overview_hourly.DeploymentEnv IN ('production')
          AND service_overview_hourly.ServiceNamespace IN ('commerce')
          AND service_overview_hourly.Hour >= if(toDateTime('2025-12-30 10:30:00') = toStartOfHour(toDateTime('2025-12-30 10:30:00')), toStartOfHour(toDateTime('2025-12-30 10:30:00')), toStartOfHour(toDateTime('2025-12-30 10:30:00')) + INTERVAL 1 HOUR)
          AND service_overview_hourly.Hour < toStartOfHour(toDateTime('2026-01-01 14:15:00'))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
) AS service_windows
        GROUP BY cServiceName, cServiceNamespace, cEnvironment, cCommitSha) AS service_commit_rows
        GROUP BY serviceName, environment
        ORDER BY throughput DESC
        LIMIT 500
)
FORMAT JSON

-- pipe:service_overview:default:baseline  [a474ea49]
SELECT
          service_commit_rows.cServiceName AS serviceName,
          service_commit_rows.cEnvironment AS environment,
          argMax(cServiceNamespace, cEstimatedSpanCount) AS serviceNamespace,
          sum(service_commit_rows.cSpanCount) AS throughput,
          sum(service_commit_rows.cErrorCount) AS errorCount,
          sum(service_commit_rows.cEstimatedErrorCount) AS estimatedErrorCount,
          sum(service_commit_rows.cSpanCount) AS spanCount,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(cDurationQuantiles), 1) / 1000000 AS p50LatencyMs,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(cDurationQuantiles), 2) / 1000000 AS p95LatencyMs,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(cDurationQuantiles), 3) / 1000000 AS p99LatencyMs,
          sum(service_commit_rows.cEstimatedSpanCount) AS estimatedSpanCount,
          min(service_commit_rows.cFirstSeen) AS firstSeen,
          arraySlice(arrayReverseSort(x -> x.2, groupArray(tuple(cCommitSha, cSpanCount, cErrorCount, toString(cFirstSeen)))), 1, 20) AS commits
        FROM (SELECT
          service_windows.bServiceName AS cServiceName,
          service_windows.bServiceNamespace AS cServiceNamespace,
          service_windows.bEnvironment AS cEnvironment,
          service_windows.bCommitSha AS cCommitSha,
          sum(service_windows.bSpanCount) AS cSpanCount,
          sum(service_windows.bErrorCount) AS cErrorCount,
          sum(service_windows.bEstimatedErrorCount) AS cEstimatedErrorCount,
          sum(service_windows.bEstimatedSpanCount) AS cEstimatedSpanCount,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(bDurationQuantiles) AS cDurationQuantiles,
          min(service_windows.bFirstSeen) AS cFirstSeen
        FROM (
SELECT
          toStartOfHour(service_overview_spans.Timestamp) AS bBucket,
          service_overview_spans.ServiceName AS bServiceName,
          service_overview_spans.ServiceNamespace AS bServiceNamespace,
          service_overview_spans.DeploymentEnv AS bEnvironment,
          service_overview_spans.CommitSha AS bCommitSha,
          count() AS bSpanCount,
          sum(service_overview_spans.SampleRate) AS bEstimatedSpanCount,
          countIf(service_overview_spans.StatusCode = 'Error') AS bErrorCount,
          sumIf(service_overview_spans.SampleRate, service_overview_spans.StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          min(service_overview_spans.Timestamp) AS bFirstSeen,
          countIf((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration < 500000000)) AS bApdexSatisfiedCount,
          countIf(((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration >= 500000000) AND service_overview_spans.Duration < 2000000000)) AS bApdexToleratingCount
        FROM service_overview_spans
        WHERE service_overview_spans.OrgId = 'org_sql_catalog'
          AND service_overview_spans.Timestamp >= '2026-01-01 10:30:00'
          AND service_overview_spans.Timestamp <= '2026-01-03 14:15:00'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
UNION ALL
SELECT
          service_overview_hourly.Hour AS bBucket,
          service_overview_hourly.ServiceName AS bServiceName,
          service_overview_hourly.ServiceNamespace AS bServiceNamespace,
          service_overview_hourly.DeploymentEnv AS bEnvironment,
          service_overview_hourly.CommitSha AS bCommitSha,
          sum(service_overview_hourly.SpanCount) AS bSpanCount,
          sum(service_overview_hourly.EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(service_overview_hourly.ErrorCount) AS bErrorCount,
          sum(service_overview_hourly.EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(service_overview_hourly.DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          min(service_overview_hourly.FirstSeen) AS bFirstSeen,
          sum(service_overview_hourly.ApdexSatisfiedCount) AS bApdexSatisfiedCount,
          sum(service_overview_hourly.ApdexToleratingCount) AS bApdexToleratingCount
        FROM service_overview_hourly
        WHERE service_overview_hourly.OrgId = 'org_sql_catalog'
          AND service_overview_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND service_overview_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
) AS service_windows
        GROUP BY cServiceName, cServiceNamespace, cEnvironment, cCommitSha) AS service_commit_rows
        GROUP BY serviceName, environment
        ORDER BY throughput DESC
        LIMIT 500
        FORMAT JSON

-- pipe:service_overview:filtered:baseline  [09574bf9]
SELECT
          service_commit_rows.cServiceName AS serviceName,
          service_commit_rows.cEnvironment AS environment,
          argMax(cServiceNamespace, cEstimatedSpanCount) AS serviceNamespace,
          sum(service_commit_rows.cSpanCount) AS throughput,
          sum(service_commit_rows.cErrorCount) AS errorCount,
          sum(service_commit_rows.cEstimatedErrorCount) AS estimatedErrorCount,
          sum(service_commit_rows.cSpanCount) AS spanCount,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(cDurationQuantiles), 1) / 1000000 AS p50LatencyMs,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(cDurationQuantiles), 2) / 1000000 AS p95LatencyMs,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(cDurationQuantiles), 3) / 1000000 AS p99LatencyMs,
          sum(service_commit_rows.cEstimatedSpanCount) AS estimatedSpanCount,
          min(service_commit_rows.cFirstSeen) AS firstSeen,
          arraySlice(arrayReverseSort(x -> x.2, groupArray(tuple(cCommitSha, cSpanCount, cErrorCount, toString(cFirstSeen)))), 1, 20) AS commits
        FROM (SELECT
          service_windows.bServiceName AS cServiceName,
          service_windows.bServiceNamespace AS cServiceNamespace,
          service_windows.bEnvironment AS cEnvironment,
          service_windows.bCommitSha AS cCommitSha,
          sum(service_windows.bSpanCount) AS cSpanCount,
          sum(service_windows.bErrorCount) AS cErrorCount,
          sum(service_windows.bEstimatedErrorCount) AS cEstimatedErrorCount,
          sum(service_windows.bEstimatedSpanCount) AS cEstimatedSpanCount,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(bDurationQuantiles) AS cDurationQuantiles,
          min(service_windows.bFirstSeen) AS cFirstSeen
        FROM (
SELECT
          toStartOfHour(service_overview_spans.Timestamp) AS bBucket,
          service_overview_spans.ServiceName AS bServiceName,
          service_overview_spans.ServiceNamespace AS bServiceNamespace,
          service_overview_spans.DeploymentEnv AS bEnvironment,
          service_overview_spans.CommitSha AS bCommitSha,
          count() AS bSpanCount,
          sum(service_overview_spans.SampleRate) AS bEstimatedSpanCount,
          countIf(service_overview_spans.StatusCode = 'Error') AS bErrorCount,
          sumIf(service_overview_spans.SampleRate, service_overview_spans.StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          min(service_overview_spans.Timestamp) AS bFirstSeen,
          countIf((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration < 500000000)) AS bApdexSatisfiedCount,
          countIf(((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration >= 500000000) AND service_overview_spans.Duration < 2000000000)) AS bApdexToleratingCount
        FROM service_overview_spans
        WHERE service_overview_spans.OrgId = 'org_sql_catalog'
          AND service_overview_spans.Timestamp >= '2026-01-01 10:30:00'
          AND service_overview_spans.Timestamp <= '2026-01-03 14:15:00'
          AND service_overview_spans.DeploymentEnv IN ('production', 'staging')
          AND service_overview_spans.CommitSha IN ('abc123', 'def456')
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
UNION ALL
SELECT
          service_overview_hourly.Hour AS bBucket,
          service_overview_hourly.ServiceName AS bServiceName,
          service_overview_hourly.ServiceNamespace AS bServiceNamespace,
          service_overview_hourly.DeploymentEnv AS bEnvironment,
          service_overview_hourly.CommitSha AS bCommitSha,
          sum(service_overview_hourly.SpanCount) AS bSpanCount,
          sum(service_overview_hourly.EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(service_overview_hourly.ErrorCount) AS bErrorCount,
          sum(service_overview_hourly.EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(service_overview_hourly.DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          min(service_overview_hourly.FirstSeen) AS bFirstSeen,
          sum(service_overview_hourly.ApdexSatisfiedCount) AS bApdexSatisfiedCount,
          sum(service_overview_hourly.ApdexToleratingCount) AS bApdexToleratingCount
        FROM service_overview_hourly
        WHERE service_overview_hourly.OrgId = 'org_sql_catalog'
          AND service_overview_hourly.DeploymentEnv IN ('production', 'staging')
          AND service_overview_hourly.CommitSha IN ('abc123', 'def456')
          AND service_overview_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND service_overview_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
) AS service_windows
        GROUP BY cServiceName, cServiceNamespace, cEnvironment, cCommitSha) AS service_commit_rows
        GROUP BY serviceName, environment
        ORDER BY throughput DESC
        LIMIT 500
        FORMAT JSON

-- pipe:service_overview:namespace-scoped:baseline  [c1255377]
SELECT
          service_commit_rows.cServiceName AS serviceName,
          service_commit_rows.cEnvironment AS environment,
          argMax(cServiceNamespace, cEstimatedSpanCount) AS serviceNamespace,
          sum(service_commit_rows.cSpanCount) AS throughput,
          sum(service_commit_rows.cErrorCount) AS errorCount,
          sum(service_commit_rows.cEstimatedErrorCount) AS estimatedErrorCount,
          sum(service_commit_rows.cSpanCount) AS spanCount,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(cDurationQuantiles), 1) / 1000000 AS p50LatencyMs,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(cDurationQuantiles), 2) / 1000000 AS p95LatencyMs,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(cDurationQuantiles), 3) / 1000000 AS p99LatencyMs,
          sum(service_commit_rows.cEstimatedSpanCount) AS estimatedSpanCount,
          min(service_commit_rows.cFirstSeen) AS firstSeen,
          arraySlice(arrayReverseSort(x -> x.2, groupArray(tuple(cCommitSha, cSpanCount, cErrorCount, toString(cFirstSeen)))), 1, 20) AS commits
        FROM (SELECT
          service_windows.bServiceName AS cServiceName,
          service_windows.bServiceNamespace AS cServiceNamespace,
          service_windows.bEnvironment AS cEnvironment,
          service_windows.bCommitSha AS cCommitSha,
          sum(service_windows.bSpanCount) AS cSpanCount,
          sum(service_windows.bErrorCount) AS cErrorCount,
          sum(service_windows.bEstimatedErrorCount) AS cEstimatedErrorCount,
          sum(service_windows.bEstimatedSpanCount) AS cEstimatedSpanCount,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(bDurationQuantiles) AS cDurationQuantiles,
          min(service_windows.bFirstSeen) AS cFirstSeen
        FROM (
SELECT
          toStartOfHour(service_overview_spans.Timestamp) AS bBucket,
          service_overview_spans.ServiceName AS bServiceName,
          service_overview_spans.ServiceNamespace AS bServiceNamespace,
          service_overview_spans.DeploymentEnv AS bEnvironment,
          service_overview_spans.CommitSha AS bCommitSha,
          count() AS bSpanCount,
          sum(service_overview_spans.SampleRate) AS bEstimatedSpanCount,
          countIf(service_overview_spans.StatusCode = 'Error') AS bErrorCount,
          sumIf(service_overview_spans.SampleRate, service_overview_spans.StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          min(service_overview_spans.Timestamp) AS bFirstSeen,
          countIf((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration < 500000000)) AS bApdexSatisfiedCount,
          countIf(((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration >= 500000000) AND service_overview_spans.Duration < 2000000000)) AS bApdexToleratingCount
        FROM service_overview_spans
        WHERE service_overview_spans.OrgId = 'org_sql_catalog'
          AND service_overview_spans.Timestamp >= '2026-01-01 10:30:00'
          AND service_overview_spans.Timestamp <= '2026-01-03 14:15:00'
          AND service_overview_spans.DeploymentEnv IN ('production')
          AND service_overview_spans.ServiceNamespace IN ('commerce', 'edge')
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
UNION ALL
SELECT
          service_overview_hourly.Hour AS bBucket,
          service_overview_hourly.ServiceName AS bServiceName,
          service_overview_hourly.ServiceNamespace AS bServiceNamespace,
          service_overview_hourly.DeploymentEnv AS bEnvironment,
          service_overview_hourly.CommitSha AS bCommitSha,
          sum(service_overview_hourly.SpanCount) AS bSpanCount,
          sum(service_overview_hourly.EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(service_overview_hourly.ErrorCount) AS bErrorCount,
          sum(service_overview_hourly.EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(service_overview_hourly.DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          min(service_overview_hourly.FirstSeen) AS bFirstSeen,
          sum(service_overview_hourly.ApdexSatisfiedCount) AS bApdexSatisfiedCount,
          sum(service_overview_hourly.ApdexToleratingCount) AS bApdexToleratingCount
        FROM service_overview_hourly
        WHERE service_overview_hourly.OrgId = 'org_sql_catalog'
          AND service_overview_hourly.DeploymentEnv IN ('production')
          AND service_overview_hourly.ServiceNamespace IN ('commerce', 'edge')
          AND service_overview_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND service_overview_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
) AS service_windows
        GROUP BY cServiceName, cServiceNamespace, cEnvironment, cCommitSha) AS service_commit_rows
        GROUP BY serviceName, environment
        ORDER BY throughput DESC
        LIMIT 500
        FORMAT JSON

-- pipe:service_releases_timeline:default:baseline  [fe16908e]
SELECT
          toStartOfInterval(service_windows.bBucket, INTERVAL 300 SECOND) AS bucket,
          service_windows.bCommitSha AS commitSha,
          sum(service_windows.bSpanCount) AS count,
          sum(service_windows.bErrorCount) AS errorCount
        FROM (
SELECT
          toStartOfMinute(service_overview_spans.Timestamp) AS bBucket,
          service_overview_spans.ServiceName AS bServiceName,
          service_overview_spans.ServiceNamespace AS bServiceNamespace,
          service_overview_spans.DeploymentEnv AS bEnvironment,
          service_overview_spans.CommitSha AS bCommitSha,
          count() AS bSpanCount,
          sum(service_overview_spans.SampleRate) AS bEstimatedSpanCount,
          countIf(service_overview_spans.StatusCode = 'Error') AS bErrorCount,
          sumIf(service_overview_spans.SampleRate, service_overview_spans.StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          min(service_overview_spans.Timestamp) AS bFirstSeen,
          countIf((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration < 500000000)) AS bApdexSatisfiedCount,
          countIf(((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration >= 500000000) AND service_overview_spans.Duration < 2000000000)) AS bApdexToleratingCount
        FROM service_overview_spans
        WHERE service_overview_spans.OrgId = 'org_sql_catalog'
          AND service_overview_spans.Timestamp >= '2026-01-01 10:30:00'
          AND service_overview_spans.Timestamp <= '2026-01-03 14:15:00'
          AND service_overview_spans.ServiceName = 'api'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 MINUTE) OR Timestamp >= toStartOfMinute(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
UNION ALL
SELECT
          service_overview_minutely.Minute AS bBucket,
          service_overview_minutely.ServiceName AS bServiceName,
          service_overview_minutely.ServiceNamespace AS bServiceNamespace,
          service_overview_minutely.DeploymentEnv AS bEnvironment,
          service_overview_minutely.CommitSha AS bCommitSha,
          sum(service_overview_minutely.SpanCount) AS bSpanCount,
          sum(service_overview_minutely.EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(service_overview_minutely.ErrorCount) AS bErrorCount,
          sum(service_overview_minutely.EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(service_overview_minutely.DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          min(service_overview_minutely.FirstSeen) AS bFirstSeen,
          sum(service_overview_minutely.ApdexSatisfiedCount) AS bApdexSatisfiedCount,
          sum(service_overview_minutely.ApdexToleratingCount) AS bApdexToleratingCount
        FROM service_overview_minutely
        WHERE service_overview_minutely.OrgId = 'org_sql_catalog'
          AND service_overview_minutely.ServiceName = 'api'
          AND service_overview_minutely.Minute >= if(toDateTime('2026-01-01 10:30:00') = toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 MINUTE)
          AND service_overview_minutely.Minute < toStartOfMinute(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
) AS service_windows
        WHERE service_windows.bCommitSha != ''
        GROUP BY bucket, commitSha
        ORDER BY bucket ASC
        LIMIT 1000
        FORMAT JSON

-- pipe:services_facets:default:baseline  [5d4f9908]
SELECT
          service_windows.bEnvironment AS name,
          sum(service_windows.bSpanCount) AS count,
          'environment' AS facetType
        FROM (
SELECT
          toStartOfHour(service_overview_spans.Timestamp) AS bBucket,
          service_overview_spans.ServiceName AS bServiceName,
          service_overview_spans.ServiceNamespace AS bServiceNamespace,
          service_overview_spans.DeploymentEnv AS bEnvironment,
          service_overview_spans.CommitSha AS bCommitSha,
          count() AS bSpanCount,
          sum(service_overview_spans.SampleRate) AS bEstimatedSpanCount,
          countIf(service_overview_spans.StatusCode = 'Error') AS bErrorCount,
          sumIf(service_overview_spans.SampleRate, service_overview_spans.StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          min(service_overview_spans.Timestamp) AS bFirstSeen,
          countIf((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration < 500000000)) AS bApdexSatisfiedCount,
          countIf(((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration >= 500000000) AND service_overview_spans.Duration < 2000000000)) AS bApdexToleratingCount
        FROM service_overview_spans
        WHERE service_overview_spans.OrgId = 'org_sql_catalog'
          AND service_overview_spans.Timestamp >= '2026-01-01 10:30:00'
          AND service_overview_spans.Timestamp <= '2026-01-03 14:15:00'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
UNION ALL
SELECT
          service_overview_hourly.Hour AS bBucket,
          service_overview_hourly.ServiceName AS bServiceName,
          service_overview_hourly.ServiceNamespace AS bServiceNamespace,
          service_overview_hourly.DeploymentEnv AS bEnvironment,
          service_overview_hourly.CommitSha AS bCommitSha,
          sum(service_overview_hourly.SpanCount) AS bSpanCount,
          sum(service_overview_hourly.EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(service_overview_hourly.ErrorCount) AS bErrorCount,
          sum(service_overview_hourly.EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(service_overview_hourly.DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          min(service_overview_hourly.FirstSeen) AS bFirstSeen,
          sum(service_overview_hourly.ApdexSatisfiedCount) AS bApdexSatisfiedCount,
          sum(service_overview_hourly.ApdexToleratingCount) AS bApdexToleratingCount
        FROM service_overview_hourly
        WHERE service_overview_hourly.OrgId = 'org_sql_catalog'
          AND service_overview_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND service_overview_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
) AS service_windows
        WHERE service_windows.bEnvironment != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          service_windows.bServiceNamespace AS name,
          sum(service_windows.bSpanCount) AS count,
          'namespace' AS facetType
        FROM (
SELECT
          toStartOfHour(service_overview_spans.Timestamp) AS bBucket,
          service_overview_spans.ServiceName AS bServiceName,
          service_overview_spans.ServiceNamespace AS bServiceNamespace,
          service_overview_spans.DeploymentEnv AS bEnvironment,
          service_overview_spans.CommitSha AS bCommitSha,
          count() AS bSpanCount,
          sum(service_overview_spans.SampleRate) AS bEstimatedSpanCount,
          countIf(service_overview_spans.StatusCode = 'Error') AS bErrorCount,
          sumIf(service_overview_spans.SampleRate, service_overview_spans.StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          min(service_overview_spans.Timestamp) AS bFirstSeen,
          countIf((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration < 500000000)) AS bApdexSatisfiedCount,
          countIf(((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration >= 500000000) AND service_overview_spans.Duration < 2000000000)) AS bApdexToleratingCount
        FROM service_overview_spans
        WHERE service_overview_spans.OrgId = 'org_sql_catalog'
          AND service_overview_spans.Timestamp >= '2026-01-01 10:30:00'
          AND service_overview_spans.Timestamp <= '2026-01-03 14:15:00'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
UNION ALL
SELECT
          service_overview_hourly.Hour AS bBucket,
          service_overview_hourly.ServiceName AS bServiceName,
          service_overview_hourly.ServiceNamespace AS bServiceNamespace,
          service_overview_hourly.DeploymentEnv AS bEnvironment,
          service_overview_hourly.CommitSha AS bCommitSha,
          sum(service_overview_hourly.SpanCount) AS bSpanCount,
          sum(service_overview_hourly.EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(service_overview_hourly.ErrorCount) AS bErrorCount,
          sum(service_overview_hourly.EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(service_overview_hourly.DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          min(service_overview_hourly.FirstSeen) AS bFirstSeen,
          sum(service_overview_hourly.ApdexSatisfiedCount) AS bApdexSatisfiedCount,
          sum(service_overview_hourly.ApdexToleratingCount) AS bApdexToleratingCount
        FROM service_overview_hourly
        WHERE service_overview_hourly.OrgId = 'org_sql_catalog'
          AND service_overview_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND service_overview_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
) AS service_windows
        WHERE service_windows.bServiceNamespace != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          service_windows.bCommitSha AS name,
          sum(service_windows.bSpanCount) AS count,
          'commit_sha' AS facetType
        FROM (
SELECT
          toStartOfHour(service_overview_spans.Timestamp) AS bBucket,
          service_overview_spans.ServiceName AS bServiceName,
          service_overview_spans.ServiceNamespace AS bServiceNamespace,
          service_overview_spans.DeploymentEnv AS bEnvironment,
          service_overview_spans.CommitSha AS bCommitSha,
          count() AS bSpanCount,
          sum(service_overview_spans.SampleRate) AS bEstimatedSpanCount,
          countIf(service_overview_spans.StatusCode = 'Error') AS bErrorCount,
          sumIf(service_overview_spans.SampleRate, service_overview_spans.StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          min(service_overview_spans.Timestamp) AS bFirstSeen,
          countIf((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration < 500000000)) AS bApdexSatisfiedCount,
          countIf(((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration >= 500000000) AND service_overview_spans.Duration < 2000000000)) AS bApdexToleratingCount
        FROM service_overview_spans
        WHERE service_overview_spans.OrgId = 'org_sql_catalog'
          AND service_overview_spans.Timestamp >= '2026-01-01 10:30:00'
          AND service_overview_spans.Timestamp <= '2026-01-03 14:15:00'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
UNION ALL
SELECT
          service_overview_hourly.Hour AS bBucket,
          service_overview_hourly.ServiceName AS bServiceName,
          service_overview_hourly.ServiceNamespace AS bServiceNamespace,
          service_overview_hourly.DeploymentEnv AS bEnvironment,
          service_overview_hourly.CommitSha AS bCommitSha,
          sum(service_overview_hourly.SpanCount) AS bSpanCount,
          sum(service_overview_hourly.EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(service_overview_hourly.ErrorCount) AS bErrorCount,
          sum(service_overview_hourly.EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(service_overview_hourly.DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          min(service_overview_hourly.FirstSeen) AS bFirstSeen,
          sum(service_overview_hourly.ApdexSatisfiedCount) AS bApdexSatisfiedCount,
          sum(service_overview_hourly.ApdexToleratingCount) AS bApdexToleratingCount
        FROM service_overview_hourly
        WHERE service_overview_hourly.OrgId = 'org_sql_catalog'
          AND service_overview_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND service_overview_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
) AS service_windows
        WHERE service_windows.bCommitSha != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          service_windows.bServiceName AS name,
          sum(service_windows.bSpanCount) AS count,
          'service' AS facetType
        FROM (
SELECT
          toStartOfHour(service_overview_spans.Timestamp) AS bBucket,
          service_overview_spans.ServiceName AS bServiceName,
          service_overview_spans.ServiceNamespace AS bServiceNamespace,
          service_overview_spans.DeploymentEnv AS bEnvironment,
          service_overview_spans.CommitSha AS bCommitSha,
          count() AS bSpanCount,
          sum(service_overview_spans.SampleRate) AS bEstimatedSpanCount,
          countIf(service_overview_spans.StatusCode = 'Error') AS bErrorCount,
          sumIf(service_overview_spans.SampleRate, service_overview_spans.StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          min(service_overview_spans.Timestamp) AS bFirstSeen,
          countIf((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration < 500000000)) AS bApdexSatisfiedCount,
          countIf(((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration >= 500000000) AND service_overview_spans.Duration < 2000000000)) AS bApdexToleratingCount
        FROM service_overview_spans
        WHERE service_overview_spans.OrgId = 'org_sql_catalog'
          AND service_overview_spans.Timestamp >= '2026-01-01 10:30:00'
          AND service_overview_spans.Timestamp <= '2026-01-03 14:15:00'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
UNION ALL
SELECT
          service_overview_hourly.Hour AS bBucket,
          service_overview_hourly.ServiceName AS bServiceName,
          service_overview_hourly.ServiceNamespace AS bServiceNamespace,
          service_overview_hourly.DeploymentEnv AS bEnvironment,
          service_overview_hourly.CommitSha AS bCommitSha,
          sum(service_overview_hourly.SpanCount) AS bSpanCount,
          sum(service_overview_hourly.EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(service_overview_hourly.ErrorCount) AS bErrorCount,
          sum(service_overview_hourly.EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(service_overview_hourly.DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          min(service_overview_hourly.FirstSeen) AS bFirstSeen,
          sum(service_overview_hourly.ApdexSatisfiedCount) AS bApdexSatisfiedCount,
          sum(service_overview_hourly.ApdexToleratingCount) AS bApdexToleratingCount
        FROM service_overview_hourly
        WHERE service_overview_hourly.OrgId = 'org_sql_catalog'
          AND service_overview_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND service_overview_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
) AS service_windows
        WHERE service_windows.bServiceName != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
FORMAT JSON

-- pipe:slow_traces:default:baseline  [94ac2455]
SELECT
          trace_list_mv.TraceId AS traceId,
          trace_list_mv.SpanName AS spanName,
          trace_list_mv.ServiceName AS serviceName,
          trace_list_mv.Duration / 1000000 AS durationMs,
          trace_list_mv.StatusCode AS statusCode,
          toString(trace_list_mv.Timestamp) AS timestamp
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.ServiceName = 'api'
          AND trace_list_mv.DeploymentEnv = 'production'
        ORDER BY durationMs DESC
        LIMIT 10
        FORMAT JSON

-- pipe:span_attribute_keys:default:baseline  [585437ff]
SELECT
          attribute_keys_hourly.AttributeKey AS attributeKey,
          sum(attribute_keys_hourly.UsageCount) AS usageCount
        FROM attribute_keys_hourly
        WHERE attribute_keys_hourly.OrgId = 'org_sql_catalog'
          AND attribute_keys_hourly.Hour >= '2026-01-01 10:30:00'
          AND attribute_keys_hourly.Hour <= '2026-01-03 14:15:00'
          AND attribute_keys_hourly.AttributeScope = 'span'
        GROUP BY attributeKey
        ORDER BY usageCount DESC
        LIMIT 200
        FORMAT JSON

-- pipe:span_attribute_keys:default:bloom  [585437ff]
SELECT
          attribute_keys_hourly.AttributeKey AS attributeKey,
          sum(attribute_keys_hourly.UsageCount) AS usageCount
        FROM attribute_keys_hourly
        WHERE attribute_keys_hourly.OrgId = 'org_sql_catalog'
          AND attribute_keys_hourly.Hour >= '2026-01-01 10:30:00'
          AND attribute_keys_hourly.Hour <= '2026-01-03 14:15:00'
          AND attribute_keys_hourly.AttributeScope = 'span'
        GROUP BY attributeKey
        ORDER BY usageCount DESC
        LIMIT 200
        FORMAT JSON

-- pipe:span_attribute_keys:default:text  [585437ff]
SELECT
          attribute_keys_hourly.AttributeKey AS attributeKey,
          sum(attribute_keys_hourly.UsageCount) AS usageCount
        FROM attribute_keys_hourly
        WHERE attribute_keys_hourly.OrgId = 'org_sql_catalog'
          AND attribute_keys_hourly.Hour >= '2026-01-01 10:30:00'
          AND attribute_keys_hourly.Hour <= '2026-01-03 14:15:00'
          AND attribute_keys_hourly.AttributeScope = 'span'
        GROUP BY attributeKey
        ORDER BY usageCount DESC
        LIMIT 200
        FORMAT JSON

-- pipe:span_attribute_values:default:baseline  [c6d7887c]
SELECT
          attribute_values_hourly.AttributeValue AS attributeValue,
          sum(attribute_values_hourly.UsageCount) AS usageCount
        FROM attribute_values_hourly
        WHERE attribute_values_hourly.OrgId = 'org_sql_catalog'
          AND attribute_values_hourly.Hour >= '2026-01-01 10:30:00'
          AND attribute_values_hourly.Hour <= '2026-01-03 14:15:00'
          AND attribute_values_hourly.AttributeScope = 'span'
          AND attribute_values_hourly.AttributeKey = 'http.method'
        GROUP BY attributeValue
        ORDER BY usageCount DESC
        LIMIT 50
        FORMAT JSON

-- pipe:span_attribute_values:default:bloom  [c6d7887c]
SELECT
          attribute_values_hourly.AttributeValue AS attributeValue,
          sum(attribute_values_hourly.UsageCount) AS usageCount
        FROM attribute_values_hourly
        WHERE attribute_values_hourly.OrgId = 'org_sql_catalog'
          AND attribute_values_hourly.Hour >= '2026-01-01 10:30:00'
          AND attribute_values_hourly.Hour <= '2026-01-03 14:15:00'
          AND attribute_values_hourly.AttributeScope = 'span'
          AND attribute_values_hourly.AttributeKey = 'http.method'
        GROUP BY attributeValue
        ORDER BY usageCount DESC
        LIMIT 50
        FORMAT JSON

-- pipe:span_attribute_values:default:text  [c6d7887c]
SELECT
          attribute_values_hourly.AttributeValue AS attributeValue,
          sum(attribute_values_hourly.UsageCount) AS usageCount
        FROM attribute_values_hourly
        WHERE attribute_values_hourly.OrgId = 'org_sql_catalog'
          AND attribute_values_hourly.Hour >= '2026-01-01 10:30:00'
          AND attribute_values_hourly.Hour <= '2026-01-03 14:15:00'
          AND attribute_values_hourly.AttributeScope = 'span'
          AND attribute_values_hourly.AttributeKey = 'http.method'
        GROUP BY attributeValue
        ORDER BY usageCount DESC
        LIMIT 50
        FORMAT JSON

-- pipe:span_hierarchy:unwindowed:baseline  [83e6223f]
SELECT
          trace_detail_spans.TraceId AS traceId,
          trace_detail_spans.SpanId AS spanId,
          trace_detail_spans.ParentSpanId AS parentSpanId,
          if(((trace_detail_spans.SpanName LIKE 'http.server %' OR trace_detail_spans.SpanName IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')) AND (trace_detail_spans.SpanAttributes['http.route'] != '' OR trace_detail_spans.SpanAttributes['url.path'] != '')), concat(if(trace_detail_spans.SpanName LIKE 'http.server %', replaceOne(trace_detail_spans.SpanName, 'http.server ', ''), trace_detail_spans.SpanName), ' ', if(trace_detail_spans.SpanAttributes['http.route'] != '', trace_detail_spans.SpanAttributes['http.route'], trace_detail_spans.SpanAttributes['url.path'])), trace_detail_spans.SpanName) AS spanName,
          trace_detail_spans.ServiceName AS serviceName,
          trace_detail_spans.SpanKind AS spanKind,
          trace_detail_spans.Duration / 1000000 AS durationMs,
          trace_detail_spans.Timestamp AS startTime,
          trace_detail_spans.StatusCode AS statusCode,
          trace_detail_spans.StatusMessage AS statusMessage,
          toJSONString(map('http.method', SpanAttributes['http.method'], 'http.request.method', SpanAttributes['http.request.method'], 'http.route', SpanAttributes['http.route'], 'url.full', SpanAttributes['url.full'], 'http.url', SpanAttributes['http.url'], 'server.address', SpanAttributes['server.address'], 'net.peer.name', SpanAttributes['net.peer.name'], 'url.path', SpanAttributes['url.path'], 'http.target', SpanAttributes['http.target'], 'http.status_code', SpanAttributes['http.status_code'], 'http.response.status_code', SpanAttributes['http.response.status_code'], 'cache.system', SpanAttributes['cache.system'], 'cache.result', SpanAttributes['cache.result'], 'cache.name', SpanAttributes['cache.name'], 'cache.operation', SpanAttributes['cache.operation'], 'cache.lookup_performed', SpanAttributes['cache.lookup_performed'], 'db.system.name', SpanAttributes['db.system.name'], 'db.system', SpanAttributes['db.system'], 'cloud.platform', SpanAttributes['cloud.platform'], 'cloudflare.colo', SpanAttributes['cloudflare.colo'], 'faas.invoked_region', SpanAttributes['faas.invoked_region'], 'cloudflare.outcome', SpanAttributes['cloudflare.outcome'])) AS spanAttributes,
          toJSONString(map('deployment.environment', ResourceAttributes['deployment.environment'], 'vcs.ref.head.revision', ResourceAttributes['vcs.ref.head.revision'])) AS resourceAttributes,
          'related' AS relationship
        FROM trace_detail_spans
        WHERE trace_detail_spans.TraceId = '0af7651916cd43dd8448eb211c80319c'
          AND trace_detail_spans.OrgId = 'org_sql_catalog'
        ORDER BY startTime ASC
        LIMIT 5000
        FORMAT JSON

-- pipe:span_hierarchy:windowed:baseline  [46a6ac94]
SELECT
          trace_detail_spans.TraceId AS traceId,
          trace_detail_spans.SpanId AS spanId,
          trace_detail_spans.ParentSpanId AS parentSpanId,
          if(((trace_detail_spans.SpanName LIKE 'http.server %' OR trace_detail_spans.SpanName IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')) AND (trace_detail_spans.SpanAttributes['http.route'] != '' OR trace_detail_spans.SpanAttributes['url.path'] != '')), concat(if(trace_detail_spans.SpanName LIKE 'http.server %', replaceOne(trace_detail_spans.SpanName, 'http.server ', ''), trace_detail_spans.SpanName), ' ', if(trace_detail_spans.SpanAttributes['http.route'] != '', trace_detail_spans.SpanAttributes['http.route'], trace_detail_spans.SpanAttributes['url.path'])), trace_detail_spans.SpanName) AS spanName,
          trace_detail_spans.ServiceName AS serviceName,
          trace_detail_spans.SpanKind AS spanKind,
          trace_detail_spans.Duration / 1000000 AS durationMs,
          trace_detail_spans.Timestamp AS startTime,
          trace_detail_spans.StatusCode AS statusCode,
          trace_detail_spans.StatusMessage AS statusMessage,
          toJSONString(map('http.method', SpanAttributes['http.method'], 'http.request.method', SpanAttributes['http.request.method'], 'http.route', SpanAttributes['http.route'], 'url.full', SpanAttributes['url.full'], 'http.url', SpanAttributes['http.url'], 'server.address', SpanAttributes['server.address'], 'net.peer.name', SpanAttributes['net.peer.name'], 'url.path', SpanAttributes['url.path'], 'http.target', SpanAttributes['http.target'], 'http.status_code', SpanAttributes['http.status_code'], 'http.response.status_code', SpanAttributes['http.response.status_code'], 'cache.system', SpanAttributes['cache.system'], 'cache.result', SpanAttributes['cache.result'], 'cache.name', SpanAttributes['cache.name'], 'cache.operation', SpanAttributes['cache.operation'], 'cache.lookup_performed', SpanAttributes['cache.lookup_performed'], 'db.system.name', SpanAttributes['db.system.name'], 'db.system', SpanAttributes['db.system'], 'cloud.platform', SpanAttributes['cloud.platform'], 'cloudflare.colo', SpanAttributes['cloudflare.colo'], 'faas.invoked_region', SpanAttributes['faas.invoked_region'], 'cloudflare.outcome', SpanAttributes['cloudflare.outcome'])) AS spanAttributes,
          toJSONString(map('deployment.environment', ResourceAttributes['deployment.environment'], 'vcs.ref.head.revision', ResourceAttributes['vcs.ref.head.revision'])) AS resourceAttributes,
          if(trace_detail_spans.SpanId = '00f067aa0ba902b7', 'target', 'related') AS relationship
        FROM trace_detail_spans
        WHERE trace_detail_spans.TraceId = '0af7651916cd43dd8448eb211c80319c'
          AND trace_detail_spans.OrgId = 'org_sql_catalog'
          AND trace_detail_spans.Timestamp >= '2026-01-01 10:30:00'
          AND trace_detail_spans.Timestamp <= '2026-01-03 14:15:00'
        ORDER BY startTime ASC
        LIMIT 5000
        FORMAT JSON

-- pipe:span_search:default:baseline  [b1656c33]
SELECT
          traces.TraceId AS traceId,
          traces.SpanId AS spanId,
          traces.SpanName AS spanName,
          traces.ServiceName AS serviceName,
          traces.Duration / 1000000 AS durationMs,
          traces.StatusCode AS statusCode,
          traces.StatusMessage AS statusMessage,
          traces.SpanAttributes AS spanAttributes,
          traces.ResourceAttributes AS resourceAttributes,
          toString(traces.Timestamp) AS timestamp
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND traces.Timestamp >= (SELECT min(ts) FROM (SELECT
          traces.Timestamp AS ts
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
        ORDER BY ts DESC
        LIMIT 20))
        ORDER BY timestamp DESC
        LIMIT 20
        FORMAT JSON

-- pipe:span_search:default:bloom  [b1656c33]
SELECT
          traces.TraceId AS traceId,
          traces.SpanId AS spanId,
          traces.SpanName AS spanName,
          traces.ServiceName AS serviceName,
          traces.Duration / 1000000 AS durationMs,
          traces.StatusCode AS statusCode,
          traces.StatusMessage AS statusMessage,
          traces.SpanAttributes AS spanAttributes,
          traces.ResourceAttributes AS resourceAttributes,
          toString(traces.Timestamp) AS timestamp
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND traces.Timestamp >= (SELECT min(ts) FROM (SELECT
          traces.Timestamp AS ts
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
        ORDER BY ts DESC
        LIMIT 20))
        ORDER BY timestamp DESC
        LIMIT 20
        FORMAT JSON

-- pipe:span_search:default:text  [b1656c33]
SELECT
          traces.TraceId AS traceId,
          traces.SpanId AS spanId,
          traces.SpanName AS spanName,
          traces.ServiceName AS serviceName,
          traces.Duration / 1000000 AS durationMs,
          traces.StatusCode AS statusCode,
          traces.StatusMessage AS statusMessage,
          traces.SpanAttributes AS spanAttributes,
          traces.ResourceAttributes AS resourceAttributes,
          toString(traces.Timestamp) AS timestamp
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND traces.Timestamp >= (SELECT min(ts) FROM (SELECT
          traces.Timestamp AS ts
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
        ORDER BY ts DESC
        LIMIT 20))
        ORDER BY timestamp DESC
        LIMIT 20
        FORMAT JSON

-- pipe:top_operations:default:baseline  [02081372]
SELECT
          traces.SpanName AS name,
          ifNull(ifNotFinite(quantile(0.95)(traces.Duration) / 1000000, 0), 0) AS value
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.ServiceName = 'api'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY name
        ORDER BY value DESC
        LIMIT 20
        FORMAT JSON

-- pipe:traces_duration_stats:default:baseline  [2f475047]
SELECT
          minIf(durationMin, traceCount > 0) / 1000000 AS minDurationMs,
          maxIf(durationMax, traceCount > 0) / 1000000 AS maxDurationMs,
          ifNull(ifNotFinite(arrayElement(quantilesTDigestMerge(0.5, 0.95)(durationQuantiles), 1) / 1000000, 0), 0) AS p50DurationMs,
          ifNull(ifNotFinite(arrayElement(quantilesTDigestMerge(0.5, 0.95)(durationQuantiles), 2) / 1000000, 0), 0) AS p95DurationMs
        FROM (
SELECT
          count() AS traceCount,
          min(trace_list_mv.Duration) AS durationMin,
          max(trace_list_mv.Duration) AS durationMax,
          quantilesTDigestState(0.5, 0.95)(Duration) AS durationQuantiles
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
) AS duration_tiers
        FORMAT JSON

-- pipe:traces_facets:attribute-filtered:baseline  [20c35029]
SELECT
          service_tiers.name AS name,
          sum(service_tiers.count) AS count,
          'service' AS facetType
        FROM (
SELECT
          trace_list_mv.ServiceName AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_attr
        WHERE t_attr.TraceId = TraceId
          AND t_attr.OrgId = 'org_sql_catalog'
          AND t_attr.Timestamp >= '2026-01-01 10:30:00'
          AND t_attr.Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(t_attr.SpanAttributes['http.method'], 'GE') > 0)
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_res
        WHERE t_res.TraceId = TraceId
          AND t_res.OrgId = 'org_sql_catalog'
          AND t_res.Timestamp >= '2026-01-01 10:30:00'
          AND t_res.Timestamp <= '2026-01-03 14:15:00'
          AND t_res.ResourceAttributes['host.name'] = 'web')
        GROUP BY name
) AS service_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          spanName_tiers.name AS name,
          sum(spanName_tiers.count) AS count,
          'spanName' AS facetType
        FROM (
SELECT
          trace_list_mv.SpanName AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_attr
        WHERE t_attr.TraceId = TraceId
          AND t_attr.OrgId = 'org_sql_catalog'
          AND t_attr.Timestamp >= '2026-01-01 10:30:00'
          AND t_attr.Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(t_attr.SpanAttributes['http.method'], 'GE') > 0)
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_res
        WHERE t_res.TraceId = TraceId
          AND t_res.OrgId = 'org_sql_catalog'
          AND t_res.Timestamp >= '2026-01-01 10:30:00'
          AND t_res.Timestamp <= '2026-01-03 14:15:00'
          AND t_res.ResourceAttributes['host.name'] = 'web')
          AND trace_list_mv.SpanName != ''
        GROUP BY name
) AS spanName_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          httpMethod_tiers.name AS name,
          sum(httpMethod_tiers.count) AS count,
          'httpMethod' AS facetType
        FROM (
SELECT
          trace_list_mv.HttpMethod AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_attr
        WHERE t_attr.TraceId = TraceId
          AND t_attr.OrgId = 'org_sql_catalog'
          AND t_attr.Timestamp >= '2026-01-01 10:30:00'
          AND t_attr.Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(t_attr.SpanAttributes['http.method'], 'GE') > 0)
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_res
        WHERE t_res.TraceId = TraceId
          AND t_res.OrgId = 'org_sql_catalog'
          AND t_res.Timestamp >= '2026-01-01 10:30:00'
          AND t_res.Timestamp <= '2026-01-03 14:15:00'
          AND t_res.ResourceAttributes['host.name'] = 'web')
          AND trace_list_mv.HttpMethod != ''
        GROUP BY name
) AS httpMethod_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          httpStatus_tiers.name AS name,
          sum(httpStatus_tiers.count) AS count,
          'httpStatus' AS facetType
        FROM (
SELECT
          trace_list_mv.HttpStatusCode AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_attr
        WHERE t_attr.TraceId = TraceId
          AND t_attr.OrgId = 'org_sql_catalog'
          AND t_attr.Timestamp >= '2026-01-01 10:30:00'
          AND t_attr.Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(t_attr.SpanAttributes['http.method'], 'GE') > 0)
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_res
        WHERE t_res.TraceId = TraceId
          AND t_res.OrgId = 'org_sql_catalog'
          AND t_res.Timestamp >= '2026-01-01 10:30:00'
          AND t_res.Timestamp <= '2026-01-03 14:15:00'
          AND t_res.ResourceAttributes['host.name'] = 'web')
          AND trace_list_mv.HttpStatusCode != ''
        GROUP BY name
) AS httpStatus_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          deploymentEnv_tiers.name AS name,
          sum(deploymentEnv_tiers.count) AS count,
          'deploymentEnv' AS facetType
        FROM (
SELECT
          trace_list_mv.DeploymentEnv AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_attr
        WHERE t_attr.TraceId = TraceId
          AND t_attr.OrgId = 'org_sql_catalog'
          AND t_attr.Timestamp >= '2026-01-01 10:30:00'
          AND t_attr.Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(t_attr.SpanAttributes['http.method'], 'GE') > 0)
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_res
        WHERE t_res.TraceId = TraceId
          AND t_res.OrgId = 'org_sql_catalog'
          AND t_res.Timestamp >= '2026-01-01 10:30:00'
          AND t_res.Timestamp <= '2026-01-03 14:15:00'
          AND t_res.ResourceAttributes['host.name'] = 'web')
          AND trace_list_mv.DeploymentEnv != ''
        GROUP BY name
) AS deploymentEnv_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          serviceNamespace_tiers.name AS name,
          sum(serviceNamespace_tiers.count) AS count,
          'serviceNamespace' AS facetType
        FROM (
SELECT
          trace_list_mv.ServiceNamespace AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_attr
        WHERE t_attr.TraceId = TraceId
          AND t_attr.OrgId = 'org_sql_catalog'
          AND t_attr.Timestamp >= '2026-01-01 10:30:00'
          AND t_attr.Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(t_attr.SpanAttributes['http.method'], 'GE') > 0)
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_res
        WHERE t_res.TraceId = TraceId
          AND t_res.OrgId = 'org_sql_catalog'
          AND t_res.Timestamp >= '2026-01-01 10:30:00'
          AND t_res.Timestamp <= '2026-01-03 14:15:00'
          AND t_res.ResourceAttributes['host.name'] = 'web')
          AND trace_list_mv.ServiceNamespace != ''
        GROUP BY name
) AS serviceNamespace_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          'error' AS name,
          sum(errorCount_tiers.count) AS count,
          'errorCount' AS facetType
        FROM (
SELECT
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_attr
        WHERE t_attr.TraceId = TraceId
          AND t_attr.OrgId = 'org_sql_catalog'
          AND t_attr.Timestamp >= '2026-01-01 10:30:00'
          AND t_attr.Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(t_attr.SpanAttributes['http.method'], 'GE') > 0)
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_res
        WHERE t_res.TraceId = TraceId
          AND t_res.OrgId = 'org_sql_catalog'
          AND t_res.Timestamp >= '2026-01-01 10:30:00'
          AND t_res.Timestamp <= '2026-01-03 14:15:00'
          AND t_res.ResourceAttributes['host.name'] = 'web')
          AND trace_list_mv.HasError = 1
) AS errorCount_tiers
FORMAT JSON

-- pipe:traces_facets:attribute-filtered:bloom  [20c35029]
SELECT
          service_tiers.name AS name,
          sum(service_tiers.count) AS count,
          'service' AS facetType
        FROM (
SELECT
          trace_list_mv.ServiceName AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_attr
        WHERE t_attr.TraceId = TraceId
          AND t_attr.OrgId = 'org_sql_catalog'
          AND t_attr.Timestamp >= '2026-01-01 10:30:00'
          AND t_attr.Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(t_attr.SpanAttributes['http.method'], 'GE') > 0)
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_res
        WHERE t_res.TraceId = TraceId
          AND t_res.OrgId = 'org_sql_catalog'
          AND t_res.Timestamp >= '2026-01-01 10:30:00'
          AND t_res.Timestamp <= '2026-01-03 14:15:00'
          AND t_res.ResourceAttributes['host.name'] = 'web')
        GROUP BY name
) AS service_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          spanName_tiers.name AS name,
          sum(spanName_tiers.count) AS count,
          'spanName' AS facetType
        FROM (
SELECT
          trace_list_mv.SpanName AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_attr
        WHERE t_attr.TraceId = TraceId
          AND t_attr.OrgId = 'org_sql_catalog'
          AND t_attr.Timestamp >= '2026-01-01 10:30:00'
          AND t_attr.Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(t_attr.SpanAttributes['http.method'], 'GE') > 0)
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_res
        WHERE t_res.TraceId = TraceId
          AND t_res.OrgId = 'org_sql_catalog'
          AND t_res.Timestamp >= '2026-01-01 10:30:00'
          AND t_res.Timestamp <= '2026-01-03 14:15:00'
          AND t_res.ResourceAttributes['host.name'] = 'web')
          AND trace_list_mv.SpanName != ''
        GROUP BY name
) AS spanName_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          httpMethod_tiers.name AS name,
          sum(httpMethod_tiers.count) AS count,
          'httpMethod' AS facetType
        FROM (
SELECT
          trace_list_mv.HttpMethod AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_attr
        WHERE t_attr.TraceId = TraceId
          AND t_attr.OrgId = 'org_sql_catalog'
          AND t_attr.Timestamp >= '2026-01-01 10:30:00'
          AND t_attr.Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(t_attr.SpanAttributes['http.method'], 'GE') > 0)
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_res
        WHERE t_res.TraceId = TraceId
          AND t_res.OrgId = 'org_sql_catalog'
          AND t_res.Timestamp >= '2026-01-01 10:30:00'
          AND t_res.Timestamp <= '2026-01-03 14:15:00'
          AND t_res.ResourceAttributes['host.name'] = 'web')
          AND trace_list_mv.HttpMethod != ''
        GROUP BY name
) AS httpMethod_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          httpStatus_tiers.name AS name,
          sum(httpStatus_tiers.count) AS count,
          'httpStatus' AS facetType
        FROM (
SELECT
          trace_list_mv.HttpStatusCode AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_attr
        WHERE t_attr.TraceId = TraceId
          AND t_attr.OrgId = 'org_sql_catalog'
          AND t_attr.Timestamp >= '2026-01-01 10:30:00'
          AND t_attr.Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(t_attr.SpanAttributes['http.method'], 'GE') > 0)
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_res
        WHERE t_res.TraceId = TraceId
          AND t_res.OrgId = 'org_sql_catalog'
          AND t_res.Timestamp >= '2026-01-01 10:30:00'
          AND t_res.Timestamp <= '2026-01-03 14:15:00'
          AND t_res.ResourceAttributes['host.name'] = 'web')
          AND trace_list_mv.HttpStatusCode != ''
        GROUP BY name
) AS httpStatus_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          deploymentEnv_tiers.name AS name,
          sum(deploymentEnv_tiers.count) AS count,
          'deploymentEnv' AS facetType
        FROM (
SELECT
          trace_list_mv.DeploymentEnv AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_attr
        WHERE t_attr.TraceId = TraceId
          AND t_attr.OrgId = 'org_sql_catalog'
          AND t_attr.Timestamp >= '2026-01-01 10:30:00'
          AND t_attr.Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(t_attr.SpanAttributes['http.method'], 'GE') > 0)
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_res
        WHERE t_res.TraceId = TraceId
          AND t_res.OrgId = 'org_sql_catalog'
          AND t_res.Timestamp >= '2026-01-01 10:30:00'
          AND t_res.Timestamp <= '2026-01-03 14:15:00'
          AND t_res.ResourceAttributes['host.name'] = 'web')
          AND trace_list_mv.DeploymentEnv != ''
        GROUP BY name
) AS deploymentEnv_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          serviceNamespace_tiers.name AS name,
          sum(serviceNamespace_tiers.count) AS count,
          'serviceNamespace' AS facetType
        FROM (
SELECT
          trace_list_mv.ServiceNamespace AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_attr
        WHERE t_attr.TraceId = TraceId
          AND t_attr.OrgId = 'org_sql_catalog'
          AND t_attr.Timestamp >= '2026-01-01 10:30:00'
          AND t_attr.Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(t_attr.SpanAttributes['http.method'], 'GE') > 0)
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_res
        WHERE t_res.TraceId = TraceId
          AND t_res.OrgId = 'org_sql_catalog'
          AND t_res.Timestamp >= '2026-01-01 10:30:00'
          AND t_res.Timestamp <= '2026-01-03 14:15:00'
          AND t_res.ResourceAttributes['host.name'] = 'web')
          AND trace_list_mv.ServiceNamespace != ''
        GROUP BY name
) AS serviceNamespace_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          'error' AS name,
          sum(errorCount_tiers.count) AS count,
          'errorCount' AS facetType
        FROM (
SELECT
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_attr
        WHERE t_attr.TraceId = TraceId
          AND t_attr.OrgId = 'org_sql_catalog'
          AND t_attr.Timestamp >= '2026-01-01 10:30:00'
          AND t_attr.Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(t_attr.SpanAttributes['http.method'], 'GE') > 0)
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_res
        WHERE t_res.TraceId = TraceId
          AND t_res.OrgId = 'org_sql_catalog'
          AND t_res.Timestamp >= '2026-01-01 10:30:00'
          AND t_res.Timestamp <= '2026-01-03 14:15:00'
          AND t_res.ResourceAttributes['host.name'] = 'web')
          AND trace_list_mv.HasError = 1
) AS errorCount_tiers
FORMAT JSON

-- pipe:traces_facets:attribute-filtered:text  [20c35029]
SELECT
          service_tiers.name AS name,
          sum(service_tiers.count) AS count,
          'service' AS facetType
        FROM (
SELECT
          trace_list_mv.ServiceName AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_attr
        WHERE t_attr.TraceId = TraceId
          AND t_attr.OrgId = 'org_sql_catalog'
          AND t_attr.Timestamp >= '2026-01-01 10:30:00'
          AND t_attr.Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(t_attr.SpanAttributes['http.method'], 'GE') > 0)
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_res
        WHERE t_res.TraceId = TraceId
          AND t_res.OrgId = 'org_sql_catalog'
          AND t_res.Timestamp >= '2026-01-01 10:30:00'
          AND t_res.Timestamp <= '2026-01-03 14:15:00'
          AND t_res.ResourceAttributes['host.name'] = 'web')
        GROUP BY name
) AS service_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          spanName_tiers.name AS name,
          sum(spanName_tiers.count) AS count,
          'spanName' AS facetType
        FROM (
SELECT
          trace_list_mv.SpanName AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_attr
        WHERE t_attr.TraceId = TraceId
          AND t_attr.OrgId = 'org_sql_catalog'
          AND t_attr.Timestamp >= '2026-01-01 10:30:00'
          AND t_attr.Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(t_attr.SpanAttributes['http.method'], 'GE') > 0)
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_res
        WHERE t_res.TraceId = TraceId
          AND t_res.OrgId = 'org_sql_catalog'
          AND t_res.Timestamp >= '2026-01-01 10:30:00'
          AND t_res.Timestamp <= '2026-01-03 14:15:00'
          AND t_res.ResourceAttributes['host.name'] = 'web')
          AND trace_list_mv.SpanName != ''
        GROUP BY name
) AS spanName_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          httpMethod_tiers.name AS name,
          sum(httpMethod_tiers.count) AS count,
          'httpMethod' AS facetType
        FROM (
SELECT
          trace_list_mv.HttpMethod AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_attr
        WHERE t_attr.TraceId = TraceId
          AND t_attr.OrgId = 'org_sql_catalog'
          AND t_attr.Timestamp >= '2026-01-01 10:30:00'
          AND t_attr.Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(t_attr.SpanAttributes['http.method'], 'GE') > 0)
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_res
        WHERE t_res.TraceId = TraceId
          AND t_res.OrgId = 'org_sql_catalog'
          AND t_res.Timestamp >= '2026-01-01 10:30:00'
          AND t_res.Timestamp <= '2026-01-03 14:15:00'
          AND t_res.ResourceAttributes['host.name'] = 'web')
          AND trace_list_mv.HttpMethod != ''
        GROUP BY name
) AS httpMethod_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          httpStatus_tiers.name AS name,
          sum(httpStatus_tiers.count) AS count,
          'httpStatus' AS facetType
        FROM (
SELECT
          trace_list_mv.HttpStatusCode AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_attr
        WHERE t_attr.TraceId = TraceId
          AND t_attr.OrgId = 'org_sql_catalog'
          AND t_attr.Timestamp >= '2026-01-01 10:30:00'
          AND t_attr.Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(t_attr.SpanAttributes['http.method'], 'GE') > 0)
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_res
        WHERE t_res.TraceId = TraceId
          AND t_res.OrgId = 'org_sql_catalog'
          AND t_res.Timestamp >= '2026-01-01 10:30:00'
          AND t_res.Timestamp <= '2026-01-03 14:15:00'
          AND t_res.ResourceAttributes['host.name'] = 'web')
          AND trace_list_mv.HttpStatusCode != ''
        GROUP BY name
) AS httpStatus_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          deploymentEnv_tiers.name AS name,
          sum(deploymentEnv_tiers.count) AS count,
          'deploymentEnv' AS facetType
        FROM (
SELECT
          trace_list_mv.DeploymentEnv AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_attr
        WHERE t_attr.TraceId = TraceId
          AND t_attr.OrgId = 'org_sql_catalog'
          AND t_attr.Timestamp >= '2026-01-01 10:30:00'
          AND t_attr.Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(t_attr.SpanAttributes['http.method'], 'GE') > 0)
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_res
        WHERE t_res.TraceId = TraceId
          AND t_res.OrgId = 'org_sql_catalog'
          AND t_res.Timestamp >= '2026-01-01 10:30:00'
          AND t_res.Timestamp <= '2026-01-03 14:15:00'
          AND t_res.ResourceAttributes['host.name'] = 'web')
          AND trace_list_mv.DeploymentEnv != ''
        GROUP BY name
) AS deploymentEnv_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          serviceNamespace_tiers.name AS name,
          sum(serviceNamespace_tiers.count) AS count,
          'serviceNamespace' AS facetType
        FROM (
SELECT
          trace_list_mv.ServiceNamespace AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_attr
        WHERE t_attr.TraceId = TraceId
          AND t_attr.OrgId = 'org_sql_catalog'
          AND t_attr.Timestamp >= '2026-01-01 10:30:00'
          AND t_attr.Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(t_attr.SpanAttributes['http.method'], 'GE') > 0)
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_res
        WHERE t_res.TraceId = TraceId
          AND t_res.OrgId = 'org_sql_catalog'
          AND t_res.Timestamp >= '2026-01-01 10:30:00'
          AND t_res.Timestamp <= '2026-01-03 14:15:00'
          AND t_res.ResourceAttributes['host.name'] = 'web')
          AND trace_list_mv.ServiceNamespace != ''
        GROUP BY name
) AS serviceNamespace_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          'error' AS name,
          sum(errorCount_tiers.count) AS count,
          'errorCount' AS facetType
        FROM (
SELECT
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_attr
        WHERE t_attr.TraceId = TraceId
          AND t_attr.OrgId = 'org_sql_catalog'
          AND t_attr.Timestamp >= '2026-01-01 10:30:00'
          AND t_attr.Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(t_attr.SpanAttributes['http.method'], 'GE') > 0)
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_res
        WHERE t_res.TraceId = TraceId
          AND t_res.OrgId = 'org_sql_catalog'
          AND t_res.Timestamp >= '2026-01-01 10:30:00'
          AND t_res.Timestamp <= '2026-01-03 14:15:00'
          AND t_res.ResourceAttributes['host.name'] = 'web')
          AND trace_list_mv.HasError = 1
) AS errorCount_tiers
FORMAT JSON

-- pipe:traces_facets:default:baseline  [c4b9c3ca]
SELECT
          service_tiers.name AS name,
          sum(service_tiers.count) AS count,
          'service' AS facetType
        FROM (
SELECT
          trace_list_mv.ServiceName AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY name
) AS service_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          spanName_tiers.name AS name,
          sum(spanName_tiers.count) AS count,
          'spanName' AS facetType
        FROM (
SELECT
          trace_list_mv.SpanName AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.SpanName != ''
        GROUP BY name
) AS spanName_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          httpMethod_tiers.name AS name,
          sum(httpMethod_tiers.count) AS count,
          'httpMethod' AS facetType
        FROM (
SELECT
          trace_list_mv.HttpMethod AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.HttpMethod != ''
        GROUP BY name
) AS httpMethod_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          httpStatus_tiers.name AS name,
          sum(httpStatus_tiers.count) AS count,
          'httpStatus' AS facetType
        FROM (
SELECT
          trace_list_mv.HttpStatusCode AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.HttpStatusCode != ''
        GROUP BY name
) AS httpStatus_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          deploymentEnv_tiers.name AS name,
          sum(deploymentEnv_tiers.count) AS count,
          'deploymentEnv' AS facetType
        FROM (
SELECT
          trace_list_mv.DeploymentEnv AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.DeploymentEnv != ''
        GROUP BY name
) AS deploymentEnv_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          serviceNamespace_tiers.name AS name,
          sum(serviceNamespace_tiers.count) AS count,
          'serviceNamespace' AS facetType
        FROM (
SELECT
          trace_list_mv.ServiceNamespace AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.ServiceNamespace != ''
        GROUP BY name
) AS serviceNamespace_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          'error' AS name,
          sum(errorCount_tiers.count) AS count,
          'errorCount' AS facetType
        FROM (
SELECT
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.HasError = 1
) AS errorCount_tiers
FORMAT JSON

-- pipe:traces_facets:default:bloom  [c4b9c3ca]
SELECT
          service_tiers.name AS name,
          sum(service_tiers.count) AS count,
          'service' AS facetType
        FROM (
SELECT
          trace_list_mv.ServiceName AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY name
) AS service_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          spanName_tiers.name AS name,
          sum(spanName_tiers.count) AS count,
          'spanName' AS facetType
        FROM (
SELECT
          trace_list_mv.SpanName AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.SpanName != ''
        GROUP BY name
) AS spanName_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          httpMethod_tiers.name AS name,
          sum(httpMethod_tiers.count) AS count,
          'httpMethod' AS facetType
        FROM (
SELECT
          trace_list_mv.HttpMethod AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.HttpMethod != ''
        GROUP BY name
) AS httpMethod_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          httpStatus_tiers.name AS name,
          sum(httpStatus_tiers.count) AS count,
          'httpStatus' AS facetType
        FROM (
SELECT
          trace_list_mv.HttpStatusCode AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.HttpStatusCode != ''
        GROUP BY name
) AS httpStatus_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          deploymentEnv_tiers.name AS name,
          sum(deploymentEnv_tiers.count) AS count,
          'deploymentEnv' AS facetType
        FROM (
SELECT
          trace_list_mv.DeploymentEnv AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.DeploymentEnv != ''
        GROUP BY name
) AS deploymentEnv_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          serviceNamespace_tiers.name AS name,
          sum(serviceNamespace_tiers.count) AS count,
          'serviceNamespace' AS facetType
        FROM (
SELECT
          trace_list_mv.ServiceNamespace AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.ServiceNamespace != ''
        GROUP BY name
) AS serviceNamespace_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          'error' AS name,
          sum(errorCount_tiers.count) AS count,
          'errorCount' AS facetType
        FROM (
SELECT
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.HasError = 1
) AS errorCount_tiers
FORMAT JSON

-- pipe:traces_facets:default:text  [c4b9c3ca]
SELECT
          service_tiers.name AS name,
          sum(service_tiers.count) AS count,
          'service' AS facetType
        FROM (
SELECT
          trace_list_mv.ServiceName AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY name
) AS service_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          spanName_tiers.name AS name,
          sum(spanName_tiers.count) AS count,
          'spanName' AS facetType
        FROM (
SELECT
          trace_list_mv.SpanName AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.SpanName != ''
        GROUP BY name
) AS spanName_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          httpMethod_tiers.name AS name,
          sum(httpMethod_tiers.count) AS count,
          'httpMethod' AS facetType
        FROM (
SELECT
          trace_list_mv.HttpMethod AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.HttpMethod != ''
        GROUP BY name
) AS httpMethod_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          httpStatus_tiers.name AS name,
          sum(httpStatus_tiers.count) AS count,
          'httpStatus' AS facetType
        FROM (
SELECT
          trace_list_mv.HttpStatusCode AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.HttpStatusCode != ''
        GROUP BY name
) AS httpStatus_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          deploymentEnv_tiers.name AS name,
          sum(deploymentEnv_tiers.count) AS count,
          'deploymentEnv' AS facetType
        FROM (
SELECT
          trace_list_mv.DeploymentEnv AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.DeploymentEnv != ''
        GROUP BY name
) AS deploymentEnv_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          serviceNamespace_tiers.name AS name,
          sum(serviceNamespace_tiers.count) AS count,
          'serviceNamespace' AS facetType
        FROM (
SELECT
          trace_list_mv.ServiceNamespace AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.ServiceNamespace != ''
        GROUP BY name
) AS serviceNamespace_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          'error' AS name,
          sum(errorCount_tiers.count) AS count,
          'errorCount' AS facetType
        FROM (
SELECT
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.HasError = 1
) AS errorCount_tiers
FORMAT JSON

-- spec:attribute-keys-logs:baseline  [585437ff]
SELECT
          attribute_keys_hourly.AttributeKey AS attributeKey,
          sum(attribute_keys_hourly.UsageCount) AS usageCount
        FROM attribute_keys_hourly
        WHERE attribute_keys_hourly.OrgId = 'org_sql_catalog'
          AND attribute_keys_hourly.Hour >= '2026-01-01 10:30:00'
          AND attribute_keys_hourly.Hour <= '2026-01-03 14:15:00'
          AND attribute_keys_hourly.AttributeScope = 'log'
        GROUP BY attributeKey
        ORDER BY usageCount DESC
        LIMIT 200
        FORMAT JSON

-- spec:attribute-keys-metrics-scoped:baseline  [2efb9cf2]
SELECT
          arrayJoin(mapKeys(metrics_sum.Attributes)) AS attributeKey,
          count() AS usageCount
        FROM metrics_sum
        WHERE metrics_sum.OrgId = 'org_sql_catalog'
          AND metrics_sum.MetricName = 'http.server.requests'
          AND metrics_sum.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_sum.TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY attributeKey
        ORDER BY usageCount DESC
        LIMIT 200
        FORMAT JSON

-- spec:attribute-keys-metrics:baseline  [585437ff]
SELECT
          attribute_keys_hourly.AttributeKey AS attributeKey,
          sum(attribute_keys_hourly.UsageCount) AS usageCount
        FROM attribute_keys_hourly
        WHERE attribute_keys_hourly.OrgId = 'org_sql_catalog'
          AND attribute_keys_hourly.Hour >= '2026-01-01 10:30:00'
          AND attribute_keys_hourly.Hour <= '2026-01-03 14:15:00'
          AND attribute_keys_hourly.AttributeScope = 'metric'
        GROUP BY attributeKey
        ORDER BY usageCount DESC
        LIMIT 200
        FORMAT JSON

-- spec:attribute-keys-product-events:baseline  [30a1e945]
SELECT
          arrayJoin(mapKeys(product_events.Attributes)) AS attributeKey,
          count() AS usageCount
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY attributeKey
        ORDER BY usageCount DESC
        LIMIT 200
        FORMAT JSON

-- spec:attribute-keys-resource:baseline  [585437ff]
SELECT
          attribute_keys_hourly.AttributeKey AS attributeKey,
          sum(attribute_keys_hourly.UsageCount) AS usageCount
        FROM attribute_keys_hourly
        WHERE attribute_keys_hourly.OrgId = 'org_sql_catalog'
          AND attribute_keys_hourly.Hour >= '2026-01-01 10:30:00'
          AND attribute_keys_hourly.Hour <= '2026-01-03 14:15:00'
          AND attribute_keys_hourly.AttributeScope = 'resource'
        GROUP BY attributeKey
        ORDER BY usageCount DESC
        LIMIT 200
        FORMAT JSON

-- spec:attribute-keys-span:baseline  [585437ff]
SELECT
          attribute_keys_hourly.AttributeKey AS attributeKey,
          sum(attribute_keys_hourly.UsageCount) AS usageCount
        FROM attribute_keys_hourly
        WHERE attribute_keys_hourly.OrgId = 'org_sql_catalog'
          AND attribute_keys_hourly.Hour >= '2026-01-01 10:30:00'
          AND attribute_keys_hourly.Hour <= '2026-01-03 14:15:00'
          AND attribute_keys_hourly.AttributeScope = 'span'
        GROUP BY attributeKey
        ORDER BY usageCount DESC
        LIMIT 200
        FORMAT JSON

-- spec:attribute-keys-span:bloom  [585437ff]
SELECT
          attribute_keys_hourly.AttributeKey AS attributeKey,
          sum(attribute_keys_hourly.UsageCount) AS usageCount
        FROM attribute_keys_hourly
        WHERE attribute_keys_hourly.OrgId = 'org_sql_catalog'
          AND attribute_keys_hourly.Hour >= '2026-01-01 10:30:00'
          AND attribute_keys_hourly.Hour <= '2026-01-03 14:15:00'
          AND attribute_keys_hourly.AttributeScope = 'span'
        GROUP BY attributeKey
        ORDER BY usageCount DESC
        LIMIT 200
        FORMAT JSON

-- spec:attribute-keys-span:text  [585437ff]
SELECT
          attribute_keys_hourly.AttributeKey AS attributeKey,
          sum(attribute_keys_hourly.UsageCount) AS usageCount
        FROM attribute_keys_hourly
        WHERE attribute_keys_hourly.OrgId = 'org_sql_catalog'
          AND attribute_keys_hourly.Hour >= '2026-01-01 10:30:00'
          AND attribute_keys_hourly.Hour <= '2026-01-03 14:15:00'
          AND attribute_keys_hourly.AttributeScope = 'span'
        GROUP BY attributeKey
        ORDER BY usageCount DESC
        LIMIT 200
        FORMAT JSON

-- spec:attribute-values-log:baseline  [c6d7887c]
SELECT
          attribute_values_hourly.AttributeValue AS attributeValue,
          sum(attribute_values_hourly.UsageCount) AS usageCount
        FROM attribute_values_hourly
        WHERE attribute_values_hourly.OrgId = 'org_sql_catalog'
          AND attribute_values_hourly.Hour >= '2026-01-01 10:30:00'
          AND attribute_values_hourly.Hour <= '2026-01-03 14:15:00'
          AND attribute_values_hourly.AttributeScope = 'log'
          AND attribute_values_hourly.AttributeKey = 'log.level'
        GROUP BY attributeValue
        ORDER BY usageCount DESC
        LIMIT 50
        FORMAT JSON

-- spec:attribute-values-metrics-scoped:baseline  [eff9022f]
SELECT
          metrics_sum.Attributes['http.route'] AS attributeValue,
          count() AS usageCount
        FROM metrics_sum
        WHERE metrics_sum.OrgId = 'org_sql_catalog'
          AND metrics_sum.MetricName = 'http.server.requests'
          AND metrics_sum.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_sum.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_sum.Attributes['http.route'] != ''
        GROUP BY attributeValue
        ORDER BY usageCount DESC
        LIMIT 50
        FORMAT JSON

-- spec:attribute-values-metrics:baseline  [c6d7887c]
SELECT
          attribute_values_hourly.AttributeValue AS attributeValue,
          sum(attribute_values_hourly.UsageCount) AS usageCount
        FROM attribute_values_hourly
        WHERE attribute_values_hourly.OrgId = 'org_sql_catalog'
          AND attribute_values_hourly.Hour >= '2026-01-01 10:30:00'
          AND attribute_values_hourly.Hour <= '2026-01-03 14:15:00'
          AND attribute_values_hourly.AttributeScope = 'metric'
          AND attribute_values_hourly.AttributeKey = 'http.route'
        GROUP BY attributeValue
        ORDER BY usageCount DESC
        LIMIT 50
        FORMAT JSON

-- spec:attribute-values-product-events:baseline  [0dd2a379]
SELECT
          product_events.Attributes['plan'] AS attributeValue,
          count() AS usageCount
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND has(mapKeys(product_events.Attributes), 'plan')
        GROUP BY attributeValue
        ORDER BY usageCount DESC
        LIMIT 50
        FORMAT JSON

-- spec:attribute-values-span:baseline  [c6d7887c]
SELECT
          attribute_values_hourly.AttributeValue AS attributeValue,
          sum(attribute_values_hourly.UsageCount) AS usageCount
        FROM attribute_values_hourly
        WHERE attribute_values_hourly.OrgId = 'org_sql_catalog'
          AND attribute_values_hourly.Hour >= '2026-01-01 10:30:00'
          AND attribute_values_hourly.Hour <= '2026-01-03 14:15:00'
          AND attribute_values_hourly.AttributeScope = 'span'
          AND attribute_values_hourly.AttributeKey = 'http.method'
        GROUP BY attributeValue
        ORDER BY usageCount DESC
        LIMIT 50
        FORMAT JSON

-- spec:attribute-values-span:bloom  [c6d7887c]
SELECT
          attribute_values_hourly.AttributeValue AS attributeValue,
          sum(attribute_values_hourly.UsageCount) AS usageCount
        FROM attribute_values_hourly
        WHERE attribute_values_hourly.OrgId = 'org_sql_catalog'
          AND attribute_values_hourly.Hour >= '2026-01-01 10:30:00'
          AND attribute_values_hourly.Hour <= '2026-01-03 14:15:00'
          AND attribute_values_hourly.AttributeScope = 'span'
          AND attribute_values_hourly.AttributeKey = 'http.method'
        GROUP BY attributeValue
        ORDER BY usageCount DESC
        LIMIT 50
        FORMAT JSON

-- spec:attribute-values-span:text  [c6d7887c]
SELECT
          attribute_values_hourly.AttributeValue AS attributeValue,
          sum(attribute_values_hourly.UsageCount) AS usageCount
        FROM attribute_values_hourly
        WHERE attribute_values_hourly.OrgId = 'org_sql_catalog'
          AND attribute_values_hourly.Hour >= '2026-01-01 10:30:00'
          AND attribute_values_hourly.Hour <= '2026-01-03 14:15:00'
          AND attribute_values_hourly.AttributeScope = 'span'
          AND attribute_values_hourly.AttributeKey = 'http.method'
        GROUP BY attributeValue
        ORDER BY usageCount DESC
        LIMIT 50
        FORMAT JSON

-- spec:errors-facets:baseline  [6182994a]
SELECT
          error_events_by_time.ServiceName AS name,
          uniq(error_events_by_time.FingerprintHash) AS count,
          'service' AS facetType
        FROM error_events_by_time
        WHERE error_events_by_time.OrgId = 'org_sql_catalog'
          AND error_events_by_time.Timestamp >= '2026-01-01 10:30:00'
          AND error_events_by_time.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY name
        ORDER BY count DESC
        LIMIT 100
UNION ALL
SELECT
          error_events_by_time.DeploymentEnv AS name,
          uniq(error_events_by_time.FingerprintHash) AS count,
          'environment' AS facetType
        FROM error_events_by_time
        WHERE error_events_by_time.OrgId = 'org_sql_catalog'
          AND error_events_by_time.Timestamp >= '2026-01-01 10:30:00'
          AND error_events_by_time.Timestamp <= '2026-01-03 14:15:00'
          AND error_events_by_time.DeploymentEnv != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 100
UNION ALL
SELECT
          error_events_by_time.ErrorLabel AS name,
          uniq(error_events_by_time.FingerprintHash) AS count,
          'error_type' AS facetType
        FROM error_events_by_time
        WHERE error_events_by_time.OrgId = 'org_sql_catalog'
          AND error_events_by_time.Timestamp >= '2026-01-01 10:30:00'
          AND error_events_by_time.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          error_events_by_time.ServiceVersion AS name,
          uniq(error_events_by_time.FingerprintHash) AS count,
          'version' AS facetType
        FROM error_events_by_time
        WHERE error_events_by_time.OrgId = 'org_sql_catalog'
          AND error_events_by_time.Timestamp >= '2026-01-01 10:30:00'
          AND error_events_by_time.Timestamp <= '2026-01-03 14:15:00'
          AND error_events_by_time.ServiceVersion != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
FORMAT JSON

-- spec:logs-breakdown:baseline  [bf6a9f8a]
SELECT
          breakdown.name AS name,
          sum(breakdown.count) AS count
        FROM (
SELECT
          logs.SeverityText AS name,
          count() AS count
        FROM logs
        WHERE logs.OrgId = 'org_sql_catalog'
          AND logs.TimestampTime >= '2026-01-01 10:30:00'
          AND logs.TimestampTime <= '2026-01-03 14:15:00'
          AND logs.Timestamp >= '2026-01-01 10:30:00'
          AND logs.Timestamp <= '2026-01-03 14:15:00'
          AND (TimestampTime < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR TimestampTime >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND logs.ServiceName = 'api'
        GROUP BY name
UNION ALL
SELECT
          logs_aggregates_hourly.SeverityText AS name,
          sum(logs_aggregates_hourly.Count) AS count
        FROM logs_aggregates_hourly
        WHERE logs_aggregates_hourly.OrgId = 'org_sql_catalog'
          AND logs_aggregates_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND logs_aggregates_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND logs_aggregates_hourly.ServiceName = 'api'
        GROUP BY name
) AS breakdown
        GROUP BY name
        ORDER BY count DESC
        LIMIT 10
        FORMAT JSON

-- spec:logs-count:baseline  [e13a81fc]
SELECT
          sum(counts.total) AS total
        FROM (
SELECT
          count() AS total
        FROM logs
        WHERE logs.OrgId = 'org_sql_catalog'
          AND logs.TimestampTime >= '2026-01-01 10:30:00'
          AND logs.TimestampTime <= '2026-01-03 14:15:00'
          AND logs.Timestamp >= '2026-01-01 10:30:00'
          AND logs.Timestamp <= '2026-01-03 14:15:00'
          AND (TimestampTime < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR TimestampTime >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND logs.ServiceName = 'api'
UNION ALL
SELECT
          sum(logs_aggregates_hourly.Count) AS total
        FROM logs_aggregates_hourly
        WHERE logs_aggregates_hourly.OrgId = 'org_sql_catalog'
          AND logs_aggregates_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND logs_aggregates_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND logs_aggregates_hourly.ServiceName = 'api'
) AS counts
        FORMAT JSON

-- spec:logs-count:bloom  [e13a81fc]
SELECT
          sum(counts.total) AS total
        FROM (
SELECT
          count() AS total
        FROM logs
        WHERE logs.OrgId = 'org_sql_catalog'
          AND logs.TimestampTime >= '2026-01-01 10:30:00'
          AND logs.TimestampTime <= '2026-01-03 14:15:00'
          AND logs.Timestamp >= '2026-01-01 10:30:00'
          AND logs.Timestamp <= '2026-01-03 14:15:00'
          AND (TimestampTime < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR TimestampTime >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND logs.ServiceName = 'api'
UNION ALL
SELECT
          sum(logs_aggregates_hourly.Count) AS total
        FROM logs_aggregates_hourly
        WHERE logs_aggregates_hourly.OrgId = 'org_sql_catalog'
          AND logs_aggregates_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND logs_aggregates_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND logs_aggregates_hourly.ServiceName = 'api'
) AS counts
        FORMAT JSON

-- spec:logs-count:text  [e13a81fc]
SELECT
          sum(counts.total) AS total
        FROM (
SELECT
          count() AS total
        FROM logs
        WHERE logs.OrgId = 'org_sql_catalog'
          AND logs.TimestampTime >= '2026-01-01 10:30:00'
          AND logs.TimestampTime <= '2026-01-03 14:15:00'
          AND logs.Timestamp >= '2026-01-01 10:30:00'
          AND logs.Timestamp <= '2026-01-03 14:15:00'
          AND (TimestampTime < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR TimestampTime >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND logs.ServiceName = 'api'
UNION ALL
SELECT
          sum(logs_aggregates_hourly.Count) AS total
        FROM logs_aggregates_hourly
        WHERE logs_aggregates_hourly.OrgId = 'org_sql_catalog'
          AND logs_aggregates_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND logs_aggregates_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND logs_aggregates_hourly.ServiceName = 'api'
) AS counts
        FORMAT JSON

-- spec:logs-facets-single-dimension:baseline  [a2c524c2]
SELECT * FROM (
SELECT
          logs_aggregates_hourly.SeverityText AS severityText,
          '' AS serviceName,
          '' AS deploymentEnv,
          '' AS namespace,
          sum(logs_aggregates_hourly.Count) AS count,
          'severity' AS facetType
        FROM logs_aggregates_hourly
        WHERE logs_aggregates_hourly.OrgId = 'org_sql_catalog'
          AND logs_aggregates_hourly.Hour >= '2026-01-01 10:30:00'
          AND logs_aggregates_hourly.Hour <= '2026-01-03 14:15:00'
        GROUP BY severityText
)
ORDER BY count DESC
LIMIT 500
FORMAT JSON

-- spec:logs-facets:baseline  [637a8191]
SELECT * FROM (
SELECT
          logs_aggregates_hourly.SeverityText AS severityText,
          '' AS serviceName,
          '' AS deploymentEnv,
          '' AS namespace,
          sum(logs_aggregates_hourly.Count) AS count,
          'severity' AS facetType
        FROM logs_aggregates_hourly
        WHERE logs_aggregates_hourly.OrgId = 'org_sql_catalog'
          AND logs_aggregates_hourly.Hour >= '2026-01-01 10:30:00'
          AND logs_aggregates_hourly.Hour <= '2026-01-03 14:15:00'
          AND logs_aggregates_hourly.ServiceName = 'api'
        GROUP BY severityText
UNION ALL
SELECT
          '' AS severityText,
          logs_aggregates_hourly.ServiceName AS serviceName,
          '' AS deploymentEnv,
          '' AS namespace,
          sum(logs_aggregates_hourly.Count) AS count,
          'service' AS facetType
        FROM logs_aggregates_hourly
        WHERE logs_aggregates_hourly.OrgId = 'org_sql_catalog'
          AND logs_aggregates_hourly.Hour >= '2026-01-01 10:30:00'
          AND logs_aggregates_hourly.Hour <= '2026-01-03 14:15:00'
          AND logs_aggregates_hourly.ServiceName = 'api'
        GROUP BY serviceName
UNION ALL
SELECT
          '' AS severityText,
          '' AS serviceName,
          logs_aggregates_hourly.DeploymentEnv AS deploymentEnv,
          '' AS namespace,
          sum(logs_aggregates_hourly.Count) AS count,
          'deploymentEnv' AS facetType
        FROM logs_aggregates_hourly
        WHERE logs_aggregates_hourly.OrgId = 'org_sql_catalog'
          AND logs_aggregates_hourly.Hour >= '2026-01-01 10:30:00'
          AND logs_aggregates_hourly.Hour <= '2026-01-03 14:15:00'
          AND logs_aggregates_hourly.ServiceName = 'api'
          AND logs_aggregates_hourly.DeploymentEnv != ''
        GROUP BY deploymentEnv
UNION ALL
SELECT
          '' AS severityText,
          '' AS serviceName,
          '' AS deploymentEnv,
          logs_aggregates_hourly.ServiceNamespace AS namespace,
          sum(logs_aggregates_hourly.Count) AS count,
          'namespace' AS facetType
        FROM logs_aggregates_hourly
        WHERE logs_aggregates_hourly.OrgId = 'org_sql_catalog'
          AND logs_aggregates_hourly.Hour >= '2026-01-01 10:30:00'
          AND logs_aggregates_hourly.Hour <= '2026-01-03 14:15:00'
          AND logs_aggregates_hourly.ServiceName = 'api'
          AND logs_aggregates_hourly.ServiceNamespace != ''
        GROUP BY namespace
)
ORDER BY count DESC
LIMIT 500
FORMAT JSON

-- spec:logs-timeseries-grouped:baseline  [c7d52935]
SELECT
          bucket AS bucket,
          groupName AS groupName,
          count AS count
        FROM (SELECT
          bucket AS bucket,
          groupName AS groupName,
          count AS count,
          dense_rank() OVER (ORDER BY __series_peak DESC, groupName ASC) AS __series_rank
        FROM (SELECT
          bucket AS bucket,
          groupName AS groupName,
          count AS count,
          max(count) OVER (PARTITION BY groupName) AS __series_peak
        FROM (SELECT
          toStartOfInterval(logs.Timestamp, INTERVAL 60 SECOND) AS bucket,
          coalesce(nullIf(toString(logs.SeverityText), ''), 'all') AS groupName,
          count() AS count
        FROM logs
        WHERE logs.OrgId = 'org_sql_catalog'
          AND logs.TimestampTime >= '2026-01-03 10:30:00'
          AND logs.TimestampTime <= '2026-01-03 14:15:00'
          AND logs.Timestamp >= '2026-01-03 10:30:00'
          AND logs.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY bucket, groupName) AS __series_base) AS __series_peaks) AS __series_ranked
        WHERE __series_rank <= 5
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- spec:logs-timeseries:baseline  [36c75764]
SELECT
          toStartOfInterval(logs_aggregates_hourly.Hour, INTERVAL 3600 SECOND) AS bucket,
          'all' AS groupName,
          sum(logs_aggregates_hourly.Count) AS count
        FROM logs_aggregates_hourly
        WHERE logs_aggregates_hourly.OrgId = 'org_sql_catalog'
          AND logs_aggregates_hourly.Hour >= '2026-01-01 10:30:00'
          AND logs_aggregates_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND logs_aggregates_hourly.ServiceName = 'api'
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- spec:logs-timeseries:bloom  [36c75764]
SELECT
          toStartOfInterval(logs_aggregates_hourly.Hour, INTERVAL 3600 SECOND) AS bucket,
          'all' AS groupName,
          sum(logs_aggregates_hourly.Count) AS count
        FROM logs_aggregates_hourly
        WHERE logs_aggregates_hourly.OrgId = 'org_sql_catalog'
          AND logs_aggregates_hourly.Hour >= '2026-01-01 10:30:00'
          AND logs_aggregates_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND logs_aggregates_hourly.ServiceName = 'api'
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- spec:logs-timeseries:text  [36c75764]
SELECT
          toStartOfInterval(logs_aggregates_hourly.Hour, INTERVAL 3600 SECOND) AS bucket,
          'all' AS groupName,
          sum(logs_aggregates_hourly.Count) AS count
        FROM logs_aggregates_hourly
        WHERE logs_aggregates_hourly.OrgId = 'org_sql_catalog'
          AND logs_aggregates_hourly.Hour >= '2026-01-01 10:30:00'
          AND logs_aggregates_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND logs_aggregates_hourly.ServiceName = 'api'
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- spec:metrics-breakdown:baseline  [bc31907a]
SELECT
          metrics_histogram.ServiceName AS name,
          ifNull(ifNotFinite(sum(metrics_histogram.Sum) / sum(metrics_histogram.Count), 0), 0) AS avgValue,
          ifNull(min(metrics_histogram.Min), 0) AS minValue,
          ifNull(max(metrics_histogram.Max), 0) AS maxValue,
          sum(metrics_histogram.Sum) AS sumValue,
          sum(metrics_histogram.Count) AS count
        FROM metrics_histogram
        WHERE metrics_histogram.MetricName = 'http.server.request.duration'
          AND metrics_histogram.OrgId = 'org_sql_catalog'
          AND metrics_histogram.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_histogram.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_histogram.ServiceName = 'api'
        GROUP BY name
        ORDER BY avgValue DESC
        LIMIT 10
        FORMAT JSON

-- spec:metrics-sparklines:baseline  [f220d493]
SELECT
          toStartOfInterval(metrics_sum.TimeUnix, INTERVAL 3600 SECOND) AS bucket,
          metrics_sum.MetricName AS metricName,
          ifNull(ifNotFinite(avg(metrics_sum.Value), 0), 0) AS avgValue,
          sum(metrics_sum.Value) AS sumValue,
          count() AS dataPointCount
        FROM metrics_sum
        WHERE metrics_sum.MetricName IN ('http.server.requests', 'rpc.server.duration')
          AND metrics_sum.OrgId = 'org_sql_catalog'
          AND metrics_sum.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_sum.TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY bucket, metricName
        ORDER BY bucket ASC
        FORMAT JSON

-- spec:metrics-timeseries-grouped-by-attribute:baseline  [60a5bdfa]
SELECT
          toStartOfInterval(metrics_histogram.TimeUnix, INTERVAL 300 SECOND) AS bucket,
          metrics_histogram.ServiceName AS serviceName,
          metrics_histogram.Attributes['http.route'] AS attributeValue,
          metrics_histogram.Attributes['http.route'] AS groupName,
          ifNull(ifNotFinite(sum(metrics_histogram.Sum) / sum(metrics_histogram.Count), 0), 0) AS avgValue,
          ifNull(min(metrics_histogram.Min), 0) AS minValue,
          ifNull(max(metrics_histogram.Max), 0) AS maxValue,
          sum(metrics_histogram.Sum) AS sumValue,
          sum(metrics_histogram.Count) AS dataPointCount
        FROM metrics_histogram
        WHERE metrics_histogram.MetricName = 'http.server.request.duration'
          AND metrics_histogram.OrgId = 'org_sql_catalog'
          AND metrics_histogram.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_histogram.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_histogram.ServiceName = 'api'
        GROUP BY bucket, serviceName, attributeValue
        ORDER BY bucket ASC
        FORMAT JSON

-- spec:metrics-timeseries-grouped-by-resource:baseline  [d6a11b76]
SELECT
          toStartOfInterval(metrics_histogram.TimeUnix, INTERVAL 300 SECOND) AS bucket,
          metrics_histogram.ServiceName AS serviceName,
          metrics_histogram.ResourceAttributes['host.name'] AS attributeValue,
          metrics_histogram.ResourceAttributes['host.name'] AS groupName,
          ifNull(ifNotFinite(sum(metrics_histogram.Sum) / sum(metrics_histogram.Count), 0), 0) AS avgValue,
          ifNull(min(metrics_histogram.Min), 0) AS minValue,
          ifNull(max(metrics_histogram.Max), 0) AS maxValue,
          sum(metrics_histogram.Sum) AS sumValue,
          sum(metrics_histogram.Count) AS dataPointCount
        FROM metrics_histogram
        WHERE metrics_histogram.MetricName = 'http.server.request.duration'
          AND metrics_histogram.OrgId = 'org_sql_catalog'
          AND metrics_histogram.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_histogram.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_histogram.ServiceName = 'api'
        GROUP BY bucket, serviceName, attributeValue
        ORDER BY bucket ASC
        FORMAT JSON

-- spec:metrics-timeseries-rate:baseline  [6edd2ce8]
WITH with_deltas AS (
SELECT
          metrics_sum.TimeUnix AS TimeUnix,
          metrics_sum.ServiceName AS ServiceName,
          metrics_sum.Attributes AS Attributes,
          '' AS resourceAttributeValue,
          multiIf(AggregationTemporality = 1, metrics_sum.Value, metrics_sum.Value < lagInFrame(metrics_sum.Value, 1, metrics_sum.Value) OVER (PARTITION BY metrics_sum.ServiceName, metrics_sum.MetricName, cityHash64(mapKeys(metrics_sum.Attributes), mapValues(metrics_sum.Attributes)), cityHash64(mapKeys(metrics_sum.ResourceAttributes), mapValues(metrics_sum.ResourceAttributes)) ORDER BY metrics_sum.TimeUnix ASC ROWS BETWEEN 1 PRECEDING AND CURRENT ROW), metrics_sum.Value, (metrics_sum.StartTimeUnix > lagInFrame(metrics_sum.TimeUnix, 1, metrics_sum.TimeUnix) OVER (PARTITION BY metrics_sum.ServiceName, metrics_sum.MetricName, cityHash64(mapKeys(metrics_sum.Attributes), mapValues(metrics_sum.Attributes)), cityHash64(mapKeys(metrics_sum.ResourceAttributes), mapValues(metrics_sum.ResourceAttributes)) ORDER BY metrics_sum.TimeUnix ASC ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AND metrics_sum.StartTimeUnix < metrics_sum.TimeUnix), metrics_sum.Value, metrics_sum.Value - lagInFrame(metrics_sum.Value, 1, metrics_sum.Value) OVER (PARTITION BY metrics_sum.ServiceName, metrics_sum.MetricName, cityHash64(mapKeys(metrics_sum.Attributes), mapValues(metrics_sum.Attributes)), cityHash64(mapKeys(metrics_sum.ResourceAttributes), mapValues(metrics_sum.ResourceAttributes)) ORDER BY metrics_sum.TimeUnix ASC ROWS BETWEEN 1 PRECEDING AND CURRENT ROW)) AS delta
        FROM metrics_sum
        WHERE metrics_sum.MetricName = 'http.server.requests'
          AND metrics_sum.OrgId = 'org_sql_catalog'
          AND metrics_sum.TimeUnix >= '2026-01-01 10:30:00' - INTERVAL 3600 SECOND
          AND metrics_sum.TimeUnix <= '2026-01-03 14:15:00'
)
SELECT
          toStartOfInterval(with_deltas.TimeUnix, INTERVAL 3600 SECOND) AS bucket,
          with_deltas.ServiceName AS serviceName,
          '' AS attributeValue,
          with_deltas.ServiceName AS groupName,
          ifNull(ifNotFinite(sum(with_deltas.delta) / min(least(toUnixTimestamp(toStartOfInterval(with_deltas.TimeUnix, INTERVAL 3600 SECOND)) + 3600, toUnixTimestamp(toDateTime('2026-01-03 14:15:00'))) - greatest(toUnixTimestamp(toStartOfInterval(with_deltas.TimeUnix, INTERVAL 3600 SECOND)), toUnixTimestamp(toDateTime('2026-01-01 10:30:00')))), 0), 0) AS rateValue,
          sum(with_deltas.delta) AS increaseValue,
          count() AS dataPointCount
        FROM with_deltas
        WHERE with_deltas.TimeUnix >= '2026-01-01 10:30:00'
        GROUP BY bucket, serviceName
        ORDER BY bucket ASC
        FORMAT JSON

-- spec:metrics-timeseries:baseline  [013da770]
SELECT
          toStartOfInterval(metrics_histogram.TimeUnix, INTERVAL 3600 SECOND) AS bucket,
          metrics_histogram.ServiceName AS serviceName,
          '' AS attributeValue,
          metrics_histogram.ServiceName AS groupName,
          ifNull(ifNotFinite(sum(metrics_histogram.Sum) / sum(metrics_histogram.Count), 0), 0) AS avgValue,
          ifNull(min(metrics_histogram.Min), 0) AS minValue,
          ifNull(max(metrics_histogram.Max), 0) AS maxValue,
          sum(metrics_histogram.Sum) AS sumValue,
          sum(metrics_histogram.Count) AS dataPointCount
        FROM metrics_histogram
        WHERE metrics_histogram.MetricName = 'http.server.request.duration'
          AND metrics_histogram.OrgId = 'org_sql_catalog'
          AND metrics_histogram.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_histogram.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_histogram.ServiceName = 'api'
        GROUP BY bucket, serviceName
        ORDER BY bucket ASC
        FORMAT JSON

-- spec:product-events-breakdown:baseline  [18d4c17c]
SELECT
          product_events.PagePath AS name,
          uniqIf(product_events.SessionId, product_events.SessionId != '') AS value
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Host IN ('maple.dev')
        GROUP BY name
        ORDER BY value DESC, name ASC
        LIMIT 25
        FORMAT JSON

-- spec:product-events-list:baseline  [e62f8b65]
SELECT
          product_events.Timestamp AS timestamp,
          product_events.EventName AS eventName,
          product_events.Kind AS kind,
          product_events.Source AS source,
          product_events.Host AS host,
          product_events.PagePath AS pagePath,
          product_events.Url AS url,
          product_events.ServiceName AS serviceName,
          product_events.UserId AS userId,
          product_events.GroupId AS groupId,
          product_events.VisitorId AS visitorId,
          product_events.SessionId AS sessionId,
          product_events.TraceId AS traceId,
          product_events.SpanId AS spanId,
          product_events.Attributes AS attributes,
          product_events.Seq AS seq
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.Kind IN ('custom')
        ORDER BY timestamp DESC, seq DESC
        LIMIT 50
        FORMAT JSON

-- spec:product-events-timeseries-grouped:baseline  [8a641280]
SELECT
          bucket AS bucket,
          groupName AS groupName,
          value AS value,
          eventCount AS eventCount
        FROM (SELECT
          bucket AS bucket,
          groupName AS groupName,
          value AS value,
          eventCount AS eventCount,
          dense_rank() OVER (ORDER BY __series_peak DESC, groupName ASC) AS __series_rank
        FROM (SELECT
          bucket AS bucket,
          groupName AS groupName,
          value AS value,
          eventCount AS eventCount,
          max(value) OVER (PARTITION BY groupName) AS __series_peak
        FROM (SELECT
          toStartOfInterval(product_events.Timestamp, INTERVAL 60 SECOND) AS bucket,
          arrayStringConcat([coalesce(nullIf(product_events.EventName, ''), '(none)'), coalesce(nullIf(product_events.Attributes['plan'], ''), '(none)')], ' · ') AS groupName,
          uniqIf(if(product_events.UserId != '', product_events.UserId, product_events.VisitorId), (product_events.UserId != '' OR product_events.VisitorId != '')) AS value,
          count() AS eventCount
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-03 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.SessionId IN (SELECT
          session_replays.SessionId AS sessionId
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= '2026-01-03 10:30:00'
          AND session_replays.StartTime <= '2026-01-03 14:15:00'
          AND session_replays.Country = 'DE'
        GROUP BY sessionId)
        GROUP BY bucket, groupName) AS __series_base) AS __series_peaks) AS __series_ranked
        WHERE __series_rank <= 5
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- spec:product-events-timeseries:baseline  [f222a9d9]
SELECT
          toStartOfInterval(product_events.Timestamp, INTERVAL 3600 SECOND) AS bucket,
          'all' AS groupName,
          count() AS value,
          count() AS eventCount
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= '2026-01-01 10:30:00'
          AND product_events.Timestamp <= '2026-01-03 14:15:00'
          AND product_events.EventName IN ('signup_completed')
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- spec:services-facets:baseline  [5d4f9908]
SELECT
          service_windows.bEnvironment AS name,
          sum(service_windows.bSpanCount) AS count,
          'environment' AS facetType
        FROM (
SELECT
          toStartOfHour(service_overview_spans.Timestamp) AS bBucket,
          service_overview_spans.ServiceName AS bServiceName,
          service_overview_spans.ServiceNamespace AS bServiceNamespace,
          service_overview_spans.DeploymentEnv AS bEnvironment,
          service_overview_spans.CommitSha AS bCommitSha,
          count() AS bSpanCount,
          sum(service_overview_spans.SampleRate) AS bEstimatedSpanCount,
          countIf(service_overview_spans.StatusCode = 'Error') AS bErrorCount,
          sumIf(service_overview_spans.SampleRate, service_overview_spans.StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          min(service_overview_spans.Timestamp) AS bFirstSeen,
          countIf((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration < 500000000)) AS bApdexSatisfiedCount,
          countIf(((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration >= 500000000) AND service_overview_spans.Duration < 2000000000)) AS bApdexToleratingCount
        FROM service_overview_spans
        WHERE service_overview_spans.OrgId = 'org_sql_catalog'
          AND service_overview_spans.Timestamp >= '2026-01-01 10:30:00'
          AND service_overview_spans.Timestamp <= '2026-01-03 14:15:00'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
UNION ALL
SELECT
          service_overview_hourly.Hour AS bBucket,
          service_overview_hourly.ServiceName AS bServiceName,
          service_overview_hourly.ServiceNamespace AS bServiceNamespace,
          service_overview_hourly.DeploymentEnv AS bEnvironment,
          service_overview_hourly.CommitSha AS bCommitSha,
          sum(service_overview_hourly.SpanCount) AS bSpanCount,
          sum(service_overview_hourly.EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(service_overview_hourly.ErrorCount) AS bErrorCount,
          sum(service_overview_hourly.EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(service_overview_hourly.DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          min(service_overview_hourly.FirstSeen) AS bFirstSeen,
          sum(service_overview_hourly.ApdexSatisfiedCount) AS bApdexSatisfiedCount,
          sum(service_overview_hourly.ApdexToleratingCount) AS bApdexToleratingCount
        FROM service_overview_hourly
        WHERE service_overview_hourly.OrgId = 'org_sql_catalog'
          AND service_overview_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND service_overview_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
) AS service_windows
        WHERE service_windows.bEnvironment != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          service_windows.bServiceNamespace AS name,
          sum(service_windows.bSpanCount) AS count,
          'namespace' AS facetType
        FROM (
SELECT
          toStartOfHour(service_overview_spans.Timestamp) AS bBucket,
          service_overview_spans.ServiceName AS bServiceName,
          service_overview_spans.ServiceNamespace AS bServiceNamespace,
          service_overview_spans.DeploymentEnv AS bEnvironment,
          service_overview_spans.CommitSha AS bCommitSha,
          count() AS bSpanCount,
          sum(service_overview_spans.SampleRate) AS bEstimatedSpanCount,
          countIf(service_overview_spans.StatusCode = 'Error') AS bErrorCount,
          sumIf(service_overview_spans.SampleRate, service_overview_spans.StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          min(service_overview_spans.Timestamp) AS bFirstSeen,
          countIf((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration < 500000000)) AS bApdexSatisfiedCount,
          countIf(((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration >= 500000000) AND service_overview_spans.Duration < 2000000000)) AS bApdexToleratingCount
        FROM service_overview_spans
        WHERE service_overview_spans.OrgId = 'org_sql_catalog'
          AND service_overview_spans.Timestamp >= '2026-01-01 10:30:00'
          AND service_overview_spans.Timestamp <= '2026-01-03 14:15:00'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
UNION ALL
SELECT
          service_overview_hourly.Hour AS bBucket,
          service_overview_hourly.ServiceName AS bServiceName,
          service_overview_hourly.ServiceNamespace AS bServiceNamespace,
          service_overview_hourly.DeploymentEnv AS bEnvironment,
          service_overview_hourly.CommitSha AS bCommitSha,
          sum(service_overview_hourly.SpanCount) AS bSpanCount,
          sum(service_overview_hourly.EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(service_overview_hourly.ErrorCount) AS bErrorCount,
          sum(service_overview_hourly.EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(service_overview_hourly.DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          min(service_overview_hourly.FirstSeen) AS bFirstSeen,
          sum(service_overview_hourly.ApdexSatisfiedCount) AS bApdexSatisfiedCount,
          sum(service_overview_hourly.ApdexToleratingCount) AS bApdexToleratingCount
        FROM service_overview_hourly
        WHERE service_overview_hourly.OrgId = 'org_sql_catalog'
          AND service_overview_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND service_overview_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
) AS service_windows
        WHERE service_windows.bServiceNamespace != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          service_windows.bCommitSha AS name,
          sum(service_windows.bSpanCount) AS count,
          'commit_sha' AS facetType
        FROM (
SELECT
          toStartOfHour(service_overview_spans.Timestamp) AS bBucket,
          service_overview_spans.ServiceName AS bServiceName,
          service_overview_spans.ServiceNamespace AS bServiceNamespace,
          service_overview_spans.DeploymentEnv AS bEnvironment,
          service_overview_spans.CommitSha AS bCommitSha,
          count() AS bSpanCount,
          sum(service_overview_spans.SampleRate) AS bEstimatedSpanCount,
          countIf(service_overview_spans.StatusCode = 'Error') AS bErrorCount,
          sumIf(service_overview_spans.SampleRate, service_overview_spans.StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          min(service_overview_spans.Timestamp) AS bFirstSeen,
          countIf((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration < 500000000)) AS bApdexSatisfiedCount,
          countIf(((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration >= 500000000) AND service_overview_spans.Duration < 2000000000)) AS bApdexToleratingCount
        FROM service_overview_spans
        WHERE service_overview_spans.OrgId = 'org_sql_catalog'
          AND service_overview_spans.Timestamp >= '2026-01-01 10:30:00'
          AND service_overview_spans.Timestamp <= '2026-01-03 14:15:00'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
UNION ALL
SELECT
          service_overview_hourly.Hour AS bBucket,
          service_overview_hourly.ServiceName AS bServiceName,
          service_overview_hourly.ServiceNamespace AS bServiceNamespace,
          service_overview_hourly.DeploymentEnv AS bEnvironment,
          service_overview_hourly.CommitSha AS bCommitSha,
          sum(service_overview_hourly.SpanCount) AS bSpanCount,
          sum(service_overview_hourly.EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(service_overview_hourly.ErrorCount) AS bErrorCount,
          sum(service_overview_hourly.EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(service_overview_hourly.DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          min(service_overview_hourly.FirstSeen) AS bFirstSeen,
          sum(service_overview_hourly.ApdexSatisfiedCount) AS bApdexSatisfiedCount,
          sum(service_overview_hourly.ApdexToleratingCount) AS bApdexToleratingCount
        FROM service_overview_hourly
        WHERE service_overview_hourly.OrgId = 'org_sql_catalog'
          AND service_overview_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND service_overview_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
) AS service_windows
        WHERE service_windows.bCommitSha != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          service_windows.bServiceName AS name,
          sum(service_windows.bSpanCount) AS count,
          'service' AS facetType
        FROM (
SELECT
          toStartOfHour(service_overview_spans.Timestamp) AS bBucket,
          service_overview_spans.ServiceName AS bServiceName,
          service_overview_spans.ServiceNamespace AS bServiceNamespace,
          service_overview_spans.DeploymentEnv AS bEnvironment,
          service_overview_spans.CommitSha AS bCommitSha,
          count() AS bSpanCount,
          sum(service_overview_spans.SampleRate) AS bEstimatedSpanCount,
          countIf(service_overview_spans.StatusCode = 'Error') AS bErrorCount,
          sumIf(service_overview_spans.SampleRate, service_overview_spans.StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          min(service_overview_spans.Timestamp) AS bFirstSeen,
          countIf((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration < 500000000)) AS bApdexSatisfiedCount,
          countIf(((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration >= 500000000) AND service_overview_spans.Duration < 2000000000)) AS bApdexToleratingCount
        FROM service_overview_spans
        WHERE service_overview_spans.OrgId = 'org_sql_catalog'
          AND service_overview_spans.Timestamp >= '2026-01-01 10:30:00'
          AND service_overview_spans.Timestamp <= '2026-01-03 14:15:00'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
UNION ALL
SELECT
          service_overview_hourly.Hour AS bBucket,
          service_overview_hourly.ServiceName AS bServiceName,
          service_overview_hourly.ServiceNamespace AS bServiceNamespace,
          service_overview_hourly.DeploymentEnv AS bEnvironment,
          service_overview_hourly.CommitSha AS bCommitSha,
          sum(service_overview_hourly.SpanCount) AS bSpanCount,
          sum(service_overview_hourly.EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(service_overview_hourly.ErrorCount) AS bErrorCount,
          sum(service_overview_hourly.EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(service_overview_hourly.DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          min(service_overview_hourly.FirstSeen) AS bFirstSeen,
          sum(service_overview_hourly.ApdexSatisfiedCount) AS bApdexSatisfiedCount,
          sum(service_overview_hourly.ApdexToleratingCount) AS bApdexToleratingCount
        FROM service_overview_hourly
        WHERE service_overview_hourly.OrgId = 'org_sql_catalog'
          AND service_overview_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND service_overview_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
) AS service_windows
        WHERE service_windows.bServiceName != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
FORMAT JSON

-- spec:traces-breakdown-by-attribute:baseline  [d1515770]
SELECT
          traces.SpanAttributes['http.route'] AS name,
          sum(traces.SampleRate) AS count,
          count() AS spanCount,
          0 AS avgDuration,
          quantile(0.5)(traces.Duration) / 1000000 AS p50Duration,
          quantile(0.95)(traces.Duration) / 1000000 AS p95Duration,
          quantile(0.99)(traces.Duration) / 1000000 AS p99Duration,
          0 AS errorRate,
          0 AS satisfiedCount,
          0 AS toleratingCount,
          0 AS apdexScore
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND traces.ServiceName = 'api'
          AND coalesce(nullIf(traces.ResourceAttributes['deployment.environment.name'], ''), traces.ResourceAttributes['deployment.environment']) IN ('production')
        GROUP BY name
        ORDER BY count DESC
        LIMIT 10
        FORMAT JSON

-- spec:traces-breakdown-by-attribute:bloom  [d1515770]
SELECT
          traces.SpanAttributes['http.route'] AS name,
          sum(traces.SampleRate) AS count,
          count() AS spanCount,
          0 AS avgDuration,
          quantile(0.5)(traces.Duration) / 1000000 AS p50Duration,
          quantile(0.95)(traces.Duration) / 1000000 AS p95Duration,
          quantile(0.99)(traces.Duration) / 1000000 AS p99Duration,
          0 AS errorRate,
          0 AS satisfiedCount,
          0 AS toleratingCount,
          0 AS apdexScore
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND traces.ServiceName = 'api'
          AND coalesce(nullIf(traces.ResourceAttributes['deployment.environment.name'], ''), traces.ResourceAttributes['deployment.environment']) IN ('production')
        GROUP BY name
        ORDER BY count DESC
        LIMIT 10
        FORMAT JSON

-- spec:traces-breakdown-by-attribute:text  [d1515770]
SELECT
          traces.SpanAttributes['http.route'] AS name,
          sum(traces.SampleRate) AS count,
          count() AS spanCount,
          0 AS avgDuration,
          quantile(0.5)(traces.Duration) / 1000000 AS p50Duration,
          quantile(0.95)(traces.Duration) / 1000000 AS p95Duration,
          quantile(0.99)(traces.Duration) / 1000000 AS p99Duration,
          0 AS errorRate,
          0 AS satisfiedCount,
          0 AS toleratingCount,
          0 AS apdexScore
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND traces.ServiceName = 'api'
          AND coalesce(nullIf(traces.ResourceAttributes['deployment.environment.name'], ''), traces.ResourceAttributes['deployment.environment']) IN ('production')
        GROUP BY name
        ORDER BY count DESC
        LIMIT 10
        FORMAT JSON

-- spec:traces-breakdown:baseline  [4f4cd31c]
SELECT
          traces.ServiceName AS name,
          sum(traces.SampleRate) AS count,
          count() AS spanCount,
          0 AS avgDuration,
          0 AS p50Duration,
          0 AS p95Duration,
          0 AS p99Duration,
          0 AS errorRate,
          0 AS satisfiedCount,
          0 AS toleratingCount,
          0 AS apdexScore
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND traces.ServiceName = 'api'
          AND coalesce(nullIf(traces.ResourceAttributes['deployment.environment.name'], ''), traces.ResourceAttributes['deployment.environment']) IN ('production')
        GROUP BY name
        ORDER BY count DESC
        LIMIT 10
        FORMAT JSON

-- spec:traces-facets-single-dimension:baseline  [d670c94d]
SELECT
          spanName_tiers.name AS name,
          sum(spanName_tiers.count) AS count,
          'spanName' AS facetType
        FROM (
SELECT
          trace_list_mv.SpanName AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.ServiceName = 'api'
          AND trace_list_mv.DeploymentEnv = 'production'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND trace_list_mv.SpanName != ''
        GROUP BY name
UNION ALL
SELECT
          trace_facets_hourly.SpanName AS name,
          sum(trace_facets_hourly.TraceCount) AS count
        FROM trace_facets_hourly
        WHERE trace_facets_hourly.OrgId = 'org_sql_catalog'
          AND trace_facets_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND trace_facets_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND trace_facets_hourly.ServiceName = 'api'
          AND trace_facets_hourly.DeploymentEnv = 'production'
          AND trace_facets_hourly.SpanName != ''
        GROUP BY name
) AS spanName_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
FORMAT JSON

-- spec:traces-facets:baseline  [29a29fef]
SELECT
          service_tiers.name AS name,
          sum(service_tiers.count) AS count,
          'service' AS facetType
        FROM (
SELECT
          trace_list_mv.ServiceName AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.ServiceName = 'api'
          AND trace_list_mv.DeploymentEnv = 'production'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
        GROUP BY name
UNION ALL
SELECT
          trace_facets_hourly.ServiceName AS name,
          sum(trace_facets_hourly.TraceCount) AS count
        FROM trace_facets_hourly
        WHERE trace_facets_hourly.OrgId = 'org_sql_catalog'
          AND trace_facets_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND trace_facets_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND trace_facets_hourly.ServiceName = 'api'
          AND trace_facets_hourly.DeploymentEnv = 'production'
        GROUP BY name
) AS service_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          spanName_tiers.name AS name,
          sum(spanName_tiers.count) AS count,
          'spanName' AS facetType
        FROM (
SELECT
          trace_list_mv.SpanName AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.ServiceName = 'api'
          AND trace_list_mv.DeploymentEnv = 'production'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND trace_list_mv.SpanName != ''
        GROUP BY name
UNION ALL
SELECT
          trace_facets_hourly.SpanName AS name,
          sum(trace_facets_hourly.TraceCount) AS count
        FROM trace_facets_hourly
        WHERE trace_facets_hourly.OrgId = 'org_sql_catalog'
          AND trace_facets_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND trace_facets_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND trace_facets_hourly.ServiceName = 'api'
          AND trace_facets_hourly.DeploymentEnv = 'production'
          AND trace_facets_hourly.SpanName != ''
        GROUP BY name
) AS spanName_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          httpMethod_tiers.name AS name,
          sum(httpMethod_tiers.count) AS count,
          'httpMethod' AS facetType
        FROM (
SELECT
          trace_list_mv.HttpMethod AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.ServiceName = 'api'
          AND trace_list_mv.DeploymentEnv = 'production'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND trace_list_mv.HttpMethod != ''
        GROUP BY name
UNION ALL
SELECT
          trace_facets_hourly.HttpMethod AS name,
          sum(trace_facets_hourly.TraceCount) AS count
        FROM trace_facets_hourly
        WHERE trace_facets_hourly.OrgId = 'org_sql_catalog'
          AND trace_facets_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND trace_facets_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND trace_facets_hourly.ServiceName = 'api'
          AND trace_facets_hourly.DeploymentEnv = 'production'
          AND trace_facets_hourly.HttpMethod != ''
        GROUP BY name
) AS httpMethod_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          httpStatus_tiers.name AS name,
          sum(httpStatus_tiers.count) AS count,
          'httpStatus' AS facetType
        FROM (
SELECT
          trace_list_mv.HttpStatusCode AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.ServiceName = 'api'
          AND trace_list_mv.DeploymentEnv = 'production'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND trace_list_mv.HttpStatusCode != ''
        GROUP BY name
UNION ALL
SELECT
          trace_facets_hourly.HttpStatusCode AS name,
          sum(trace_facets_hourly.TraceCount) AS count
        FROM trace_facets_hourly
        WHERE trace_facets_hourly.OrgId = 'org_sql_catalog'
          AND trace_facets_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND trace_facets_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND trace_facets_hourly.ServiceName = 'api'
          AND trace_facets_hourly.DeploymentEnv = 'production'
          AND trace_facets_hourly.HttpStatusCode != ''
        GROUP BY name
) AS httpStatus_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          deploymentEnv_tiers.name AS name,
          sum(deploymentEnv_tiers.count) AS count,
          'deploymentEnv' AS facetType
        FROM (
SELECT
          trace_list_mv.DeploymentEnv AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.ServiceName = 'api'
          AND trace_list_mv.DeploymentEnv = 'production'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND trace_list_mv.DeploymentEnv != ''
        GROUP BY name
UNION ALL
SELECT
          trace_facets_hourly.DeploymentEnv AS name,
          sum(trace_facets_hourly.TraceCount) AS count
        FROM trace_facets_hourly
        WHERE trace_facets_hourly.OrgId = 'org_sql_catalog'
          AND trace_facets_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND trace_facets_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND trace_facets_hourly.ServiceName = 'api'
          AND trace_facets_hourly.DeploymentEnv = 'production'
          AND trace_facets_hourly.DeploymentEnv != ''
        GROUP BY name
) AS deploymentEnv_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          serviceNamespace_tiers.name AS name,
          sum(serviceNamespace_tiers.count) AS count,
          'serviceNamespace' AS facetType
        FROM (
SELECT
          trace_list_mv.ServiceNamespace AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.ServiceName = 'api'
          AND trace_list_mv.DeploymentEnv = 'production'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND trace_list_mv.ServiceNamespace != ''
        GROUP BY name
UNION ALL
SELECT
          trace_facets_hourly.ServiceNamespace AS name,
          sum(trace_facets_hourly.TraceCount) AS count
        FROM trace_facets_hourly
        WHERE trace_facets_hourly.OrgId = 'org_sql_catalog'
          AND trace_facets_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND trace_facets_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND trace_facets_hourly.ServiceName = 'api'
          AND trace_facets_hourly.DeploymentEnv = 'production'
          AND trace_facets_hourly.ServiceNamespace != ''
        GROUP BY name
) AS serviceNamespace_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          'error' AS name,
          sum(errorCount_tiers.count) AS count,
          'errorCount' AS facetType
        FROM (
SELECT
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.ServiceName = 'api'
          AND trace_list_mv.DeploymentEnv = 'production'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND trace_list_mv.HasError = 1
UNION ALL
SELECT
          sum(trace_facets_hourly.TraceCount) AS count
        FROM trace_facets_hourly
        WHERE trace_facets_hourly.OrgId = 'org_sql_catalog'
          AND trace_facets_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND trace_facets_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND trace_facets_hourly.ServiceName = 'api'
          AND trace_facets_hourly.DeploymentEnv = 'production'
          AND trace_facets_hourly.HasError = 1
) AS errorCount_tiers
FORMAT JSON

-- spec:traces-facets:bloom  [29a29fef]
SELECT
          service_tiers.name AS name,
          sum(service_tiers.count) AS count,
          'service' AS facetType
        FROM (
SELECT
          trace_list_mv.ServiceName AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.ServiceName = 'api'
          AND trace_list_mv.DeploymentEnv = 'production'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
        GROUP BY name
UNION ALL
SELECT
          trace_facets_hourly.ServiceName AS name,
          sum(trace_facets_hourly.TraceCount) AS count
        FROM trace_facets_hourly
        WHERE trace_facets_hourly.OrgId = 'org_sql_catalog'
          AND trace_facets_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND trace_facets_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND trace_facets_hourly.ServiceName = 'api'
          AND trace_facets_hourly.DeploymentEnv = 'production'
        GROUP BY name
) AS service_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          spanName_tiers.name AS name,
          sum(spanName_tiers.count) AS count,
          'spanName' AS facetType
        FROM (
SELECT
          trace_list_mv.SpanName AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.ServiceName = 'api'
          AND trace_list_mv.DeploymentEnv = 'production'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND trace_list_mv.SpanName != ''
        GROUP BY name
UNION ALL
SELECT
          trace_facets_hourly.SpanName AS name,
          sum(trace_facets_hourly.TraceCount) AS count
        FROM trace_facets_hourly
        WHERE trace_facets_hourly.OrgId = 'org_sql_catalog'
          AND trace_facets_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND trace_facets_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND trace_facets_hourly.ServiceName = 'api'
          AND trace_facets_hourly.DeploymentEnv = 'production'
          AND trace_facets_hourly.SpanName != ''
        GROUP BY name
) AS spanName_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          httpMethod_tiers.name AS name,
          sum(httpMethod_tiers.count) AS count,
          'httpMethod' AS facetType
        FROM (
SELECT
          trace_list_mv.HttpMethod AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.ServiceName = 'api'
          AND trace_list_mv.DeploymentEnv = 'production'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND trace_list_mv.HttpMethod != ''
        GROUP BY name
UNION ALL
SELECT
          trace_facets_hourly.HttpMethod AS name,
          sum(trace_facets_hourly.TraceCount) AS count
        FROM trace_facets_hourly
        WHERE trace_facets_hourly.OrgId = 'org_sql_catalog'
          AND trace_facets_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND trace_facets_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND trace_facets_hourly.ServiceName = 'api'
          AND trace_facets_hourly.DeploymentEnv = 'production'
          AND trace_facets_hourly.HttpMethod != ''
        GROUP BY name
) AS httpMethod_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          httpStatus_tiers.name AS name,
          sum(httpStatus_tiers.count) AS count,
          'httpStatus' AS facetType
        FROM (
SELECT
          trace_list_mv.HttpStatusCode AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.ServiceName = 'api'
          AND trace_list_mv.DeploymentEnv = 'production'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND trace_list_mv.HttpStatusCode != ''
        GROUP BY name
UNION ALL
SELECT
          trace_facets_hourly.HttpStatusCode AS name,
          sum(trace_facets_hourly.TraceCount) AS count
        FROM trace_facets_hourly
        WHERE trace_facets_hourly.OrgId = 'org_sql_catalog'
          AND trace_facets_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND trace_facets_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND trace_facets_hourly.ServiceName = 'api'
          AND trace_facets_hourly.DeploymentEnv = 'production'
          AND trace_facets_hourly.HttpStatusCode != ''
        GROUP BY name
) AS httpStatus_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          deploymentEnv_tiers.name AS name,
          sum(deploymentEnv_tiers.count) AS count,
          'deploymentEnv' AS facetType
        FROM (
SELECT
          trace_list_mv.DeploymentEnv AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.ServiceName = 'api'
          AND trace_list_mv.DeploymentEnv = 'production'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND trace_list_mv.DeploymentEnv != ''
        GROUP BY name
UNION ALL
SELECT
          trace_facets_hourly.DeploymentEnv AS name,
          sum(trace_facets_hourly.TraceCount) AS count
        FROM trace_facets_hourly
        WHERE trace_facets_hourly.OrgId = 'org_sql_catalog'
          AND trace_facets_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND trace_facets_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND trace_facets_hourly.ServiceName = 'api'
          AND trace_facets_hourly.DeploymentEnv = 'production'
          AND trace_facets_hourly.DeploymentEnv != ''
        GROUP BY name
) AS deploymentEnv_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          serviceNamespace_tiers.name AS name,
          sum(serviceNamespace_tiers.count) AS count,
          'serviceNamespace' AS facetType
        FROM (
SELECT
          trace_list_mv.ServiceNamespace AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.ServiceName = 'api'
          AND trace_list_mv.DeploymentEnv = 'production'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND trace_list_mv.ServiceNamespace != ''
        GROUP BY name
UNION ALL
SELECT
          trace_facets_hourly.ServiceNamespace AS name,
          sum(trace_facets_hourly.TraceCount) AS count
        FROM trace_facets_hourly
        WHERE trace_facets_hourly.OrgId = 'org_sql_catalog'
          AND trace_facets_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND trace_facets_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND trace_facets_hourly.ServiceName = 'api'
          AND trace_facets_hourly.DeploymentEnv = 'production'
          AND trace_facets_hourly.ServiceNamespace != ''
        GROUP BY name
) AS serviceNamespace_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          'error' AS name,
          sum(errorCount_tiers.count) AS count,
          'errorCount' AS facetType
        FROM (
SELECT
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.ServiceName = 'api'
          AND trace_list_mv.DeploymentEnv = 'production'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND trace_list_mv.HasError = 1
UNION ALL
SELECT
          sum(trace_facets_hourly.TraceCount) AS count
        FROM trace_facets_hourly
        WHERE trace_facets_hourly.OrgId = 'org_sql_catalog'
          AND trace_facets_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND trace_facets_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND trace_facets_hourly.ServiceName = 'api'
          AND trace_facets_hourly.DeploymentEnv = 'production'
          AND trace_facets_hourly.HasError = 1
) AS errorCount_tiers
FORMAT JSON

-- spec:traces-facets:text  [29a29fef]
SELECT
          service_tiers.name AS name,
          sum(service_tiers.count) AS count,
          'service' AS facetType
        FROM (
SELECT
          trace_list_mv.ServiceName AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.ServiceName = 'api'
          AND trace_list_mv.DeploymentEnv = 'production'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
        GROUP BY name
UNION ALL
SELECT
          trace_facets_hourly.ServiceName AS name,
          sum(trace_facets_hourly.TraceCount) AS count
        FROM trace_facets_hourly
        WHERE trace_facets_hourly.OrgId = 'org_sql_catalog'
          AND trace_facets_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND trace_facets_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND trace_facets_hourly.ServiceName = 'api'
          AND trace_facets_hourly.DeploymentEnv = 'production'
        GROUP BY name
) AS service_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          spanName_tiers.name AS name,
          sum(spanName_tiers.count) AS count,
          'spanName' AS facetType
        FROM (
SELECT
          trace_list_mv.SpanName AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.ServiceName = 'api'
          AND trace_list_mv.DeploymentEnv = 'production'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND trace_list_mv.SpanName != ''
        GROUP BY name
UNION ALL
SELECT
          trace_facets_hourly.SpanName AS name,
          sum(trace_facets_hourly.TraceCount) AS count
        FROM trace_facets_hourly
        WHERE trace_facets_hourly.OrgId = 'org_sql_catalog'
          AND trace_facets_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND trace_facets_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND trace_facets_hourly.ServiceName = 'api'
          AND trace_facets_hourly.DeploymentEnv = 'production'
          AND trace_facets_hourly.SpanName != ''
        GROUP BY name
) AS spanName_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          httpMethod_tiers.name AS name,
          sum(httpMethod_tiers.count) AS count,
          'httpMethod' AS facetType
        FROM (
SELECT
          trace_list_mv.HttpMethod AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.ServiceName = 'api'
          AND trace_list_mv.DeploymentEnv = 'production'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND trace_list_mv.HttpMethod != ''
        GROUP BY name
UNION ALL
SELECT
          trace_facets_hourly.HttpMethod AS name,
          sum(trace_facets_hourly.TraceCount) AS count
        FROM trace_facets_hourly
        WHERE trace_facets_hourly.OrgId = 'org_sql_catalog'
          AND trace_facets_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND trace_facets_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND trace_facets_hourly.ServiceName = 'api'
          AND trace_facets_hourly.DeploymentEnv = 'production'
          AND trace_facets_hourly.HttpMethod != ''
        GROUP BY name
) AS httpMethod_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          httpStatus_tiers.name AS name,
          sum(httpStatus_tiers.count) AS count,
          'httpStatus' AS facetType
        FROM (
SELECT
          trace_list_mv.HttpStatusCode AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.ServiceName = 'api'
          AND trace_list_mv.DeploymentEnv = 'production'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND trace_list_mv.HttpStatusCode != ''
        GROUP BY name
UNION ALL
SELECT
          trace_facets_hourly.HttpStatusCode AS name,
          sum(trace_facets_hourly.TraceCount) AS count
        FROM trace_facets_hourly
        WHERE trace_facets_hourly.OrgId = 'org_sql_catalog'
          AND trace_facets_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND trace_facets_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND trace_facets_hourly.ServiceName = 'api'
          AND trace_facets_hourly.DeploymentEnv = 'production'
          AND trace_facets_hourly.HttpStatusCode != ''
        GROUP BY name
) AS httpStatus_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          deploymentEnv_tiers.name AS name,
          sum(deploymentEnv_tiers.count) AS count,
          'deploymentEnv' AS facetType
        FROM (
SELECT
          trace_list_mv.DeploymentEnv AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.ServiceName = 'api'
          AND trace_list_mv.DeploymentEnv = 'production'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND trace_list_mv.DeploymentEnv != ''
        GROUP BY name
UNION ALL
SELECT
          trace_facets_hourly.DeploymentEnv AS name,
          sum(trace_facets_hourly.TraceCount) AS count
        FROM trace_facets_hourly
        WHERE trace_facets_hourly.OrgId = 'org_sql_catalog'
          AND trace_facets_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND trace_facets_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND trace_facets_hourly.ServiceName = 'api'
          AND trace_facets_hourly.DeploymentEnv = 'production'
          AND trace_facets_hourly.DeploymentEnv != ''
        GROUP BY name
) AS deploymentEnv_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          serviceNamespace_tiers.name AS name,
          sum(serviceNamespace_tiers.count) AS count,
          'serviceNamespace' AS facetType
        FROM (
SELECT
          trace_list_mv.ServiceNamespace AS name,
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.ServiceName = 'api'
          AND trace_list_mv.DeploymentEnv = 'production'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND trace_list_mv.ServiceNamespace != ''
        GROUP BY name
UNION ALL
SELECT
          trace_facets_hourly.ServiceNamespace AS name,
          sum(trace_facets_hourly.TraceCount) AS count
        FROM trace_facets_hourly
        WHERE trace_facets_hourly.OrgId = 'org_sql_catalog'
          AND trace_facets_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND trace_facets_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND trace_facets_hourly.ServiceName = 'api'
          AND trace_facets_hourly.DeploymentEnv = 'production'
          AND trace_facets_hourly.ServiceNamespace != ''
        GROUP BY name
) AS serviceNamespace_tiers
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          'error' AS name,
          sum(errorCount_tiers.count) AS count,
          'errorCount' AS facetType
        FROM (
SELECT
          count() AS count
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.ServiceName = 'api'
          AND trace_list_mv.DeploymentEnv = 'production'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND trace_list_mv.HasError = 1
UNION ALL
SELECT
          sum(trace_facets_hourly.TraceCount) AS count
        FROM trace_facets_hourly
        WHERE trace_facets_hourly.OrgId = 'org_sql_catalog'
          AND trace_facets_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND trace_facets_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND trace_facets_hourly.ServiceName = 'api'
          AND trace_facets_hourly.DeploymentEnv = 'production'
          AND trace_facets_hourly.HasError = 1
) AS errorCount_tiers
FORMAT JSON

-- spec:traces-list-grouped-attr-fallback:baseline  [8e705c5c]
SELECT
          trace_detail_spans.TraceId AS traceId,
          argMin(trace_detail_spans.Timestamp, (if(ParentSpanId = '', 0, 1), Timestamp)) AS startTime,
          toDateTime(argMin(trace_detail_spans.Timestamp, (if(ParentSpanId = '', 0, 1), Timestamp))) AS startSecond,
          fromUnixTimestamp64Nano(max(toUnixTimestamp64Nano(trace_detail_spans.Timestamp) + toInt64(trace_detail_spans.Duration))) AS endTime,
          intDiv(max(toUnixTimestamp64Nano(trace_detail_spans.Timestamp) + toInt64(trace_detail_spans.Duration)) - min(toUnixTimestamp64Nano(trace_detail_spans.Timestamp)), 1000) AS durationMicros,
          intDiv(argMin(trace_detail_spans.Duration, (if(ParentSpanId = '', 0, 1), Timestamp)), 1000) AS rootDurationMicros,
          count() AS spanCount,
          arrayDistinct(arrayPushFront(arraySort(groupUniqArray(trace_detail_spans.ServiceName)), argMin(trace_detail_spans.ServiceName, (if(ParentSpanId = '', 0, 1), Timestamp)))) AS services,
          argMin(trace_detail_spans.SpanName, (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanName,
          argMin(trace_detail_spans.SpanKind, (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanKind,
          argMin(trace_detail_spans.StatusCode, (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanStatusCode,
          argMin(if(trace_detail_spans.SpanAttributes['http.method'] != '', trace_detail_spans.SpanAttributes['http.method'], trace_detail_spans.SpanAttributes['http.request.method']), (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootHttpMethod,
          argMin(trace_detail_spans.SpanAttributes['http.route'], (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootHttpRoute,
          argMin(if(trace_detail_spans.SpanAttributes['http.status_code'] != '', trace_detail_spans.SpanAttributes['http.status_code'], trace_detail_spans.SpanAttributes['http.response.status_code']), (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootHttpStatusCode,
          argMin(toJSONString(map('http.method', SpanAttributes['http.method'], 'http.request.method', SpanAttributes['http.request.method'], 'http.route', SpanAttributes['http.route'], 'http.target', SpanAttributes['http.target'], 'http.status_code', SpanAttributes['http.status_code'], 'http.response.status_code', SpanAttributes['http.response.status_code'], 'http.url', SpanAttributes['http.url'], 'url.full', SpanAttributes['url.full'], 'url.path', SpanAttributes['url.path'], 'server.address', SpanAttributes['server.address'], 'net.peer.name', SpanAttributes['net.peer.name'], 'screen.name', SpanAttributes['screen.name'])), (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanAttributes,
          if(argMin(trace_detail_spans.StatusCode, (if(ParentSpanId = '', 0, 1), Timestamp)) = 'Error', 1, 0) AS hasError
        FROM trace_detail_spans
        WHERE trace_detail_spans.OrgId = 'org_sql_catalog'
          AND trace_detail_spans.Timestamp >= subtractHours(toDateTime('2026-01-01 10:30:00'), 1)
          AND trace_detail_spans.Timestamp <= addHours(toDateTime('2026-01-03 14:15:00'), 1)
          AND TraceId IN (SELECT traceId FROM (SELECT
          traces.TraceId AS traceId,
          traces.Timestamp AS ts,
          traces.Duration AS d
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND traces.ServiceName = 'api'
          AND coalesce(nullIf(traces.ResourceAttributes['deployment.environment.name'], ''), traces.ResourceAttributes['deployment.environment']) IN ('production')
          AND SpanAttributes['user.id'] = 'u1'
          AND traces.ParentSpanId = ''
        ORDER BY ts DESC, traceId DESC
        LIMIT 50))
        GROUP BY traceId
        ORDER BY startTime DESC, traceId DESC
        LIMIT 50
        FORMAT JSON

-- spec:traces-list-grouped-attr-fallback:bloom  [3fd93e22]
SELECT
          trace_detail_spans.TraceId AS traceId,
          argMin(trace_detail_spans.Timestamp, (if(ParentSpanId = '', 0, 1), Timestamp)) AS startTime,
          toDateTime(argMin(trace_detail_spans.Timestamp, (if(ParentSpanId = '', 0, 1), Timestamp))) AS startSecond,
          fromUnixTimestamp64Nano(max(toUnixTimestamp64Nano(trace_detail_spans.Timestamp) + toInt64(trace_detail_spans.Duration))) AS endTime,
          intDiv(max(toUnixTimestamp64Nano(trace_detail_spans.Timestamp) + toInt64(trace_detail_spans.Duration)) - min(toUnixTimestamp64Nano(trace_detail_spans.Timestamp)), 1000) AS durationMicros,
          intDiv(argMin(trace_detail_spans.Duration, (if(ParentSpanId = '', 0, 1), Timestamp)), 1000) AS rootDurationMicros,
          count() AS spanCount,
          arrayDistinct(arrayPushFront(arraySort(groupUniqArray(trace_detail_spans.ServiceName)), argMin(trace_detail_spans.ServiceName, (if(ParentSpanId = '', 0, 1), Timestamp)))) AS services,
          argMin(trace_detail_spans.SpanName, (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanName,
          argMin(trace_detail_spans.SpanKind, (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanKind,
          argMin(trace_detail_spans.StatusCode, (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanStatusCode,
          argMin(if(trace_detail_spans.SpanAttributes['http.method'] != '', trace_detail_spans.SpanAttributes['http.method'], trace_detail_spans.SpanAttributes['http.request.method']), (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootHttpMethod,
          argMin(trace_detail_spans.SpanAttributes['http.route'], (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootHttpRoute,
          argMin(if(trace_detail_spans.SpanAttributes['http.status_code'] != '', trace_detail_spans.SpanAttributes['http.status_code'], trace_detail_spans.SpanAttributes['http.response.status_code']), (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootHttpStatusCode,
          argMin(toJSONString(map('http.method', SpanAttributes['http.method'], 'http.request.method', SpanAttributes['http.request.method'], 'http.route', SpanAttributes['http.route'], 'http.target', SpanAttributes['http.target'], 'http.status_code', SpanAttributes['http.status_code'], 'http.response.status_code', SpanAttributes['http.response.status_code'], 'http.url', SpanAttributes['http.url'], 'url.full', SpanAttributes['url.full'], 'url.path', SpanAttributes['url.path'], 'server.address', SpanAttributes['server.address'], 'net.peer.name', SpanAttributes['net.peer.name'], 'screen.name', SpanAttributes['screen.name'])), (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanAttributes,
          if(argMin(trace_detail_spans.StatusCode, (if(ParentSpanId = '', 0, 1), Timestamp)) = 'Error', 1, 0) AS hasError
        FROM trace_detail_spans
        WHERE trace_detail_spans.OrgId = 'org_sql_catalog'
          AND trace_detail_spans.Timestamp >= subtractHours(toDateTime('2026-01-01 10:30:00'), 1)
          AND trace_detail_spans.Timestamp <= addHours(toDateTime('2026-01-03 14:15:00'), 1)
          AND TraceId IN (SELECT traceId FROM (SELECT
          traces.TraceId AS traceId,
          traces.Timestamp AS ts,
          traces.Duration AS d
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND traces.ServiceName = 'api'
          AND coalesce(nullIf(traces.ResourceAttributes['deployment.environment.name'], ''), traces.ResourceAttributes['deployment.environment']) IN ('production')
          AND ((has(mapKeys(SpanAttributes), 'user.id') AND has(mapValues(SpanAttributes), 'u1')) AND SpanAttributes['user.id'] = 'u1')
          AND traces.ParentSpanId = ''
        ORDER BY ts DESC, traceId DESC
        LIMIT 50))
        GROUP BY traceId
        ORDER BY startTime DESC, traceId DESC
        LIMIT 50
        FORMAT JSON

-- spec:traces-list-grouped-attr-fallback:text  [f7e16154]
SELECT
          trace_detail_spans.TraceId AS traceId,
          argMin(trace_detail_spans.Timestamp, (if(ParentSpanId = '', 0, 1), Timestamp)) AS startTime,
          toDateTime(argMin(trace_detail_spans.Timestamp, (if(ParentSpanId = '', 0, 1), Timestamp))) AS startSecond,
          fromUnixTimestamp64Nano(max(toUnixTimestamp64Nano(trace_detail_spans.Timestamp) + toInt64(trace_detail_spans.Duration))) AS endTime,
          intDiv(max(toUnixTimestamp64Nano(trace_detail_spans.Timestamp) + toInt64(trace_detail_spans.Duration)) - min(toUnixTimestamp64Nano(trace_detail_spans.Timestamp)), 1000) AS durationMicros,
          intDiv(argMin(trace_detail_spans.Duration, (if(ParentSpanId = '', 0, 1), Timestamp)), 1000) AS rootDurationMicros,
          count() AS spanCount,
          arrayDistinct(arrayPushFront(arraySort(groupUniqArray(trace_detail_spans.ServiceName)), argMin(trace_detail_spans.ServiceName, (if(ParentSpanId = '', 0, 1), Timestamp)))) AS services,
          argMin(trace_detail_spans.SpanName, (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanName,
          argMin(trace_detail_spans.SpanKind, (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanKind,
          argMin(trace_detail_spans.StatusCode, (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanStatusCode,
          argMin(if(trace_detail_spans.SpanAttributes['http.method'] != '', trace_detail_spans.SpanAttributes['http.method'], trace_detail_spans.SpanAttributes['http.request.method']), (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootHttpMethod,
          argMin(trace_detail_spans.SpanAttributes['http.route'], (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootHttpRoute,
          argMin(if(trace_detail_spans.SpanAttributes['http.status_code'] != '', trace_detail_spans.SpanAttributes['http.status_code'], trace_detail_spans.SpanAttributes['http.response.status_code']), (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootHttpStatusCode,
          argMin(toJSONString(map('http.method', SpanAttributes['http.method'], 'http.request.method', SpanAttributes['http.request.method'], 'http.route', SpanAttributes['http.route'], 'http.target', SpanAttributes['http.target'], 'http.status_code', SpanAttributes['http.status_code'], 'http.response.status_code', SpanAttributes['http.response.status_code'], 'http.url', SpanAttributes['http.url'], 'url.full', SpanAttributes['url.full'], 'url.path', SpanAttributes['url.path'], 'server.address', SpanAttributes['server.address'], 'net.peer.name', SpanAttributes['net.peer.name'], 'screen.name', SpanAttributes['screen.name'])), (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanAttributes,
          if(argMin(trace_detail_spans.StatusCode, (if(ParentSpanId = '', 0, 1), Timestamp)) = 'Error', 1, 0) AS hasError
        FROM trace_detail_spans
        WHERE trace_detail_spans.OrgId = 'org_sql_catalog'
          AND trace_detail_spans.Timestamp >= subtractHours(toDateTime('2026-01-01 10:30:00'), 1)
          AND trace_detail_spans.Timestamp <= addHours(toDateTime('2026-01-03 14:15:00'), 1)
          AND TraceId IN (SELECT traceId FROM (SELECT
          traces.TraceId AS traceId,
          traces.Timestamp AS ts,
          traces.Duration AS d
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND traces.ServiceName = 'api'
          AND coalesce(nullIf(traces.ResourceAttributes['deployment.environment.name'], ''), traces.ResourceAttributes['deployment.environment']) IN ('production')
          AND (has(SpanAttributeItems, concat('user.id', char(31), 'u1')) AND SpanAttributes['user.id'] = 'u1')
          AND traces.ParentSpanId = ''
        ORDER BY ts DESC, traceId DESC
        LIMIT 50))
        GROUP BY traceId
        ORDER BY startTime DESC, traceId DESC
        LIMIT 50
        FORMAT JSON

-- spec:traces-list-grouped-duration-sort:baseline  [31bf5ac8]
SELECT
          trace_detail_spans.TraceId AS traceId,
          argMin(trace_detail_spans.Timestamp, (if(ParentSpanId = '', 0, 1), Timestamp)) AS startTime,
          toDateTime(argMin(trace_detail_spans.Timestamp, (if(ParentSpanId = '', 0, 1), Timestamp))) AS startSecond,
          fromUnixTimestamp64Nano(max(toUnixTimestamp64Nano(trace_detail_spans.Timestamp) + toInt64(trace_detail_spans.Duration))) AS endTime,
          intDiv(max(toUnixTimestamp64Nano(trace_detail_spans.Timestamp) + toInt64(trace_detail_spans.Duration)) - min(toUnixTimestamp64Nano(trace_detail_spans.Timestamp)), 1000) AS durationMicros,
          intDiv(argMin(trace_detail_spans.Duration, (if(ParentSpanId = '', 0, 1), Timestamp)), 1000) AS rootDurationMicros,
          count() AS spanCount,
          arrayDistinct(arrayPushFront(arraySort(groupUniqArray(trace_detail_spans.ServiceName)), argMin(trace_detail_spans.ServiceName, (if(ParentSpanId = '', 0, 1), Timestamp)))) AS services,
          argMin(trace_detail_spans.SpanName, (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanName,
          argMin(trace_detail_spans.SpanKind, (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanKind,
          argMin(trace_detail_spans.StatusCode, (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanStatusCode,
          argMin(if(trace_detail_spans.SpanAttributes['http.method'] != '', trace_detail_spans.SpanAttributes['http.method'], trace_detail_spans.SpanAttributes['http.request.method']), (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootHttpMethod,
          argMin(trace_detail_spans.SpanAttributes['http.route'], (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootHttpRoute,
          argMin(if(trace_detail_spans.SpanAttributes['http.status_code'] != '', trace_detail_spans.SpanAttributes['http.status_code'], trace_detail_spans.SpanAttributes['http.response.status_code']), (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootHttpStatusCode,
          argMin(toJSONString(map('http.method', SpanAttributes['http.method'], 'http.request.method', SpanAttributes['http.request.method'], 'http.route', SpanAttributes['http.route'], 'http.target', SpanAttributes['http.target'], 'http.status_code', SpanAttributes['http.status_code'], 'http.response.status_code', SpanAttributes['http.response.status_code'], 'http.url', SpanAttributes['http.url'], 'url.full', SpanAttributes['url.full'], 'url.path', SpanAttributes['url.path'], 'server.address', SpanAttributes['server.address'], 'net.peer.name', SpanAttributes['net.peer.name'], 'screen.name', SpanAttributes['screen.name'])), (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanAttributes,
          if(argMin(trace_detail_spans.StatusCode, (if(ParentSpanId = '', 0, 1), Timestamp)) = 'Error', 1, 0) AS hasError
        FROM trace_detail_spans
        WHERE trace_detail_spans.OrgId = 'org_sql_catalog'
          AND trace_detail_spans.Timestamp >= subtractHours(toDateTime('2026-01-01 10:30:00'), 1)
          AND trace_detail_spans.Timestamp <= addHours(toDateTime('2026-01-03 14:15:00'), 1)
          AND TraceId IN (SELECT traceId FROM (SELECT
          trace_list_mv.TraceId AS traceId,
          trace_list_mv.Timestamp AS ts,
          trace_list_mv.Duration AS d
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.ServiceName = 'api'
          AND trace_list_mv.DeploymentEnv = 'production'
        ORDER BY d DESC, ts DESC, traceId DESC
        LIMIT 50
        OFFSET 100))
        GROUP BY traceId
        ORDER BY rootDurationMicros DESC, startSecond DESC, traceId DESC
        LIMIT 50
        FORMAT JSON

-- spec:traces-list-grouped:baseline  [a0e94af9]
SELECT
          trace_detail_spans.TraceId AS traceId,
          argMin(trace_detail_spans.Timestamp, (if(ParentSpanId = '', 0, 1), Timestamp)) AS startTime,
          toDateTime(argMin(trace_detail_spans.Timestamp, (if(ParentSpanId = '', 0, 1), Timestamp))) AS startSecond,
          fromUnixTimestamp64Nano(max(toUnixTimestamp64Nano(trace_detail_spans.Timestamp) + toInt64(trace_detail_spans.Duration))) AS endTime,
          intDiv(max(toUnixTimestamp64Nano(trace_detail_spans.Timestamp) + toInt64(trace_detail_spans.Duration)) - min(toUnixTimestamp64Nano(trace_detail_spans.Timestamp)), 1000) AS durationMicros,
          intDiv(argMin(trace_detail_spans.Duration, (if(ParentSpanId = '', 0, 1), Timestamp)), 1000) AS rootDurationMicros,
          count() AS spanCount,
          arrayDistinct(arrayPushFront(arraySort(groupUniqArray(trace_detail_spans.ServiceName)), argMin(trace_detail_spans.ServiceName, (if(ParentSpanId = '', 0, 1), Timestamp)))) AS services,
          argMin(trace_detail_spans.SpanName, (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanName,
          argMin(trace_detail_spans.SpanKind, (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanKind,
          argMin(trace_detail_spans.StatusCode, (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanStatusCode,
          argMin(if(trace_detail_spans.SpanAttributes['http.method'] != '', trace_detail_spans.SpanAttributes['http.method'], trace_detail_spans.SpanAttributes['http.request.method']), (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootHttpMethod,
          argMin(trace_detail_spans.SpanAttributes['http.route'], (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootHttpRoute,
          argMin(if(trace_detail_spans.SpanAttributes['http.status_code'] != '', trace_detail_spans.SpanAttributes['http.status_code'], trace_detail_spans.SpanAttributes['http.response.status_code']), (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootHttpStatusCode,
          argMin(toJSONString(map('http.method', SpanAttributes['http.method'], 'http.request.method', SpanAttributes['http.request.method'], 'http.route', SpanAttributes['http.route'], 'http.target', SpanAttributes['http.target'], 'http.status_code', SpanAttributes['http.status_code'], 'http.response.status_code', SpanAttributes['http.response.status_code'], 'http.url', SpanAttributes['http.url'], 'url.full', SpanAttributes['url.full'], 'url.path', SpanAttributes['url.path'], 'server.address', SpanAttributes['server.address'], 'net.peer.name', SpanAttributes['net.peer.name'], 'screen.name', SpanAttributes['screen.name'])), (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanAttributes,
          if(argMin(trace_detail_spans.StatusCode, (if(ParentSpanId = '', 0, 1), Timestamp)) = 'Error', 1, 0) AS hasError
        FROM trace_detail_spans
        WHERE trace_detail_spans.OrgId = 'org_sql_catalog'
          AND trace_detail_spans.Timestamp >= subtractHours(toDateTime('2026-01-01 10:30:00'), 1)
          AND trace_detail_spans.Timestamp <= addHours(toDateTime('2026-01-03 14:15:00'), 1)
          AND TraceId IN (SELECT traceId FROM (SELECT
          trace_list_mv.TraceId AS traceId,
          trace_list_mv.Timestamp AS ts,
          trace_list_mv.Duration AS d
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.ServiceName = 'api'
          AND trace_list_mv.DeploymentEnv = 'production'
        ORDER BY ts DESC, traceId DESC
        LIMIT 50))
        GROUP BY traceId
        ORDER BY startSecond DESC, traceId DESC
        LIMIT 50
        FORMAT JSON

-- spec:traces-list-grouped:bloom  [a0e94af9]
SELECT
          trace_detail_spans.TraceId AS traceId,
          argMin(trace_detail_spans.Timestamp, (if(ParentSpanId = '', 0, 1), Timestamp)) AS startTime,
          toDateTime(argMin(trace_detail_spans.Timestamp, (if(ParentSpanId = '', 0, 1), Timestamp))) AS startSecond,
          fromUnixTimestamp64Nano(max(toUnixTimestamp64Nano(trace_detail_spans.Timestamp) + toInt64(trace_detail_spans.Duration))) AS endTime,
          intDiv(max(toUnixTimestamp64Nano(trace_detail_spans.Timestamp) + toInt64(trace_detail_spans.Duration)) - min(toUnixTimestamp64Nano(trace_detail_spans.Timestamp)), 1000) AS durationMicros,
          intDiv(argMin(trace_detail_spans.Duration, (if(ParentSpanId = '', 0, 1), Timestamp)), 1000) AS rootDurationMicros,
          count() AS spanCount,
          arrayDistinct(arrayPushFront(arraySort(groupUniqArray(trace_detail_spans.ServiceName)), argMin(trace_detail_spans.ServiceName, (if(ParentSpanId = '', 0, 1), Timestamp)))) AS services,
          argMin(trace_detail_spans.SpanName, (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanName,
          argMin(trace_detail_spans.SpanKind, (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanKind,
          argMin(trace_detail_spans.StatusCode, (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanStatusCode,
          argMin(if(trace_detail_spans.SpanAttributes['http.method'] != '', trace_detail_spans.SpanAttributes['http.method'], trace_detail_spans.SpanAttributes['http.request.method']), (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootHttpMethod,
          argMin(trace_detail_spans.SpanAttributes['http.route'], (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootHttpRoute,
          argMin(if(trace_detail_spans.SpanAttributes['http.status_code'] != '', trace_detail_spans.SpanAttributes['http.status_code'], trace_detail_spans.SpanAttributes['http.response.status_code']), (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootHttpStatusCode,
          argMin(toJSONString(map('http.method', SpanAttributes['http.method'], 'http.request.method', SpanAttributes['http.request.method'], 'http.route', SpanAttributes['http.route'], 'http.target', SpanAttributes['http.target'], 'http.status_code', SpanAttributes['http.status_code'], 'http.response.status_code', SpanAttributes['http.response.status_code'], 'http.url', SpanAttributes['http.url'], 'url.full', SpanAttributes['url.full'], 'url.path', SpanAttributes['url.path'], 'server.address', SpanAttributes['server.address'], 'net.peer.name', SpanAttributes['net.peer.name'], 'screen.name', SpanAttributes['screen.name'])), (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanAttributes,
          if(argMin(trace_detail_spans.StatusCode, (if(ParentSpanId = '', 0, 1), Timestamp)) = 'Error', 1, 0) AS hasError
        FROM trace_detail_spans
        WHERE trace_detail_spans.OrgId = 'org_sql_catalog'
          AND trace_detail_spans.Timestamp >= subtractHours(toDateTime('2026-01-01 10:30:00'), 1)
          AND trace_detail_spans.Timestamp <= addHours(toDateTime('2026-01-03 14:15:00'), 1)
          AND TraceId IN (SELECT traceId FROM (SELECT
          trace_list_mv.TraceId AS traceId,
          trace_list_mv.Timestamp AS ts,
          trace_list_mv.Duration AS d
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.ServiceName = 'api'
          AND trace_list_mv.DeploymentEnv = 'production'
        ORDER BY ts DESC, traceId DESC
        LIMIT 50))
        GROUP BY traceId
        ORDER BY startSecond DESC, traceId DESC
        LIMIT 50
        FORMAT JSON

-- spec:traces-list-grouped:text  [a0e94af9]
SELECT
          trace_detail_spans.TraceId AS traceId,
          argMin(trace_detail_spans.Timestamp, (if(ParentSpanId = '', 0, 1), Timestamp)) AS startTime,
          toDateTime(argMin(trace_detail_spans.Timestamp, (if(ParentSpanId = '', 0, 1), Timestamp))) AS startSecond,
          fromUnixTimestamp64Nano(max(toUnixTimestamp64Nano(trace_detail_spans.Timestamp) + toInt64(trace_detail_spans.Duration))) AS endTime,
          intDiv(max(toUnixTimestamp64Nano(trace_detail_spans.Timestamp) + toInt64(trace_detail_spans.Duration)) - min(toUnixTimestamp64Nano(trace_detail_spans.Timestamp)), 1000) AS durationMicros,
          intDiv(argMin(trace_detail_spans.Duration, (if(ParentSpanId = '', 0, 1), Timestamp)), 1000) AS rootDurationMicros,
          count() AS spanCount,
          arrayDistinct(arrayPushFront(arraySort(groupUniqArray(trace_detail_spans.ServiceName)), argMin(trace_detail_spans.ServiceName, (if(ParentSpanId = '', 0, 1), Timestamp)))) AS services,
          argMin(trace_detail_spans.SpanName, (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanName,
          argMin(trace_detail_spans.SpanKind, (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanKind,
          argMin(trace_detail_spans.StatusCode, (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanStatusCode,
          argMin(if(trace_detail_spans.SpanAttributes['http.method'] != '', trace_detail_spans.SpanAttributes['http.method'], trace_detail_spans.SpanAttributes['http.request.method']), (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootHttpMethod,
          argMin(trace_detail_spans.SpanAttributes['http.route'], (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootHttpRoute,
          argMin(if(trace_detail_spans.SpanAttributes['http.status_code'] != '', trace_detail_spans.SpanAttributes['http.status_code'], trace_detail_spans.SpanAttributes['http.response.status_code']), (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootHttpStatusCode,
          argMin(toJSONString(map('http.method', SpanAttributes['http.method'], 'http.request.method', SpanAttributes['http.request.method'], 'http.route', SpanAttributes['http.route'], 'http.target', SpanAttributes['http.target'], 'http.status_code', SpanAttributes['http.status_code'], 'http.response.status_code', SpanAttributes['http.response.status_code'], 'http.url', SpanAttributes['http.url'], 'url.full', SpanAttributes['url.full'], 'url.path', SpanAttributes['url.path'], 'server.address', SpanAttributes['server.address'], 'net.peer.name', SpanAttributes['net.peer.name'], 'screen.name', SpanAttributes['screen.name'])), (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanAttributes,
          if(argMin(trace_detail_spans.StatusCode, (if(ParentSpanId = '', 0, 1), Timestamp)) = 'Error', 1, 0) AS hasError
        FROM trace_detail_spans
        WHERE trace_detail_spans.OrgId = 'org_sql_catalog'
          AND trace_detail_spans.Timestamp >= subtractHours(toDateTime('2026-01-01 10:30:00'), 1)
          AND trace_detail_spans.Timestamp <= addHours(toDateTime('2026-01-03 14:15:00'), 1)
          AND TraceId IN (SELECT traceId FROM (SELECT
          trace_list_mv.TraceId AS traceId,
          trace_list_mv.Timestamp AS ts,
          trace_list_mv.Duration AS d
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.ServiceName = 'api'
          AND trace_list_mv.DeploymentEnv = 'production'
        ORDER BY ts DESC, traceId DESC
        LIMIT 50))
        GROUP BY traceId
        ORDER BY startSecond DESC, traceId DESC
        LIMIT 50
        FORMAT JSON

-- spec:traces-list:baseline  [0ea84771]
SELECT
          traces.TraceId AS traceId,
          traces.Timestamp AS timestamp,
          traces.SpanId AS spanId,
          traces.ParentSpanId AS parentSpanId,
          traces.ServiceName AS serviceName,
          traces.SpanName AS spanName,
          traces.Duration / 1000000 AS durationMs,
          traces.StatusCode AS statusCode,
          traces.SpanKind AS spanKind,
          if(traces.StatusCode = 'Error', 1, 0) AS hasError,
          traces.SpanAttributes AS spanAttributes,
          traces.ResourceAttributes AS resourceAttributes
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND traces.ServiceName = 'api'
          AND coalesce(nullIf(traces.ResourceAttributes['deployment.environment.name'], ''), traces.ResourceAttributes['deployment.environment']) IN ('production')
          AND traces.Timestamp >= (SELECT min(ts) FROM (SELECT
          traces.Timestamp AS ts
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND traces.ServiceName = 'api'
          AND coalesce(nullIf(traces.ResourceAttributes['deployment.environment.name'], ''), traces.ResourceAttributes['deployment.environment']) IN ('production')
        ORDER BY ts DESC
        LIMIT 50))
        ORDER BY timestamp DESC
        LIMIT 50
        FORMAT JSON

-- spec:traces-list:bloom  [0ea84771]
SELECT
          traces.TraceId AS traceId,
          traces.Timestamp AS timestamp,
          traces.SpanId AS spanId,
          traces.ParentSpanId AS parentSpanId,
          traces.ServiceName AS serviceName,
          traces.SpanName AS spanName,
          traces.Duration / 1000000 AS durationMs,
          traces.StatusCode AS statusCode,
          traces.SpanKind AS spanKind,
          if(traces.StatusCode = 'Error', 1, 0) AS hasError,
          traces.SpanAttributes AS spanAttributes,
          traces.ResourceAttributes AS resourceAttributes
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND traces.ServiceName = 'api'
          AND coalesce(nullIf(traces.ResourceAttributes['deployment.environment.name'], ''), traces.ResourceAttributes['deployment.environment']) IN ('production')
          AND traces.Timestamp >= (SELECT min(ts) FROM (SELECT
          traces.Timestamp AS ts
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND traces.ServiceName = 'api'
          AND coalesce(nullIf(traces.ResourceAttributes['deployment.environment.name'], ''), traces.ResourceAttributes['deployment.environment']) IN ('production')
        ORDER BY ts DESC
        LIMIT 50))
        ORDER BY timestamp DESC
        LIMIT 50
        FORMAT JSON

-- spec:traces-list:text  [0ea84771]
SELECT
          traces.TraceId AS traceId,
          traces.Timestamp AS timestamp,
          traces.SpanId AS spanId,
          traces.ParentSpanId AS parentSpanId,
          traces.ServiceName AS serviceName,
          traces.SpanName AS spanName,
          traces.Duration / 1000000 AS durationMs,
          traces.StatusCode AS statusCode,
          traces.SpanKind AS spanKind,
          if(traces.StatusCode = 'Error', 1, 0) AS hasError,
          traces.SpanAttributes AS spanAttributes,
          traces.ResourceAttributes AS resourceAttributes
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND traces.ServiceName = 'api'
          AND coalesce(nullIf(traces.ResourceAttributes['deployment.environment.name'], ''), traces.ResourceAttributes['deployment.environment']) IN ('production')
          AND traces.Timestamp >= (SELECT min(ts) FROM (SELECT
          traces.Timestamp AS ts
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND traces.ServiceName = 'api'
          AND coalesce(nullIf(traces.ResourceAttributes['deployment.environment.name'], ''), traces.ResourceAttributes['deployment.environment']) IN ('production')
        ORDER BY ts DESC
        LIMIT 50))
        ORDER BY timestamp DESC
        LIMIT 50
        FORMAT JSON

-- spec:traces-stats:baseline  [fa38bf8f]
SELECT
          minIf(durationMin, traceCount > 0) / 1000000 AS minDurationMs,
          maxIf(durationMax, traceCount > 0) / 1000000 AS maxDurationMs,
          ifNull(ifNotFinite(arrayElement(quantilesTDigestMerge(0.5, 0.95)(durationQuantiles), 1) / 1000000, 0), 0) AS p50DurationMs,
          ifNull(ifNotFinite(arrayElement(quantilesTDigestMerge(0.5, 0.95)(durationQuantiles), 2) / 1000000, 0), 0) AS p95DurationMs
        FROM (
SELECT
          count() AS traceCount,
          min(trace_list_mv.Duration) AS durationMin,
          max(trace_list_mv.Duration) AS durationMax,
          quantilesTDigestState(0.5, 0.95)(Duration) AS durationQuantiles
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 10:30:00'
          AND trace_list_mv.Timestamp <= '2026-01-03 14:15:00'
          AND trace_list_mv.ServiceName = 'api'
          AND trace_list_mv.DeploymentEnv = 'production'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
UNION ALL
SELECT
          sum(trace_facets_hourly.TraceCount) AS traceCount,
          min(trace_facets_hourly.DurationMin) AS durationMin,
          max(trace_facets_hourly.DurationMax) AS durationMax,
          quantilesTDigestMergeState(0.5, 0.95)(DurationQuantiles) AS durationQuantiles
        FROM trace_facets_hourly
        WHERE trace_facets_hourly.OrgId = 'org_sql_catalog'
          AND trace_facets_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND trace_facets_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND trace_facets_hourly.ServiceName = 'api'
          AND trace_facets_hourly.DeploymentEnv = 'production'
) AS duration_tiers
        FORMAT JSON

-- spec:traces-timeseries-aggregates-mv:baseline  [60c78cfb]
SELECT
          traces_metric_windows.bucket AS bucket,
          traces_metric_windows.groupName AS groupName,
          sum(bWeightedCount) AS count,
          sum(traces_metric_windows.bSpanCount) AS spanCount,
          0 AS avgDuration,
          0 AS p50Duration,
          0 AS p95Duration,
          0 AS p99Duration,
          0 AS errorRate,
          0 AS satisfiedCount,
          0 AS toleratingCount,
          0 AS apdexScore,
          0 AS estimatedSpanCount
        FROM (
SELECT
          toStartOfInterval(traces.Timestamp, INTERVAL 3600 SECOND) AS bucket,
          'all' AS groupName,
          sum(traces.SampleRate) AS bWeightedCount,
          toFloat64(count()) AS bSpanCount,
          sum(toFloat64(Duration) * SampleRate) AS bWeightedDurationSum,
          sumIf(traces.SampleRate, traces.StatusCode = 'Error') AS bWeightedErrorCount,
          '' AS bDurationQuantiles
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND traces.ServiceName = 'api'
          AND coalesce(nullIf(traces.ResourceAttributes['deployment.environment.name'], ''), traces.ResourceAttributes['deployment.environment']) IN ('production')
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bucket, groupName
UNION ALL
SELECT
          toStartOfInterval(traces_aggregates_hourly.Hour, INTERVAL 3600 SECOND) AS bucket,
          'all' AS groupName,
          sum(traces_aggregates_hourly.WeightedCount) AS bWeightedCount,
          sum(traces_aggregates_hourly.WeightedCount) AS bSpanCount,
          sum(traces_aggregates_hourly.WeightedDurationSum) AS bWeightedDurationSum,
          sum(traces_aggregates_hourly.WeightedErrorCount) AS bWeightedErrorCount,
          '' AS bDurationQuantiles
        FROM traces_aggregates_hourly
        WHERE traces_aggregates_hourly.OrgId = 'org_sql_catalog'
          AND traces_aggregates_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND traces_aggregates_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND traces_aggregates_hourly.ServiceName = 'api'
          AND traces_aggregates_hourly.DeploymentEnv IN ('production')
        GROUP BY bucket, groupName
) AS traces_metric_windows
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- spec:traces-timeseries-all-metrics-grouped:baseline  [48780583]
SELECT
          toStartOfInterval(traces.Timestamp, INTERVAL 3600 SECOND) AS bucket,
          coalesce(nullIf(toString(traces.ServiceName), ''), 'all') AS groupName,
          sum(traces.SampleRate) AS count,
          count() AS spanCount,
          avg(traces.Duration) / 1000000 AS avgDuration,
          quantile(0.5)(traces.Duration) / 1000000 AS p50Duration,
          quantile(0.95)(traces.Duration) / 1000000 AS p95Duration,
          quantile(0.99)(traces.Duration) / 1000000 AS p99Duration,
          if(sum(traces.SampleRate) > 0, sumIf(traces.SampleRate, traces.StatusCode = 'Error') / sum(traces.SampleRate), 0) AS errorRate,
          countIf((NOT (traces.StatusCode = 'Error') AND traces.Duration / 1000000 < 500)) AS satisfiedCount,
          countIf((NOT (traces.StatusCode = 'Error') AND (traces.Duration / 1000000 >= 500 AND traces.Duration / 1000000 < 2000))) AS toleratingCount,
          if(count() > 0, round(countIf((NOT (traces.StatusCode = 'Error') AND traces.Duration / 1000000 < 500)) / count() + countIf((NOT (traces.StatusCode = 'Error') AND (traces.Duration / 1000000 >= 500 AND traces.Duration / 1000000 < 2000))) * 0.5 / count(), 4), 0) AS apdexScore,
          sum(traces.SampleRate) AS estimatedSpanCount
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND traces.ServiceName = 'api'
          AND coalesce(nullIf(traces.ResourceAttributes['deployment.environment.name'], ''), traces.ResourceAttributes['deployment.environment']) IN ('production')
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- spec:traces-timeseries-annual-daily-buckets:baseline  [92f96f42]
SELECT
          service_metric_windows.bucket AS bucket,
          service_metric_windows.groupName AS groupName,
          if(sum(bEstimatedSpanCount) > 0, sum(bEstimatedSpanCount), toFloat64(sum(bCount))) AS count,
          sum(service_metric_windows.bCount) AS spanCount,
          if(sum(bCount) > 0, sum(bDurationSum) / sum(bCount) / 1000000, 0) AS avgDuration,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 1) / 1000000 AS p50Duration,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 2) / 1000000 AS p95Duration,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 3) / 1000000 AS p99Duration,
          if(sum(bCount) > 0, sum(bErrorCount) / sum(bCount), 0) AS errorRate,
          sum(service_metric_windows.bSatisfiedCount) AS satisfiedCount,
          sum(service_metric_windows.bToleratingCount) AS toleratingCount,
          if(sum(service_metric_windows.bCount) > 0, round(sum(service_metric_windows.bSatisfiedCount) / sum(service_metric_windows.bCount) + sum(service_metric_windows.bToleratingCount) * 0.5 / sum(service_metric_windows.bCount), 4), 0) AS apdexScore,
          if(sum(bEstimatedSpanCount) > 0, sum(bEstimatedSpanCount), toFloat64(sum(bCount))) AS estimatedSpanCount
        FROM (
SELECT
          toStartOfInterval(service_overview_spans.Timestamp, INTERVAL 86400 SECOND) AS bucket,
          'all' AS groupName,
          count() AS bCount,
          sum(service_overview_spans.SampleRate) AS bEstimatedSpanCount,
          countIf(service_overview_spans.StatusCode = 'Error') AS bErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          countIf((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration < 500000000)) AS bSatisfiedCount,
          countIf(((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration >= 500000000) AND service_overview_spans.Duration < 2000000000)) AS bToleratingCount
        FROM service_overview_spans
        WHERE service_overview_spans.OrgId = 'org_sql_catalog'
          AND service_overview_spans.Timestamp >= '2025-11-01 00:00:00'
          AND service_overview_spans.Timestamp <= '2025-11-25 00:00:00'
          AND (Timestamp < if(toDateTime('2025-11-01 00:00:00') = toStartOfMinute(toDateTime('2025-11-01 00:00:00')), toStartOfMinute(toDateTime('2025-11-01 00:00:00')), toStartOfMinute(toDateTime('2025-11-01 00:00:00')) + INTERVAL 1 MINUTE) OR Timestamp >= toStartOfMinute(toDateTime('2025-11-25 00:00:00')))
        GROUP BY bucket, groupName
UNION ALL
SELECT
          toStartOfInterval(service_overview_minutely.Minute, INTERVAL 86400 SECOND) AS bucket,
          'all' AS groupName,
          sum(service_overview_minutely.SpanCount) AS bCount,
          sum(service_overview_minutely.EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(service_overview_minutely.ErrorCount) AS bErrorCount,
          sum(service_overview_minutely.DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          sum(service_overview_minutely.ApdexSatisfiedCount) AS bSatisfiedCount,
          sum(service_overview_minutely.ApdexToleratingCount) AS bToleratingCount
        FROM service_overview_minutely
        WHERE service_overview_minutely.OrgId = 'org_sql_catalog'
          AND service_overview_minutely.Minute >= if(toDateTime('2025-11-01 00:00:00') = toStartOfMinute(toDateTime('2025-11-01 00:00:00')), toStartOfMinute(toDateTime('2025-11-01 00:00:00')), toStartOfMinute(toDateTime('2025-11-01 00:00:00')) + INTERVAL 1 MINUTE)
          AND service_overview_minutely.Minute < toStartOfMinute(toDateTime('2025-11-25 00:00:00'))
          AND (Minute < if(toDateTime('2025-11-01 00:00:00') = toStartOfHour(toDateTime('2025-11-01 00:00:00')), toStartOfHour(toDateTime('2025-11-01 00:00:00')), toStartOfHour(toDateTime('2025-11-01 00:00:00')) + INTERVAL 1 HOUR) OR Minute >= toStartOfHour(toDateTime('2025-11-25 00:00:00')))
        GROUP BY bucket, groupName
UNION ALL
SELECT
          toStartOfInterval(service_overview_hourly.Hour, INTERVAL 86400 SECOND) AS bucket,
          'all' AS groupName,
          sum(service_overview_hourly.SpanCount) AS bCount,
          sum(service_overview_hourly.EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(service_overview_hourly.ErrorCount) AS bErrorCount,
          sum(service_overview_hourly.DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          sum(service_overview_hourly.ApdexSatisfiedCount) AS bSatisfiedCount,
          sum(service_overview_hourly.ApdexToleratingCount) AS bToleratingCount
        FROM service_overview_hourly
        WHERE service_overview_hourly.OrgId = 'org_sql_catalog'
          AND service_overview_hourly.Hour >= if(toDateTime('2025-11-01 00:00:00') = toStartOfHour(toDateTime('2025-11-01 00:00:00')), toStartOfHour(toDateTime('2025-11-01 00:00:00')), toStartOfHour(toDateTime('2025-11-01 00:00:00')) + INTERVAL 1 HOUR)
          AND service_overview_hourly.Hour < toStartOfHour(toDateTime('2025-11-25 00:00:00'))
        GROUP BY bucket, groupName
) AS service_metric_windows
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- spec:traces-timeseries-annual-grouped-all-tiers:baseline  [2bc13fb6]
SELECT
          service_metric_windows.bucket AS bucket,
          service_metric_windows.groupName AS groupName,
          if(sum(bEstimatedSpanCount) > 0, sum(bEstimatedSpanCount), toFloat64(sum(bCount))) AS count,
          sum(service_metric_windows.bCount) AS spanCount,
          if(sum(bCount) > 0, sum(bDurationSum) / sum(bCount) / 1000000, 0) AS avgDuration,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 1) / 1000000 AS p50Duration,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 2) / 1000000 AS p95Duration,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 3) / 1000000 AS p99Duration,
          if(sum(bCount) > 0, sum(bErrorCount) / sum(bCount), 0) AS errorRate,
          sum(service_metric_windows.bSatisfiedCount) AS satisfiedCount,
          sum(service_metric_windows.bToleratingCount) AS toleratingCount,
          if(sum(service_metric_windows.bCount) > 0, round(sum(service_metric_windows.bSatisfiedCount) / sum(service_metric_windows.bCount) + sum(service_metric_windows.bToleratingCount) * 0.5 / sum(service_metric_windows.bCount), 4), 0) AS apdexScore,
          if(sum(bEstimatedSpanCount) > 0, sum(bEstimatedSpanCount), toFloat64(sum(bCount))) AS estimatedSpanCount
        FROM (
SELECT
          toStartOfInterval(service_overview_spans.Timestamp, INTERVAL 3600 SECOND) AS bucket,
          coalesce(nullIf(toString(service_overview_spans.ServiceName), ''), 'all') AS groupName,
          count() AS bCount,
          sum(service_overview_spans.SampleRate) AS bEstimatedSpanCount,
          countIf(service_overview_spans.StatusCode = 'Error') AS bErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          countIf((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration < 500000000)) AS bSatisfiedCount,
          countIf(((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration >= 500000000) AND service_overview_spans.Duration < 2000000000)) AS bToleratingCount
        FROM service_overview_spans
        WHERE service_overview_spans.OrgId = 'org_sql_catalog'
          AND service_overview_spans.Timestamp >= '2026-01-01 10:30:00'
          AND service_overview_spans.Timestamp <= '2026-01-03 14:15:00'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 MINUTE) OR Timestamp >= toStartOfMinute(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bucket, groupName
UNION ALL
SELECT
          toStartOfInterval(service_overview_minutely.Minute, INTERVAL 3600 SECOND) AS bucket,
          coalesce(nullIf(toString(service_overview_minutely.ServiceName), ''), 'all') AS groupName,
          sum(service_overview_minutely.SpanCount) AS bCount,
          sum(service_overview_minutely.EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(service_overview_minutely.ErrorCount) AS bErrorCount,
          sum(service_overview_minutely.DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          sum(service_overview_minutely.ApdexSatisfiedCount) AS bSatisfiedCount,
          sum(service_overview_minutely.ApdexToleratingCount) AS bToleratingCount
        FROM service_overview_minutely
        WHERE service_overview_minutely.OrgId = 'org_sql_catalog'
          AND service_overview_minutely.Minute >= if(toDateTime('2026-01-01 10:30:00') = toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 MINUTE)
          AND service_overview_minutely.Minute < toStartOfMinute(toDateTime('2026-01-03 14:15:00'))
          AND (Minute < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Minute >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bucket, groupName
UNION ALL
SELECT
          toStartOfInterval(service_overview_hourly.Hour, INTERVAL 3600 SECOND) AS bucket,
          coalesce(nullIf(toString(service_overview_hourly.ServiceName), ''), 'all') AS groupName,
          sum(service_overview_hourly.SpanCount) AS bCount,
          sum(service_overview_hourly.EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(service_overview_hourly.ErrorCount) AS bErrorCount,
          sum(service_overview_hourly.DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          sum(service_overview_hourly.ApdexSatisfiedCount) AS bSatisfiedCount,
          sum(service_overview_hourly.ApdexToleratingCount) AS bToleratingCount
        FROM service_overview_hourly
        WHERE service_overview_hourly.OrgId = 'org_sql_catalog'
          AND service_overview_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND service_overview_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bucket, groupName
) AS service_metric_windows
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- spec:traces-timeseries-annual-grouped-series-cap:baseline  [c422e4bd]
SELECT
          bucket AS bucket,
          groupName AS groupName,
          count AS count,
          spanCount AS spanCount,
          avgDuration AS avgDuration,
          p50Duration AS p50Duration,
          p95Duration AS p95Duration,
          p99Duration AS p99Duration,
          errorRate AS errorRate,
          satisfiedCount AS satisfiedCount,
          toleratingCount AS toleratingCount,
          apdexScore AS apdexScore,
          estimatedSpanCount AS estimatedSpanCount
        FROM (SELECT
          bucket AS bucket,
          groupName AS groupName,
          count AS count,
          spanCount AS spanCount,
          avgDuration AS avgDuration,
          p50Duration AS p50Duration,
          p95Duration AS p95Duration,
          p99Duration AS p99Duration,
          errorRate AS errorRate,
          satisfiedCount AS satisfiedCount,
          toleratingCount AS toleratingCount,
          apdexScore AS apdexScore,
          estimatedSpanCount AS estimatedSpanCount,
          dense_rank() OVER (ORDER BY __series_peak DESC, groupName ASC) AS __series_rank
        FROM (SELECT
          bucket AS bucket,
          groupName AS groupName,
          count AS count,
          spanCount AS spanCount,
          avgDuration AS avgDuration,
          p50Duration AS p50Duration,
          p95Duration AS p95Duration,
          p99Duration AS p99Duration,
          errorRate AS errorRate,
          satisfiedCount AS satisfiedCount,
          toleratingCount AS toleratingCount,
          apdexScore AS apdexScore,
          estimatedSpanCount AS estimatedSpanCount,
          max(count) OVER (PARTITION BY groupName) AS __series_peak
        FROM (SELECT
          service_metric_windows.bucket AS bucket,
          service_metric_windows.groupName AS groupName,
          if(sum(bEstimatedSpanCount) > 0, sum(bEstimatedSpanCount), toFloat64(sum(bCount))) AS count,
          sum(service_metric_windows.bCount) AS spanCount,
          if(sum(bCount) > 0, sum(bDurationSum) / sum(bCount) / 1000000, 0) AS avgDuration,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 1) / 1000000 AS p50Duration,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 2) / 1000000 AS p95Duration,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 3) / 1000000 AS p99Duration,
          if(sum(bCount) > 0, sum(bErrorCount) / sum(bCount), 0) AS errorRate,
          sum(service_metric_windows.bSatisfiedCount) AS satisfiedCount,
          sum(service_metric_windows.bToleratingCount) AS toleratingCount,
          if(sum(service_metric_windows.bCount) > 0, round(sum(service_metric_windows.bSatisfiedCount) / sum(service_metric_windows.bCount) + sum(service_metric_windows.bToleratingCount) * 0.5 / sum(service_metric_windows.bCount), 4), 0) AS apdexScore,
          if(sum(bEstimatedSpanCount) > 0, sum(bEstimatedSpanCount), toFloat64(sum(bCount))) AS estimatedSpanCount
        FROM (
SELECT
          toStartOfInterval(service_overview_spans.Timestamp, INTERVAL 300 SECOND) AS bucket,
          coalesce(nullIf(toString(service_overview_spans.ServiceName), ''), 'all') AS groupName,
          count() AS bCount,
          sum(service_overview_spans.SampleRate) AS bEstimatedSpanCount,
          countIf(service_overview_spans.StatusCode = 'Error') AS bErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          countIf((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration < 500000000)) AS bSatisfiedCount,
          countIf(((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration >= 500000000) AND service_overview_spans.Duration < 2000000000)) AS bToleratingCount
        FROM service_overview_spans
        WHERE service_overview_spans.OrgId = 'org_sql_catalog'
          AND service_overview_spans.Timestamp >= '2026-01-03 10:30:00'
          AND service_overview_spans.Timestamp <= '2026-01-03 14:15:00'
          AND (Timestamp < if(toDateTime('2026-01-03 10:30:00') = toStartOfMinute(toDateTime('2026-01-03 10:30:00')), toStartOfMinute(toDateTime('2026-01-03 10:30:00')), toStartOfMinute(toDateTime('2026-01-03 10:30:00')) + INTERVAL 1 MINUTE) OR Timestamp >= toStartOfMinute(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bucket, groupName
UNION ALL
SELECT
          toStartOfInterval(service_overview_minutely.Minute, INTERVAL 300 SECOND) AS bucket,
          coalesce(nullIf(toString(service_overview_minutely.ServiceName), ''), 'all') AS groupName,
          sum(service_overview_minutely.SpanCount) AS bCount,
          sum(service_overview_minutely.EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(service_overview_minutely.ErrorCount) AS bErrorCount,
          sum(service_overview_minutely.DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          sum(service_overview_minutely.ApdexSatisfiedCount) AS bSatisfiedCount,
          sum(service_overview_minutely.ApdexToleratingCount) AS bToleratingCount
        FROM service_overview_minutely
        WHERE service_overview_minutely.OrgId = 'org_sql_catalog'
          AND service_overview_minutely.Minute >= if(toDateTime('2026-01-03 10:30:00') = toStartOfMinute(toDateTime('2026-01-03 10:30:00')), toStartOfMinute(toDateTime('2026-01-03 10:30:00')), toStartOfMinute(toDateTime('2026-01-03 10:30:00')) + INTERVAL 1 MINUTE)
          AND service_overview_minutely.Minute < toStartOfMinute(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bucket, groupName
) AS service_metric_windows
        GROUP BY bucket, groupName) AS __series_base) AS __series_peaks) AS __series_ranked
        WHERE __series_rank <= 10
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- spec:traces-timeseries-annual-minutely-grouped:baseline  [4d383a1a]
SELECT
          service_metric_windows.bucket AS bucket,
          service_metric_windows.groupName AS groupName,
          if(sum(bEstimatedSpanCount) > 0, sum(bEstimatedSpanCount), toFloat64(sum(bCount))) AS count,
          sum(service_metric_windows.bCount) AS spanCount,
          if(sum(bCount) > 0, sum(bDurationSum) / sum(bCount) / 1000000, 0) AS avgDuration,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 1) / 1000000 AS p50Duration,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 2) / 1000000 AS p95Duration,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 3) / 1000000 AS p99Duration,
          if(sum(bCount) > 0, sum(bErrorCount) / sum(bCount), 0) AS errorRate,
          sum(service_metric_windows.bSatisfiedCount) AS satisfiedCount,
          sum(service_metric_windows.bToleratingCount) AS toleratingCount,
          if(sum(service_metric_windows.bCount) > 0, round(sum(service_metric_windows.bSatisfiedCount) / sum(service_metric_windows.bCount) + sum(service_metric_windows.bToleratingCount) * 0.5 / sum(service_metric_windows.bCount), 4), 0) AS apdexScore,
          if(sum(bEstimatedSpanCount) > 0, sum(bEstimatedSpanCount), toFloat64(sum(bCount))) AS estimatedSpanCount
        FROM (
SELECT
          toStartOfInterval(service_overview_spans.Timestamp, INTERVAL 300 SECOND) AS bucket,
          coalesce(nullIf(toString(service_overview_spans.ServiceName), ''), 'all') AS groupName,
          count() AS bCount,
          sum(service_overview_spans.SampleRate) AS bEstimatedSpanCount,
          countIf(service_overview_spans.StatusCode = 'Error') AS bErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          countIf((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration < 500000000)) AS bSatisfiedCount,
          countIf(((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration >= 500000000) AND service_overview_spans.Duration < 2000000000)) AS bToleratingCount
        FROM service_overview_spans
        WHERE service_overview_spans.OrgId = 'org_sql_catalog'
          AND service_overview_spans.Timestamp >= '2026-01-03 10:30:00'
          AND service_overview_spans.Timestamp <= '2026-01-03 14:15:00'
          AND service_overview_spans.ServiceName = 'api'
          AND service_overview_spans.DeploymentEnv IN ('production')
          AND (Timestamp < if(toDateTime('2026-01-03 10:30:00') = toStartOfMinute(toDateTime('2026-01-03 10:30:00')), toStartOfMinute(toDateTime('2026-01-03 10:30:00')), toStartOfMinute(toDateTime('2026-01-03 10:30:00')) + INTERVAL 1 MINUTE) OR Timestamp >= toStartOfMinute(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bucket, groupName
UNION ALL
SELECT
          toStartOfInterval(service_overview_minutely.Minute, INTERVAL 300 SECOND) AS bucket,
          coalesce(nullIf(toString(service_overview_minutely.ServiceName), ''), 'all') AS groupName,
          sum(service_overview_minutely.SpanCount) AS bCount,
          sum(service_overview_minutely.EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(service_overview_minutely.ErrorCount) AS bErrorCount,
          sum(service_overview_minutely.DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          sum(service_overview_minutely.ApdexSatisfiedCount) AS bSatisfiedCount,
          sum(service_overview_minutely.ApdexToleratingCount) AS bToleratingCount
        FROM service_overview_minutely
        WHERE service_overview_minutely.OrgId = 'org_sql_catalog'
          AND service_overview_minutely.ServiceName = 'api'
          AND service_overview_minutely.DeploymentEnv IN ('production')
          AND service_overview_minutely.Minute >= if(toDateTime('2026-01-03 10:30:00') = toStartOfMinute(toDateTime('2026-01-03 10:30:00')), toStartOfMinute(toDateTime('2026-01-03 10:30:00')), toStartOfMinute(toDateTime('2026-01-03 10:30:00')) + INTERVAL 1 MINUTE)
          AND service_overview_minutely.Minute < toStartOfMinute(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bucket, groupName
) AS service_metric_windows
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- spec:traces-timeseries-annual-rejected-status-code:baseline  [3b434eaf]
SELECT
          toStartOfInterval(service_overview_spans.Timestamp, INTERVAL 3600 SECOND) AS bucket,
          coalesce(nullIf(toString(service_overview_spans.StatusCode), ''), 'all') AS groupName,
          sum(service_overview_spans.SampleRate) AS count,
          count() AS spanCount,
          avg(service_overview_spans.Duration) / 1000000 AS avgDuration,
          quantile(0.5)(service_overview_spans.Duration) / 1000000 AS p50Duration,
          quantile(0.95)(service_overview_spans.Duration) / 1000000 AS p95Duration,
          quantile(0.99)(service_overview_spans.Duration) / 1000000 AS p99Duration,
          if(sum(service_overview_spans.SampleRate) > 0, sumIf(service_overview_spans.SampleRate, service_overview_spans.StatusCode = 'Error') / sum(service_overview_spans.SampleRate), 0) AS errorRate,
          countIf((NOT (service_overview_spans.StatusCode = 'Error') AND service_overview_spans.Duration / 1000000 < 500)) AS satisfiedCount,
          countIf((NOT (service_overview_spans.StatusCode = 'Error') AND (service_overview_spans.Duration / 1000000 >= 500 AND service_overview_spans.Duration / 1000000 < 2000))) AS toleratingCount,
          if(count() > 0, round(countIf((NOT (service_overview_spans.StatusCode = 'Error') AND service_overview_spans.Duration / 1000000 < 500)) / count() + countIf((NOT (service_overview_spans.StatusCode = 'Error') AND (service_overview_spans.Duration / 1000000 >= 500 AND service_overview_spans.Duration / 1000000 < 2000))) * 0.5 / count(), 4), 0) AS apdexScore,
          sum(service_overview_spans.SampleRate) AS estimatedSpanCount
        FROM service_overview_spans
        WHERE service_overview_spans.OrgId = 'org_sql_catalog'
          AND service_overview_spans.Timestamp >= '2026-01-01 10:30:00'
          AND service_overview_spans.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- spec:traces-timeseries-annual-single-apdex:baseline  [06c5a15d]
SELECT
          service_metric_windows.bucket AS bucket,
          service_metric_windows.groupName AS groupName,
          if(sum(bEstimatedSpanCount) > 0, sum(bEstimatedSpanCount), toFloat64(sum(bCount))) AS count,
          sum(service_metric_windows.bCount) AS spanCount,
          0 AS avgDuration,
          0 AS p50Duration,
          0 AS p95Duration,
          0 AS p99Duration,
          0 AS errorRate,
          sum(service_metric_windows.bSatisfiedCount) AS satisfiedCount,
          sum(service_metric_windows.bToleratingCount) AS toleratingCount,
          if(sum(service_metric_windows.bCount) > 0, round(sum(service_metric_windows.bSatisfiedCount) / sum(service_metric_windows.bCount) + sum(service_metric_windows.bToleratingCount) * 0.5 / sum(service_metric_windows.bCount), 4), 0) AS apdexScore,
          if(sum(bEstimatedSpanCount) > 0, sum(bEstimatedSpanCount), toFloat64(sum(bCount))) AS estimatedSpanCount
        FROM (
SELECT
          toStartOfInterval(service_overview_spans.Timestamp, INTERVAL 300 SECOND) AS bucket,
          coalesce(nullIf(toString(service_overview_spans.ServiceName), ''), 'all') AS groupName,
          count() AS bCount,
          sum(service_overview_spans.SampleRate) AS bEstimatedSpanCount,
          0 AS bErrorCount,
          0 AS bDurationSum,
          '' AS bDurationQuantiles,
          countIf((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration < 500000000)) AS bSatisfiedCount,
          countIf(((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration >= 500000000) AND service_overview_spans.Duration < 2000000000)) AS bToleratingCount
        FROM service_overview_spans
        WHERE service_overview_spans.OrgId = 'org_sql_catalog'
          AND service_overview_spans.Timestamp >= '2026-01-03 10:30:00'
          AND service_overview_spans.Timestamp <= '2026-01-03 14:15:00'
          AND (Timestamp < if(toDateTime('2026-01-03 10:30:00') = toStartOfMinute(toDateTime('2026-01-03 10:30:00')), toStartOfMinute(toDateTime('2026-01-03 10:30:00')), toStartOfMinute(toDateTime('2026-01-03 10:30:00')) + INTERVAL 1 MINUTE) OR Timestamp >= toStartOfMinute(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bucket, groupName
UNION ALL
SELECT
          toStartOfInterval(service_overview_minutely.Minute, INTERVAL 300 SECOND) AS bucket,
          coalesce(nullIf(toString(service_overview_minutely.ServiceName), ''), 'all') AS groupName,
          sum(service_overview_minutely.SpanCount) AS bCount,
          sum(service_overview_minutely.EstimatedSpanCount) AS bEstimatedSpanCount,
          0 AS bErrorCount,
          0 AS bDurationSum,
          '' AS bDurationQuantiles,
          sum(service_overview_minutely.ApdexSatisfiedCount) AS bSatisfiedCount,
          sum(service_overview_minutely.ApdexToleratingCount) AS bToleratingCount
        FROM service_overview_minutely
        WHERE service_overview_minutely.OrgId = 'org_sql_catalog'
          AND service_overview_minutely.Minute >= if(toDateTime('2026-01-03 10:30:00') = toStartOfMinute(toDateTime('2026-01-03 10:30:00')), toStartOfMinute(toDateTime('2026-01-03 10:30:00')), toStartOfMinute(toDateTime('2026-01-03 10:30:00')) + INTERVAL 1 MINUTE)
          AND service_overview_minutely.Minute < toStartOfMinute(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bucket, groupName
) AS service_metric_windows
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- spec:traces-timeseries-annual-single-avg_duration:baseline  [f4971db3]
SELECT
          service_metric_windows.bucket AS bucket,
          service_metric_windows.groupName AS groupName,
          if(sum(bEstimatedSpanCount) > 0, sum(bEstimatedSpanCount), toFloat64(sum(bCount))) AS count,
          sum(service_metric_windows.bCount) AS spanCount,
          if(sum(bCount) > 0, sum(bDurationSum) / sum(bCount) / 1000000, 0) AS avgDuration,
          0 AS p50Duration,
          0 AS p95Duration,
          0 AS p99Duration,
          0 AS errorRate,
          0 AS satisfiedCount,
          0 AS toleratingCount,
          0 AS apdexScore,
          if(sum(bEstimatedSpanCount) > 0, sum(bEstimatedSpanCount), toFloat64(sum(bCount))) AS estimatedSpanCount
        FROM (
SELECT
          toStartOfInterval(service_overview_spans.Timestamp, INTERVAL 300 SECOND) AS bucket,
          coalesce(nullIf(toString(service_overview_spans.ServiceName), ''), 'all') AS groupName,
          count() AS bCount,
          sum(service_overview_spans.SampleRate) AS bEstimatedSpanCount,
          0 AS bErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          '' AS bDurationQuantiles,
          0 AS bSatisfiedCount,
          0 AS bToleratingCount
        FROM service_overview_spans
        WHERE service_overview_spans.OrgId = 'org_sql_catalog'
          AND service_overview_spans.Timestamp >= '2026-01-03 10:30:00'
          AND service_overview_spans.Timestamp <= '2026-01-03 14:15:00'
          AND (Timestamp < if(toDateTime('2026-01-03 10:30:00') = toStartOfMinute(toDateTime('2026-01-03 10:30:00')), toStartOfMinute(toDateTime('2026-01-03 10:30:00')), toStartOfMinute(toDateTime('2026-01-03 10:30:00')) + INTERVAL 1 MINUTE) OR Timestamp >= toStartOfMinute(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bucket, groupName
UNION ALL
SELECT
          toStartOfInterval(service_overview_minutely.Minute, INTERVAL 300 SECOND) AS bucket,
          coalesce(nullIf(toString(service_overview_minutely.ServiceName), ''), 'all') AS groupName,
          sum(service_overview_minutely.SpanCount) AS bCount,
          sum(service_overview_minutely.EstimatedSpanCount) AS bEstimatedSpanCount,
          0 AS bErrorCount,
          sum(service_overview_minutely.DurationSum) AS bDurationSum,
          '' AS bDurationQuantiles,
          0 AS bSatisfiedCount,
          0 AS bToleratingCount
        FROM service_overview_minutely
        WHERE service_overview_minutely.OrgId = 'org_sql_catalog'
          AND service_overview_minutely.Minute >= if(toDateTime('2026-01-03 10:30:00') = toStartOfMinute(toDateTime('2026-01-03 10:30:00')), toStartOfMinute(toDateTime('2026-01-03 10:30:00')), toStartOfMinute(toDateTime('2026-01-03 10:30:00')) + INTERVAL 1 MINUTE)
          AND service_overview_minutely.Minute < toStartOfMinute(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bucket, groupName
) AS service_metric_windows
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- spec:traces-timeseries-annual-single-count:baseline  [3a2fd990]
SELECT
          service_metric_windows.bucket AS bucket,
          service_metric_windows.groupName AS groupName,
          if(sum(bEstimatedSpanCount) > 0, sum(bEstimatedSpanCount), toFloat64(sum(bCount))) AS count,
          sum(service_metric_windows.bCount) AS spanCount,
          0 AS avgDuration,
          0 AS p50Duration,
          0 AS p95Duration,
          0 AS p99Duration,
          0 AS errorRate,
          0 AS satisfiedCount,
          0 AS toleratingCount,
          0 AS apdexScore,
          if(sum(bEstimatedSpanCount) > 0, sum(bEstimatedSpanCount), toFloat64(sum(bCount))) AS estimatedSpanCount
        FROM (
SELECT
          toStartOfInterval(service_overview_spans.Timestamp, INTERVAL 300 SECOND) AS bucket,
          coalesce(nullIf(toString(service_overview_spans.ServiceName), ''), 'all') AS groupName,
          count() AS bCount,
          sum(service_overview_spans.SampleRate) AS bEstimatedSpanCount,
          0 AS bErrorCount,
          0 AS bDurationSum,
          '' AS bDurationQuantiles,
          0 AS bSatisfiedCount,
          0 AS bToleratingCount
        FROM service_overview_spans
        WHERE service_overview_spans.OrgId = 'org_sql_catalog'
          AND service_overview_spans.Timestamp >= '2026-01-03 10:30:00'
          AND service_overview_spans.Timestamp <= '2026-01-03 14:15:00'
          AND (Timestamp < if(toDateTime('2026-01-03 10:30:00') = toStartOfMinute(toDateTime('2026-01-03 10:30:00')), toStartOfMinute(toDateTime('2026-01-03 10:30:00')), toStartOfMinute(toDateTime('2026-01-03 10:30:00')) + INTERVAL 1 MINUTE) OR Timestamp >= toStartOfMinute(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bucket, groupName
UNION ALL
SELECT
          toStartOfInterval(service_overview_minutely.Minute, INTERVAL 300 SECOND) AS bucket,
          coalesce(nullIf(toString(service_overview_minutely.ServiceName), ''), 'all') AS groupName,
          sum(service_overview_minutely.SpanCount) AS bCount,
          sum(service_overview_minutely.EstimatedSpanCount) AS bEstimatedSpanCount,
          0 AS bErrorCount,
          0 AS bDurationSum,
          '' AS bDurationQuantiles,
          0 AS bSatisfiedCount,
          0 AS bToleratingCount
        FROM service_overview_minutely
        WHERE service_overview_minutely.OrgId = 'org_sql_catalog'
          AND service_overview_minutely.Minute >= if(toDateTime('2026-01-03 10:30:00') = toStartOfMinute(toDateTime('2026-01-03 10:30:00')), toStartOfMinute(toDateTime('2026-01-03 10:30:00')), toStartOfMinute(toDateTime('2026-01-03 10:30:00')) + INTERVAL 1 MINUTE)
          AND service_overview_minutely.Minute < toStartOfMinute(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bucket, groupName
) AS service_metric_windows
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- spec:traces-timeseries-annual-single-error_rate:baseline  [a58c018a]
SELECT
          service_metric_windows.bucket AS bucket,
          service_metric_windows.groupName AS groupName,
          if(sum(bEstimatedSpanCount) > 0, sum(bEstimatedSpanCount), toFloat64(sum(bCount))) AS count,
          sum(service_metric_windows.bCount) AS spanCount,
          0 AS avgDuration,
          0 AS p50Duration,
          0 AS p95Duration,
          0 AS p99Duration,
          if(sum(bCount) > 0, sum(bErrorCount) / sum(bCount), 0) AS errorRate,
          0 AS satisfiedCount,
          0 AS toleratingCount,
          0 AS apdexScore,
          if(sum(bEstimatedSpanCount) > 0, sum(bEstimatedSpanCount), toFloat64(sum(bCount))) AS estimatedSpanCount
        FROM (
SELECT
          toStartOfInterval(service_overview_spans.Timestamp, INTERVAL 300 SECOND) AS bucket,
          coalesce(nullIf(toString(service_overview_spans.ServiceName), ''), 'all') AS groupName,
          count() AS bCount,
          sum(service_overview_spans.SampleRate) AS bEstimatedSpanCount,
          countIf(service_overview_spans.StatusCode = 'Error') AS bErrorCount,
          0 AS bDurationSum,
          '' AS bDurationQuantiles,
          0 AS bSatisfiedCount,
          0 AS bToleratingCount
        FROM service_overview_spans
        WHERE service_overview_spans.OrgId = 'org_sql_catalog'
          AND service_overview_spans.Timestamp >= '2026-01-03 10:30:00'
          AND service_overview_spans.Timestamp <= '2026-01-03 14:15:00'
          AND (Timestamp < if(toDateTime('2026-01-03 10:30:00') = toStartOfMinute(toDateTime('2026-01-03 10:30:00')), toStartOfMinute(toDateTime('2026-01-03 10:30:00')), toStartOfMinute(toDateTime('2026-01-03 10:30:00')) + INTERVAL 1 MINUTE) OR Timestamp >= toStartOfMinute(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bucket, groupName
UNION ALL
SELECT
          toStartOfInterval(service_overview_minutely.Minute, INTERVAL 300 SECOND) AS bucket,
          coalesce(nullIf(toString(service_overview_minutely.ServiceName), ''), 'all') AS groupName,
          sum(service_overview_minutely.SpanCount) AS bCount,
          sum(service_overview_minutely.EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(service_overview_minutely.ErrorCount) AS bErrorCount,
          0 AS bDurationSum,
          '' AS bDurationQuantiles,
          0 AS bSatisfiedCount,
          0 AS bToleratingCount
        FROM service_overview_minutely
        WHERE service_overview_minutely.OrgId = 'org_sql_catalog'
          AND service_overview_minutely.Minute >= if(toDateTime('2026-01-03 10:30:00') = toStartOfMinute(toDateTime('2026-01-03 10:30:00')), toStartOfMinute(toDateTime('2026-01-03 10:30:00')), toStartOfMinute(toDateTime('2026-01-03 10:30:00')) + INTERVAL 1 MINUTE)
          AND service_overview_minutely.Minute < toStartOfMinute(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bucket, groupName
) AS service_metric_windows
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- spec:traces-timeseries-annual-single-p50_duration:baseline  [8501840e]
SELECT
          service_metric_windows.bucket AS bucket,
          service_metric_windows.groupName AS groupName,
          if(sum(bEstimatedSpanCount) > 0, sum(bEstimatedSpanCount), toFloat64(sum(bCount))) AS count,
          sum(service_metric_windows.bCount) AS spanCount,
          0 AS avgDuration,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 1) / 1000000 AS p50Duration,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 2) / 1000000 AS p95Duration,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 3) / 1000000 AS p99Duration,
          0 AS errorRate,
          0 AS satisfiedCount,
          0 AS toleratingCount,
          0 AS apdexScore,
          if(sum(bEstimatedSpanCount) > 0, sum(bEstimatedSpanCount), toFloat64(sum(bCount))) AS estimatedSpanCount
        FROM (
SELECT
          toStartOfInterval(service_overview_spans.Timestamp, INTERVAL 300 SECOND) AS bucket,
          coalesce(nullIf(toString(service_overview_spans.ServiceName), ''), 'all') AS groupName,
          count() AS bCount,
          sum(service_overview_spans.SampleRate) AS bEstimatedSpanCount,
          0 AS bErrorCount,
          0 AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          0 AS bSatisfiedCount,
          0 AS bToleratingCount
        FROM service_overview_spans
        WHERE service_overview_spans.OrgId = 'org_sql_catalog'
          AND service_overview_spans.Timestamp >= '2026-01-03 10:30:00'
          AND service_overview_spans.Timestamp <= '2026-01-03 14:15:00'
          AND (Timestamp < if(toDateTime('2026-01-03 10:30:00') = toStartOfMinute(toDateTime('2026-01-03 10:30:00')), toStartOfMinute(toDateTime('2026-01-03 10:30:00')), toStartOfMinute(toDateTime('2026-01-03 10:30:00')) + INTERVAL 1 MINUTE) OR Timestamp >= toStartOfMinute(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bucket, groupName
UNION ALL
SELECT
          toStartOfInterval(service_overview_minutely.Minute, INTERVAL 300 SECOND) AS bucket,
          coalesce(nullIf(toString(service_overview_minutely.ServiceName), ''), 'all') AS groupName,
          sum(service_overview_minutely.SpanCount) AS bCount,
          sum(service_overview_minutely.EstimatedSpanCount) AS bEstimatedSpanCount,
          0 AS bErrorCount,
          0 AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          0 AS bSatisfiedCount,
          0 AS bToleratingCount
        FROM service_overview_minutely
        WHERE service_overview_minutely.OrgId = 'org_sql_catalog'
          AND service_overview_minutely.Minute >= if(toDateTime('2026-01-03 10:30:00') = toStartOfMinute(toDateTime('2026-01-03 10:30:00')), toStartOfMinute(toDateTime('2026-01-03 10:30:00')), toStartOfMinute(toDateTime('2026-01-03 10:30:00')) + INTERVAL 1 MINUTE)
          AND service_overview_minutely.Minute < toStartOfMinute(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bucket, groupName
) AS service_metric_windows
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- spec:traces-timeseries-annual-single-p95_duration:baseline  [8501840e]
SELECT
          service_metric_windows.bucket AS bucket,
          service_metric_windows.groupName AS groupName,
          if(sum(bEstimatedSpanCount) > 0, sum(bEstimatedSpanCount), toFloat64(sum(bCount))) AS count,
          sum(service_metric_windows.bCount) AS spanCount,
          0 AS avgDuration,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 1) / 1000000 AS p50Duration,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 2) / 1000000 AS p95Duration,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 3) / 1000000 AS p99Duration,
          0 AS errorRate,
          0 AS satisfiedCount,
          0 AS toleratingCount,
          0 AS apdexScore,
          if(sum(bEstimatedSpanCount) > 0, sum(bEstimatedSpanCount), toFloat64(sum(bCount))) AS estimatedSpanCount
        FROM (
SELECT
          toStartOfInterval(service_overview_spans.Timestamp, INTERVAL 300 SECOND) AS bucket,
          coalesce(nullIf(toString(service_overview_spans.ServiceName), ''), 'all') AS groupName,
          count() AS bCount,
          sum(service_overview_spans.SampleRate) AS bEstimatedSpanCount,
          0 AS bErrorCount,
          0 AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          0 AS bSatisfiedCount,
          0 AS bToleratingCount
        FROM service_overview_spans
        WHERE service_overview_spans.OrgId = 'org_sql_catalog'
          AND service_overview_spans.Timestamp >= '2026-01-03 10:30:00'
          AND service_overview_spans.Timestamp <= '2026-01-03 14:15:00'
          AND (Timestamp < if(toDateTime('2026-01-03 10:30:00') = toStartOfMinute(toDateTime('2026-01-03 10:30:00')), toStartOfMinute(toDateTime('2026-01-03 10:30:00')), toStartOfMinute(toDateTime('2026-01-03 10:30:00')) + INTERVAL 1 MINUTE) OR Timestamp >= toStartOfMinute(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bucket, groupName
UNION ALL
SELECT
          toStartOfInterval(service_overview_minutely.Minute, INTERVAL 300 SECOND) AS bucket,
          coalesce(nullIf(toString(service_overview_minutely.ServiceName), ''), 'all') AS groupName,
          sum(service_overview_minutely.SpanCount) AS bCount,
          sum(service_overview_minutely.EstimatedSpanCount) AS bEstimatedSpanCount,
          0 AS bErrorCount,
          0 AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          0 AS bSatisfiedCount,
          0 AS bToleratingCount
        FROM service_overview_minutely
        WHERE service_overview_minutely.OrgId = 'org_sql_catalog'
          AND service_overview_minutely.Minute >= if(toDateTime('2026-01-03 10:30:00') = toStartOfMinute(toDateTime('2026-01-03 10:30:00')), toStartOfMinute(toDateTime('2026-01-03 10:30:00')), toStartOfMinute(toDateTime('2026-01-03 10:30:00')) + INTERVAL 1 MINUTE)
          AND service_overview_minutely.Minute < toStartOfMinute(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bucket, groupName
) AS service_metric_windows
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- spec:traces-timeseries-annual-single-p99_duration:baseline  [8501840e]
SELECT
          service_metric_windows.bucket AS bucket,
          service_metric_windows.groupName AS groupName,
          if(sum(bEstimatedSpanCount) > 0, sum(bEstimatedSpanCount), toFloat64(sum(bCount))) AS count,
          sum(service_metric_windows.bCount) AS spanCount,
          0 AS avgDuration,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 1) / 1000000 AS p50Duration,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 2) / 1000000 AS p95Duration,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 3) / 1000000 AS p99Duration,
          0 AS errorRate,
          0 AS satisfiedCount,
          0 AS toleratingCount,
          0 AS apdexScore,
          if(sum(bEstimatedSpanCount) > 0, sum(bEstimatedSpanCount), toFloat64(sum(bCount))) AS estimatedSpanCount
        FROM (
SELECT
          toStartOfInterval(service_overview_spans.Timestamp, INTERVAL 300 SECOND) AS bucket,
          coalesce(nullIf(toString(service_overview_spans.ServiceName), ''), 'all') AS groupName,
          count() AS bCount,
          sum(service_overview_spans.SampleRate) AS bEstimatedSpanCount,
          0 AS bErrorCount,
          0 AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          0 AS bSatisfiedCount,
          0 AS bToleratingCount
        FROM service_overview_spans
        WHERE service_overview_spans.OrgId = 'org_sql_catalog'
          AND service_overview_spans.Timestamp >= '2026-01-03 10:30:00'
          AND service_overview_spans.Timestamp <= '2026-01-03 14:15:00'
          AND (Timestamp < if(toDateTime('2026-01-03 10:30:00') = toStartOfMinute(toDateTime('2026-01-03 10:30:00')), toStartOfMinute(toDateTime('2026-01-03 10:30:00')), toStartOfMinute(toDateTime('2026-01-03 10:30:00')) + INTERVAL 1 MINUTE) OR Timestamp >= toStartOfMinute(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bucket, groupName
UNION ALL
SELECT
          toStartOfInterval(service_overview_minutely.Minute, INTERVAL 300 SECOND) AS bucket,
          coalesce(nullIf(toString(service_overview_minutely.ServiceName), ''), 'all') AS groupName,
          sum(service_overview_minutely.SpanCount) AS bCount,
          sum(service_overview_minutely.EstimatedSpanCount) AS bEstimatedSpanCount,
          0 AS bErrorCount,
          0 AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          0 AS bSatisfiedCount,
          0 AS bToleratingCount
        FROM service_overview_minutely
        WHERE service_overview_minutely.OrgId = 'org_sql_catalog'
          AND service_overview_minutely.Minute >= if(toDateTime('2026-01-03 10:30:00') = toStartOfMinute(toDateTime('2026-01-03 10:30:00')), toStartOfMinute(toDateTime('2026-01-03 10:30:00')), toStartOfMinute(toDateTime('2026-01-03 10:30:00')) + INTERVAL 1 MINUTE)
          AND service_overview_minutely.Minute < toStartOfMinute(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bucket, groupName
) AS service_metric_windows
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- spec:traces-timeseries-annual:baseline  [dfac70e9]
SELECT
          service_metric_windows.bucket AS bucket,
          service_metric_windows.groupName AS groupName,
          if(sum(bEstimatedSpanCount) > 0, sum(bEstimatedSpanCount), toFloat64(sum(bCount))) AS count,
          sum(service_metric_windows.bCount) AS spanCount,
          if(sum(bCount) > 0, sum(bDurationSum) / sum(bCount) / 1000000, 0) AS avgDuration,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 1) / 1000000 AS p50Duration,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 2) / 1000000 AS p95Duration,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 3) / 1000000 AS p99Duration,
          if(sum(bCount) > 0, sum(bErrorCount) / sum(bCount), 0) AS errorRate,
          sum(service_metric_windows.bSatisfiedCount) AS satisfiedCount,
          sum(service_metric_windows.bToleratingCount) AS toleratingCount,
          if(sum(service_metric_windows.bCount) > 0, round(sum(service_metric_windows.bSatisfiedCount) / sum(service_metric_windows.bCount) + sum(service_metric_windows.bToleratingCount) * 0.5 / sum(service_metric_windows.bCount), 4), 0) AS apdexScore,
          if(sum(bEstimatedSpanCount) > 0, sum(bEstimatedSpanCount), toFloat64(sum(bCount))) AS estimatedSpanCount
        FROM (
SELECT
          toStartOfInterval(service_overview_spans.Timestamp, INTERVAL 3600 SECOND) AS bucket,
          'all' AS groupName,
          count() AS bCount,
          sum(service_overview_spans.SampleRate) AS bEstimatedSpanCount,
          countIf(service_overview_spans.StatusCode = 'Error') AS bErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          countIf((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration < 500000000)) AS bSatisfiedCount,
          countIf(((service_overview_spans.StatusCode != 'Error' AND service_overview_spans.Duration >= 500000000) AND service_overview_spans.Duration < 2000000000)) AS bToleratingCount
        FROM service_overview_spans
        WHERE service_overview_spans.OrgId = 'org_sql_catalog'
          AND service_overview_spans.Timestamp >= '2026-01-01 10:30:00'
          AND service_overview_spans.Timestamp <= '2026-01-03 14:15:00'
          AND service_overview_spans.ServiceName = 'api'
          AND service_overview_spans.DeploymentEnv IN ('production')
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 MINUTE) OR Timestamp >= toStartOfMinute(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bucket, groupName
UNION ALL
SELECT
          toStartOfInterval(service_overview_minutely.Minute, INTERVAL 3600 SECOND) AS bucket,
          'all' AS groupName,
          sum(service_overview_minutely.SpanCount) AS bCount,
          sum(service_overview_minutely.EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(service_overview_minutely.ErrorCount) AS bErrorCount,
          sum(service_overview_minutely.DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          sum(service_overview_minutely.ApdexSatisfiedCount) AS bSatisfiedCount,
          sum(service_overview_minutely.ApdexToleratingCount) AS bToleratingCount
        FROM service_overview_minutely
        WHERE service_overview_minutely.OrgId = 'org_sql_catalog'
          AND service_overview_minutely.ServiceName = 'api'
          AND service_overview_minutely.DeploymentEnv IN ('production')
          AND service_overview_minutely.Minute >= if(toDateTime('2026-01-01 10:30:00') = toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 MINUTE)
          AND service_overview_minutely.Minute < toStartOfMinute(toDateTime('2026-01-03 14:15:00'))
          AND (Minute < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Minute >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bucket, groupName
UNION ALL
SELECT
          toStartOfInterval(service_overview_hourly.Hour, INTERVAL 3600 SECOND) AS bucket,
          'all' AS groupName,
          sum(service_overview_hourly.SpanCount) AS bCount,
          sum(service_overview_hourly.EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(service_overview_hourly.ErrorCount) AS bErrorCount,
          sum(service_overview_hourly.DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          sum(service_overview_hourly.ApdexSatisfiedCount) AS bSatisfiedCount,
          sum(service_overview_hourly.ApdexToleratingCount) AS bToleratingCount
        FROM service_overview_hourly
        WHERE service_overview_hourly.OrgId = 'org_sql_catalog'
          AND service_overview_hourly.ServiceName = 'api'
          AND service_overview_hourly.DeploymentEnv IN ('production')
          AND service_overview_hourly.Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND service_overview_hourly.Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bucket, groupName
) AS service_metric_windows
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- spec:traces-timeseries-apdex:baseline  [e3f8ef8f]
SELECT
          toStartOfInterval(traces.Timestamp, INTERVAL 300 SECOND) AS bucket,
          'all' AS groupName,
          sum(traces.SampleRate) AS count,
          count() AS spanCount,
          0 AS avgDuration,
          0 AS p50Duration,
          0 AS p95Duration,
          0 AS p99Duration,
          0 AS errorRate,
          countIf((NOT (traces.StatusCode = 'Error') AND traces.Duration / 1000000 < 250)) AS satisfiedCount,
          countIf((NOT (traces.StatusCode = 'Error') AND (traces.Duration / 1000000 >= 250 AND traces.Duration / 1000000 < 1000))) AS toleratingCount,
          if(count() > 0, round(countIf((NOT (traces.StatusCode = 'Error') AND traces.Duration / 1000000 < 250)) / count() + countIf((NOT (traces.StatusCode = 'Error') AND (traces.Duration / 1000000 >= 250 AND traces.Duration / 1000000 < 1000))) * 0.5 / count(), 4), 0) AS apdexScore,
          0 AS estimatedSpanCount
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND traces.ServiceName = 'api'
          AND coalesce(nullIf(traces.ResourceAttributes['deployment.environment.name'], ''), traces.ResourceAttributes['deployment.environment']) IN ('production')
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- spec:traces-timeseries-attribute-filtered:baseline  [22d47883]
SELECT
          toStartOfInterval(traces.Timestamp, INTERVAL 300 SECOND) AS bucket,
          'all' AS groupName,
          sum(traces.SampleRate) AS count,
          count() AS spanCount,
          0 AS avgDuration,
          0 AS p50Duration,
          0 AS p95Duration,
          0 AS p99Duration,
          if(sum(traces.SampleRate) > 0, sumIf(traces.SampleRate, traces.StatusCode = 'Error') / sum(traces.SampleRate), 0) AS errorRate,
          0 AS satisfiedCount,
          0 AS toleratingCount,
          0 AS apdexScore,
          0 AS estimatedSpanCount
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND traces.ServiceName = 'api'
          AND coalesce(nullIf(traces.ResourceAttributes['deployment.environment.name'], ''), traces.ResourceAttributes['deployment.environment']) IN ('production')
          AND if(SpanAttributes['http.method'] != '', SpanAttributes['http.method'], SpanAttributes['http.request.method']) = 'GET'
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- spec:traces-timeseries-attribute-filtered:bloom  [cdf51be9]
SELECT
          toStartOfInterval(traces.Timestamp, INTERVAL 300 SECOND) AS bucket,
          'all' AS groupName,
          sum(traces.SampleRate) AS count,
          count() AS spanCount,
          0 AS avgDuration,
          0 AS p50Duration,
          0 AS p95Duration,
          0 AS p99Duration,
          if(sum(traces.SampleRate) > 0, sumIf(traces.SampleRate, traces.StatusCode = 'Error') / sum(traces.SampleRate), 0) AS errorRate,
          0 AS satisfiedCount,
          0 AS toleratingCount,
          0 AS apdexScore,
          0 AS estimatedSpanCount
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND traces.ServiceName = 'api'
          AND coalesce(nullIf(traces.ResourceAttributes['deployment.environment.name'], ''), traces.ResourceAttributes['deployment.environment']) IN ('production')
          AND (((has(mapKeys(SpanAttributes), 'http.method') OR has(mapKeys(SpanAttributes), 'http.request.method')) AND has(mapValues(SpanAttributes), 'GET')) AND if(SpanAttributes['http.method'] != '', SpanAttributes['http.method'], SpanAttributes['http.request.method']) = 'GET')
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- spec:traces-timeseries-attribute-filtered:text  [ef24aa3d]
SELECT
          toStartOfInterval(traces.Timestamp, INTERVAL 300 SECOND) AS bucket,
          'all' AS groupName,
          sum(traces.SampleRate) AS count,
          count() AS spanCount,
          0 AS avgDuration,
          0 AS p50Duration,
          0 AS p95Duration,
          0 AS p99Duration,
          if(sum(traces.SampleRate) > 0, sumIf(traces.SampleRate, traces.StatusCode = 'Error') / sum(traces.SampleRate), 0) AS errorRate,
          0 AS satisfiedCount,
          0 AS toleratingCount,
          0 AS apdexScore,
          0 AS estimatedSpanCount
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND traces.ServiceName = 'api'
          AND coalesce(nullIf(traces.ResourceAttributes['deployment.environment.name'], ''), traces.ResourceAttributes['deployment.environment']) IN ('production')
          AND ((has(SpanAttributeItems, concat('http.method', char(31), 'GET')) OR has(SpanAttributeItems, concat('http.request.method', char(31), 'GET'))) AND if(SpanAttributes['http.method'] != '', SpanAttributes['http.method'], SpanAttributes['http.request.method']) = 'GET')
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- spec:traces-timeseries-raw:baseline  [2bbe9351]
SELECT
          toStartOfInterval(traces.Timestamp, INTERVAL 60 SECOND) AS bucket,
          'all' AS groupName,
          sum(traces.SampleRate) AS count,
          count() AS spanCount,
          0 AS avgDuration,
          quantile(0.5)(traces.Duration) / 1000000 AS p50Duration,
          quantile(0.95)(traces.Duration) / 1000000 AS p95Duration,
          quantile(0.99)(traces.Duration) / 1000000 AS p99Duration,
          0 AS errorRate,
          0 AS satisfiedCount,
          0 AS toleratingCount,
          0 AS apdexScore,
          0 AS estimatedSpanCount
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-03 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND traces.ServiceName = 'api'
          AND coalesce(nullIf(traces.ResourceAttributes['deployment.environment.name'], ''), traces.ResourceAttributes['deployment.environment']) IN ('production')
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- spec:traces-timeseries-raw:bloom  [2bbe9351]
SELECT
          toStartOfInterval(traces.Timestamp, INTERVAL 60 SECOND) AS bucket,
          'all' AS groupName,
          sum(traces.SampleRate) AS count,
          count() AS spanCount,
          0 AS avgDuration,
          quantile(0.5)(traces.Duration) / 1000000 AS p50Duration,
          quantile(0.95)(traces.Duration) / 1000000 AS p95Duration,
          quantile(0.99)(traces.Duration) / 1000000 AS p99Duration,
          0 AS errorRate,
          0 AS satisfiedCount,
          0 AS toleratingCount,
          0 AS apdexScore,
          0 AS estimatedSpanCount
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-03 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND traces.ServiceName = 'api'
          AND coalesce(nullIf(traces.ResourceAttributes['deployment.environment.name'], ''), traces.ResourceAttributes['deployment.environment']) IN ('production')
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- spec:traces-timeseries-raw:text  [2bbe9351]
SELECT
          toStartOfInterval(traces.Timestamp, INTERVAL 60 SECOND) AS bucket,
          'all' AS groupName,
          sum(traces.SampleRate) AS count,
          count() AS spanCount,
          0 AS avgDuration,
          quantile(0.5)(traces.Duration) / 1000000 AS p50Duration,
          quantile(0.95)(traces.Duration) / 1000000 AS p95Duration,
          quantile(0.99)(traces.Duration) / 1000000 AS p99Duration,
          0 AS errorRate,
          0 AS satisfiedCount,
          0 AS toleratingCount,
          0 AS apdexScore,
          0 AS estimatedSpanCount
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-03 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND traces.ServiceName = 'api'
          AND coalesce(nullIf(traces.ResourceAttributes['deployment.environment.name'], ''), traces.ResourceAttributes['deployment.environment']) IN ('production')
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- spec:traces-timeseries-series-cap:baseline  [885b7c2a]
SELECT
          bucket AS bucket,
          groupName AS groupName,
          count AS count,
          spanCount AS spanCount,
          avgDuration AS avgDuration,
          p50Duration AS p50Duration,
          p95Duration AS p95Duration,
          p99Duration AS p99Duration,
          errorRate AS errorRate,
          satisfiedCount AS satisfiedCount,
          toleratingCount AS toleratingCount,
          apdexScore AS apdexScore,
          estimatedSpanCount AS estimatedSpanCount
        FROM (SELECT
          bucket AS bucket,
          groupName AS groupName,
          count AS count,
          spanCount AS spanCount,
          avgDuration AS avgDuration,
          p50Duration AS p50Duration,
          p95Duration AS p95Duration,
          p99Duration AS p99Duration,
          errorRate AS errorRate,
          satisfiedCount AS satisfiedCount,
          toleratingCount AS toleratingCount,
          apdexScore AS apdexScore,
          estimatedSpanCount AS estimatedSpanCount,
          dense_rank() OVER (ORDER BY __series_peak DESC, groupName ASC) AS __series_rank
        FROM (SELECT
          bucket AS bucket,
          groupName AS groupName,
          count AS count,
          spanCount AS spanCount,
          avgDuration AS avgDuration,
          p50Duration AS p50Duration,
          p95Duration AS p95Duration,
          p99Duration AS p99Duration,
          errorRate AS errorRate,
          satisfiedCount AS satisfiedCount,
          toleratingCount AS toleratingCount,
          apdexScore AS apdexScore,
          estimatedSpanCount AS estimatedSpanCount,
          max(count) OVER (PARTITION BY groupName) AS __series_peak
        FROM (SELECT
          toStartOfInterval(traces.Timestamp, INTERVAL 300 SECOND) AS bucket,
          coalesce(nullIf(toString(traces.SpanName), ''), 'all') AS groupName,
          sum(traces.SampleRate) AS count,
          count() AS spanCount,
          0 AS avgDuration,
          0 AS p50Duration,
          0 AS p95Duration,
          0 AS p99Duration,
          0 AS errorRate,
          0 AS satisfiedCount,
          0 AS toleratingCount,
          0 AS apdexScore,
          0 AS estimatedSpanCount
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND traces.ServiceName = 'api'
          AND coalesce(nullIf(traces.ResourceAttributes['deployment.environment.name'], ''), traces.ResourceAttributes['deployment.environment']) IN ('production')
        GROUP BY bucket, groupName) AS __series_base) AS __series_peaks) AS __series_ranked
        WHERE __series_rank <= 10
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON