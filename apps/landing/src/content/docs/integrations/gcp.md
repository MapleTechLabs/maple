---
title: "Google Cloud"
description: "Connect a Google Cloud organization, folder or project by running one script in Cloud Shell. Maple receives Cloud Logging entries through Pub/Sub and reads Cloud Monitoring metrics every 5 minutes."
group: "Integrations"
order: 7
---

The Google Cloud integration connects an organization, a folder or a single project to Maple. You choose what each connection collects:

| Switch                    | Collects                                                                                                                                                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Log forwarding**        | A Log Router sink sends Cloud Logging entries through Pub/Sub to Maple. They appear in [Logs](/docs/explore/logs) under the service that wrote them.                                                                                                                           |
| **Metrics and resources** | Maple reads Cloud Monitoring metrics for Cloud Run, Cloud Functions, GKE, Compute Engine, Cloud SQL, Pub/Sub and HTTP(S) load balancers every 5 minutes, and lists the resources behind them every hour. The metrics are named `gcp.*` and work in dashboards and alert rules. |

There is no OAuth step and no service account key. You run a generated `gcloud` script in Cloud Shell, and Maple gets no write access to Google Cloud.

## Prerequisites

- You are an admin of the Maple organization.
- You can sign in to Cloud Shell with the roles for what you connect:

| You connect     | Roles you need                                                                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| A project       | Owner on the project.                                                                                                                               |
| A folder        | Owner on the host project. On the folder: Logs Configuration Writer for the log sink, and Folder IAM Admin for the read-only roles.                 |
| An organization | Owner on the host project. On the organization: Logs Configuration Writer for the log sink, and Organization Administrator for the read-only roles. |

The host project is where the script creates Maple's Pub/Sub topic, subscription and service account. A project is its own host project. For a folder or organization you name one, usually a project inside it.

## Connect

1. Open **Integrations → Google Cloud** in Maple.
2. Choose **Organization**, **Folder** or **Project** and enter its ID. An organization or folder covers every project under it, including ones created later. Organization and folder IDs are digits only. A project takes its project ID, not its name or number.
3. For an organization or folder, enter the **Host project ID**.
4. Under **What to collect**, tick **Log forwarding**, **Metrics and resources**, or both. Click **Connect**.
5. Click **Open Cloud Shell**, paste the script from the setup panel and run it. It ends with `Maple setup complete.`

If your GKE pods already send their logs to Maple through an OpenTelemetry collector, turn on **Exclude GKE container logs** before you copy the script.

With log forwarding on, the script contains a secret that lets anyone send logs to your Maple organization. Don't share it or commit it. If it leaks, disconnect and connect again.

A project, folder or organization can be connected once per Maple organization.

### Change what a connection collects

Flip **Log forwarding** or **Metrics and resources** on the connection, then run the script from its setup panel again. The script sets up what is switched on and removes what is switched off. Running it twice is safe.

Switching **Log forwarding** off stops Maple storing the logs within about a minute. Google Cloud keeps publishing them to Pub/Sub until you run the script again.

A connection keeps at least one switch on. To stop both, [disconnect](#disconnect).

## Verify

Each connection shows a status per switch. The page updates on its own.

| Switch                | Status                            | When                                                                                                                                        |
| --------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Log forwarding        | **Waiting for the first log**     | Until the first entry arrives.                                                                                                              |
| Log forwarding        | **Receiving logs**                | Within a few minutes of the script finishing, once a log that passes the filter is written.                                                 |
| Metrics and resources | **Waiting for the first metrics** | Until the first read. Before the script has run, the row also says that Maple has no access yet.                                            |
| Metrics and resources | **Receiving metrics**             | Within about ten minutes. Maple reads every 5 minutes, 5 minutes behind. A folder or organization also shows how many projects Maple found. |

**Last push rejected** or **Last read failed or was incomplete** comes with the reason. See [Troubleshooting](#troubleshooting).

Then check the data:

1. Open [Logs](/docs/explore/logs) and look for a service named after one of your Cloud Run services, functions, containers or instances.
2. In the [metrics explorer](/docs/explore/metrics), search for `gcp.`.
3. Under **Dashboards → Browse templates**, create the **Google Cloud** dashboard. It takes an optional project ID.

## Permissions

The script enables these APIs in the host project:

| API                             | Enabled for           | Used for                                                     |
| ------------------------------- | --------------------- | ------------------------------------------------------------ |
| `pubsub.googleapis.com`         | Log forwarding        | Carrying the log entries.                                    |
| `logging.googleapis.com`        | Log forwarding        | Routing them through the sink.                               |
| `monitoring.googleapis.com`     | Metrics and resources | Reading metrics.                                             |
| `cloudasset.googleapis.com`     | Metrics and resources | Listing resources.                                           |
| `iam.googleapis.com`            | Metrics and resources | Creating the reader service account.                         |
| `iamcredentials.googleapis.com` | Metrics and resources | Short-lived tokens for that account. No key is ever created. |

For log forwarding it creates a Pub/Sub topic and push subscription in the host project and a log sink on the project, folder or organization. For metrics and resources it creates a reader service account in the host project. Each is named `maple-` followed by 24 hexadecimal characters unique to the connection.

It grants these roles:

| Role                                      | Granted to                                | On                                  | Why                                                                                                                    |
| ----------------------------------------- | ----------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `roles/pubsub.publisher`                  | The sink's Google-managed writer identity | Maple's topic                       | Publishing log entries to the topic.                                                                                   |
| `roles/logging.logWriter`                 | The sink's Google-managed writer identity | The host project                    | Google requires it on the project that holds a sink's destination.                                                     |
| `roles/monitoring.viewer`                 | The reader service account                | The project, folder or organization | Reading metrics (`monitoring.timeSeries.list`).                                                                        |
| `roles/cloudasset.viewer`                 | The reader service account                | The project, folder or organization | Listing resources (`cloudasset.assets.searchAllResources`). The role can also read resource metadata and IAM policies. |
| `roles/serviceusage.serviceUsageConsumer` | The reader service account                | The host project                    | Calling both read APIs through the host project.                                                                       |
| `roles/iam.serviceAccountTokenCreator`    | Maple's service account                   | The reader service account          | Minting short-lived tokens for that one account.                                                                       |

`roles/monitoring.viewer` and `roles/cloudasset.viewer` are the narrowest predefined roles for these calls, and both are read-only. On a folder or organization, every project under it inherits them.

## Collected data

### Logs

Maple receives every entry the sink's filter lets through. The default filter excludes:

| Excluded                                                   | Filter clause                                         |
| ---------------------------------------------------------- | ----------------------------------------------------- |
| Data Access audit logs                                     | `NOT log_id("cloudaudit.googleapis.com/data_access")` |
| Load balancer health checks                                | `NOT httpRequest.userAgent:"GoogleHC"`                |
| GKE container logs, with **Exclude GKE container logs** on | `NOT resource.type="k8s_container"`                   |

To forward different logs, edit `LOG_FILTER` at the top of the script and run it again. The filter uses the [Logging query language](https://cloud.google.com/logging/docs/view/logging-query-language). Keep your edited copy, because a script copied from Maple starts from the default filter.

Each entry gets its `service.name` from the resource that wrote it, so workload logs join the traced service of the same name:

| Resource                | `service.name`                                                    |
| ----------------------- | ----------------------------------------------------------------- |
| Cloud Run service       | The service name.                                                 |
| Cloud Run job           | The job name.                                                     |
| Cloud Function          | The function name.                                                |
| GKE container           | The container name.                                               |
| Compute Engine instance | The instance name, or `gcp/gce_instance` when the entry has none. |
| App Engine              | The module ID.                                                    |
| Everything else         | `gcp/<resource type>`, for example `gcp/cloudsql_database`.       |

Every entry also carries `cloud.provider` (`gcp`), `gcp.resource.type` and the resource's labels as `gcp.resource.labels.*`, plus `cloud.account.id` (the project ID) and `cloud.region` when the resource has them. GKE container entries add `k8s.cluster.name`, `k8s.namespace.name`, `k8s.pod.name` and `k8s.container.name`.

The log body is `textPayload`, or the `message` or `msg` field of `jsonPayload`, or the whole `jsonPayload` as JSON when it has neither. The other `jsonPayload` fields become log attributes. Audit logs use the method name as the body, and request logs the method, URL and status. An entry's `trace` and `spanId` become the log's trace and span IDs.

| Cloud Logging severity           | Maple severity |
| -------------------------------- | -------------- |
| `DEBUG`                          | `DEBUG`        |
| `INFO`, `NOTICE`                 | `INFO`         |
| `WARNING`                        | `WARN`         |
| `ERROR`                          | `ERROR`        |
| `CRITICAL`, `ALERT`, `EMERGENCY` | `FATAL`        |
| `DEFAULT`                        | Not set        |

### Metrics

Maple stores these Cloud Monitoring metrics at one-minute resolution. The name is the Cloud Monitoring type under a `gcp.` prefix: `run.googleapis.com/request_count` becomes `gcp.run.request_count`.

| Service                                    | Prefix                         | Metrics                                                                                                                                                                                                                                                          |
| ------------------------------------------ | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloud Run, Cloud Functions (2nd gen)       | `gcp.run.`                     | `request_count`, `request_latencies`, `container.instance_count`, `container.cpu.utilizations`, `container.memory.utilizations`, `container.max_request_concurrencies`, `container.billable_instance_time`                                                       |
| Cloud Functions (1st gen)                  | `gcp.cloudfunctions.function.` | `execution_count`, `execution_times`, `instance_count`, `user_memory_bytes`, `network_egress`                                                                                                                                                                    |
| GKE containers                             | `gcp.kubernetes.container.`    | `cpu.core_usage_time`, `cpu.limit_utilization`, `memory.used_bytes`, `memory.limit_utilization`, `restart_count`                                                                                                                                                 |
| GKE nodes                                  | `gcp.kubernetes.node.`         | `cpu.allocatable_utilization`, `memory.allocatable_utilization`                                                                                                                                                                                                  |
| Compute Engine                             | `gcp.compute.instance.`        | `cpu.utilization`, `memory.balloon.ram_used` (E2 machine types only), `network.received_bytes_count`, `network.sent_bytes_count`, `disk.read_bytes_count`, `disk.write_bytes_count`                                                                              |
| Cloud SQL                                  | `gcp.cloudsql.database.`       | `cpu.utilization`, `memory.utilization`, `disk.utilization`, `network.connections` (MySQL and SQL Server), `postgresql.num_backends`, `disk.read_ops_count`, `disk.write_ops_count`, `replication.replica_lag`                                                   |
| Pub/Sub                                    | `gcp.pubsub.`                  | `subscription.num_undelivered_messages`, `subscription.oldest_unacked_message_age`, `subscription.sent_message_count`, `subscription.ack_message_count`, `subscription.push_request_count`, `subscription.dead_letter_message_count`, `topic.send_request_count` |
| Global external Application Load Balancers | `gcp.loadbalancing.https.`     | `request_count`, `total_latencies`, `backend_latencies`, `backend_request_count`, `request_bytes_count`, `response_bytes_count`                                                                                                                                  |

Value conventions:

- Counters are delta sums per minute. Chart them with `sum`, not `rate`.
- Latency and other distributions are gauges with a `quantile` attribute (`0.5`, `0.95`, `0.99`).
- Utilization is a fraction from 0 to 1.
- Latencies and execution times are in milliseconds.

Service names follow the same rule as logs: Cloud Run services, functions, GKE containers and Compute Engine instances use the workload name, and everything else is `gcp/<resource type>`. Narrow further by resource attribute:

| Service        | Resource attributes                                                           |
| -------------- | ----------------------------------------------------------------------------- |
| GKE containers | `k8s.cluster.name`, `k8s.namespace.name`, `k8s.container.name`                |
| GKE nodes      | `k8s.cluster.name`                                                            |
| Cloud SQL      | `gcp.resource.labels.database_id`                                             |
| Pub/Sub        | `gcp.resource.labels.subscription_id`, `gcp.resource.labels.topic_id`         |
| Load balancers | `gcp.resource.labels.url_map_name`, `gcp.resource.labels.backend_target_name` |

Every series also carries `cloud.account.id` (the project ID) and, for resources with a location, `cloud.region`. Google aggregates away every other label, such as revision, pod, response code and device, before the data reaches Maple. These metric labels are kept as attributes:

| Attribute             | On                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------- |
| `response_code_class` | `gcp.run.request_count`, the load balancer request counts                           |
| `state`               | The Cloud Run and Cloud Functions instance counts                                   |
| `status`              | `gcp.cloudfunctions.function.execution_count`                                       |
| `memory_type`         | The GKE memory metrics                                                              |
| `instance_name`       | The Compute Engine metrics                                                          |
| `response_class`      | `gcp.pubsub.subscription.push_request_count`, `gcp.pubsub.topic.send_request_count` |

### Resources

Every hour Maple lists these resources from Cloud Asset Inventory, with their project, location, state and labels: projects, Cloud Run services and jobs, Cloud Functions, GKE clusters, Compute Engine instances, Cloud SQL instances, Pub/Sub topics and subscriptions, and load balancer URL maps, backend services and forwarding rules.

## Google Cloud costs

Google bills Pub/Sub and Cloud Monitoring usage to your account, separately from your Maple plan.

Google bills Pub/Sub for the log entries that pass through the topic and the subscription. A narrower `LOG_FILTER` lowers it. See [Pub/Sub pricing](https://cloud.google.com/pubsub/pricing).

Google bills Cloud Monitoring API reads to the host project. Each connection runs 46 `timeSeries.list` queries every 5 minutes, and the cost grows with the number of time series in the project, folder or organization. See [Google Cloud Observability pricing](https://cloud.google.com/stackdriver/pricing).

Cloud Asset Inventory searches are free of charge. See [Cloud Asset Inventory pricing](https://cloud.google.com/asset-inventory/pricing).

## Limits

- Pub/Sub delivers one log entry per HTTP request, at least once. A redelivered entry is stored again. Its Cloud Logging `insertId` is in the `log.record.uid` attribute.
- The subscription keeps undelivered entries for one day. Entries Maple could not accept within that day are lost.
- Connecting an organization and a folder or project inside it collects that part twice. Each connection has its own sink and its own metric reads.
- Metrics arrive every 5 minutes, 5 minutes behind. The first read, and the first read after a pause, covers at most the last hour.
- One read takes up to 20,000 data points per metric, about 4,000 series, and up to 60 seconds in total. Past that, the connection says how many metric queries were cut short. Connect folders or projects separately to collect all of it.
- Maple reads up to 10 connections of one Maple organization every 5 minutes. With more, they take turns.
- The resource list holds up to 10,000 resources per connection.
- Load balancer metrics cover global external Application Load Balancers only.

## Troubleshooting

Log forwarding:

| The connection shows                                                                                                    | Cause and fix                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Waiting for the first log** for more than a few minutes                                                               | Check that the script ended with `Maple setup complete.` and that the filter lets some of your logs through. Maple shows no error for a push it refuses over the Maple plan limit, so also check the subscription's push errors in the Google Cloud console. |
| **Last push rejected** with `Payload is not a Cloud Logging LogEntry; the push subscription must use --push-no-wrapper` | The subscription delivers wrapped Pub/Sub messages. Run the setup script again. It resets the subscription. Entries pushed in the meantime are lost.                                                                                                         |
| **Last push rejected** with any other text                                                                              | Maple could not accept an entry at that moment. Pub/Sub retries it for up to a day, and the status returns to **Receiving logs** with the next accepted entry.                                                                                               |
| GKE logs appear twice                                                                                                   | Your pods also send logs through an OpenTelemetry collector. Turn on **Exclude GKE container logs** and run the script again.                                                                                                                                |

Metrics and resources:

| The connection shows                                                                                                            | Cause and fix                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Run the setup script in Cloud Shell to grant Maple read access; if it already ran, wait a few minutes for the grant to apply.` | Expected before the script has run. After it ran, Google can take a few minutes to apply the roles. The text before it names the API that refused, such as `Google IAM returned 403`. If it stays, run the script again and read its output. |
| **Last read failed or was incomplete** with `... of 46 metric queries failed. First: ...`                                       | Some metrics could not be read. The text names the first one and Google's answer. Maple keeps what it read, and the failed metrics miss those minutes.                                                                                       |
| A text with `returned 429`                                                                                                      | Google rate-limited the API the text names, usually because the host project is out of quota for it. Maple keeps the metrics it already read. The rest can miss those minutes.                                                               |
| **Last read failed or was incomplete** with `... of 46 metric queries held more than one poll reads`                            | The scope holds more series than one read takes. Connect its folders or projects as separate connections.                                                                                                                                    |
| `Reading the metrics took too long. Maple retries on the next poll.`                                                            | Maple reads the same minutes again, which can store part of them twice. If it repeats, connect folders or projects separately.                                                                                                               |
| `Metrics are paused: this organization is over its plan limit.`                                                                 | The Maple organization reached its plan limit. Maple tries again after an hour.                                                                                                                                                              |
| `Metrics ingest returned ...`, `Metrics ingest request failed` or `Metrics ingest timed out`                                    | Maple could not store what it read. It reads the same minutes again, which can store part of them twice.                                                                                                                                     |
| **Receiving metrics** with `Resource inventory: The scope holds more than 10000 resources; the inventory is incomplete.`        | Metrics are unaffected. Connect folders or projects separately for a complete resource list.                                                                                                                                                 |
| **Receiving metrics** with another `Resource inventory: ...` text                                                               | Metrics are unaffected. If it names `Cloud Asset Inventory returned 403`, run the setup script again. Otherwise Maple retries.                                                                                                               |
| The **Metrics and resources** switch reads **Not available on this Maple deployment.**                                          | A self-hosted deployment needs `MAPLE_GCP_SERVICE_ACCOUNT_EMAIL` set to a Google service account it owns. Reading metrics also needs `MAPLE_GCP_SERVICE_ACCOUNT_KEY`, that account's key file, base64-encoded.                               |

Setup:

| You see                                                                         | Cause and fix                                                                                                                                                                          |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `The Google Cloud <project, folder or organization> <ID> is already connected.` | It already has a connection in this Maple organization. Change that connection's switches instead.                                                                                     |
| The script fails while granting `roles/iam.serviceAccountTokenCreator`          | An organization policy with domain-restricted sharing (`constraints/iam.allowedPolicyMemberDomains`) rejects Maple's service account. Allow it in the policy and run the script again. |
| `Not everything could be removed. See the errors above, then re-run.`           | The script could not check or remove something it created, usually for a missing permission. Fix the errors it printed and run it again.                                               |

## Disconnect

1. On **Integrations → Google Cloud**, click **Disconnect** on the connection and confirm. Maple stops accepting its logs and reading its metrics and resources. Data already in Maple is kept.
2. Copy the cleanup script Maple shows. It isn't shown again after you leave the page.
3. Run it in Cloud Shell. It ends with `Maple cleanup complete.`

Until the cleanup script runs, the sink keeps publishing to Pub/Sub. The script removes the sink, subscription, topic, role bindings and service account. It leaves the APIs enabled, and the Logs Writer grant on the host project, which every sink of that project, folder or organization shares.

## Next steps

- [Logs](/docs/explore/logs): search Google Cloud logs next to your application logs.
- [Dashboards](/docs/dashboards/build-dashboards#templates): start from the **Google Cloud** template.
- [Alert rules](/docs/alerting/alert-rules): alert on any `gcp.*` metric.
- [API reference](/docs/reference/api): manage connections with the `/v2/integrations/gcp` endpoints.
