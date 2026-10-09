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

If your workloads also send telemetry over OpenTelemetry, read [Google Cloud with OpenTelemetry](/docs/integrations/gcp-opentelemetry): it covers which telemetry to send over OpenTelemetry and which to collect here, and why GKE container logs are left out by default.

## Prerequisites

- You are an admin of the Maple organization.
- You can sign in to Cloud Shell with the roles for what you connect:

| You connect     | Roles you need                                                                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| A project       | Owner on the project.                                                                                                                               |
| A folder        | Owner on the host project. On the folder: Logs Configuration Writer for the log sink, and Folder IAM Admin for the read-only roles.                 |
| An organization | Owner on the host project. On the organization: Logs Configuration Writer for the log sink, and Organization Administrator for the read-only roles. |

If you can't get Owner, see [Roles for running the script](#roles-for-running-the-script).

The host project holds Maple's Pub/Sub topic, subscription and read-only service account. A project is its own host project. For a folder or organization, name a shared operations project inside it that won't be deleted. Google bills the Pub/Sub and Cloud Monitoring usage to the host project.

**Metrics and resources** needs billing enabled on the host project: Cloud Monitoring only answers for projects that have a billing account. The script checks this before it changes anything.

### Find your IDs

| ID              | Where to find it                                                                                                                                                            |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project ID      | The console's project picker lists it next to each project name, or run `gcloud projects list`. It is not the project name or number.                                       |
| Organization ID | **IAM & Admin → [Manage resources](https://console.cloud.google.com/cloud-resource-manager)** in the console, or run `gcloud organizations list`. Digits only.              |
| Folder ID       | The same console page, or run `gcloud resource-manager folders list --organization=ORGANIZATION_ID` with your organization's ID in place of `ORGANIZATION_ID`. Digits only. |

## Connect

1. Open **Integrations → Google Cloud** in Maple.
2. Under **What to connect**, choose **Organization**, **Folder** or **Project** and enter its ID. An organization or folder covers every project in it, including new ones.
3. For an organization or folder, enter the **Host project ID**.
4. Under **What to collect**, leave **Log forwarding** and **Metrics and resources** ticked, or untick one. Click **Get setup script**.
5. Click **Open Cloud Shell** and sign in with the roles above. Click **Authorize** if Cloud Shell asks.
6. Click **Copy script**, paste it into Cloud Shell and press Enter. The script takes about a minute. To change which logs are forwarded, click **Change** next to **Log filter** and choose a [log filter](#log-filter) before you copy.
7. Return to Maple. **Maple confirms the connection** shows a check mark within a minute of the script ending, usually in seconds.

A first run for a project prints:

```text
Maple setup for project acme-prod
  Log forwarding          on
  Metrics and resources   on

Checking access
  ✓ Signed in as jane@acme.com
  ✓ Project acme-prod found (Acme Production)
  ✓ Billing is enabled
  ✓ jane@acme.com has the permissions this script needs
  ✓ Log filter accepted

Log forwarding
  ✓ APIs enabled (Pub/Sub, Cloud Logging, Cloud Resource Manager)
  ✓ Topic created
  ✓ Push subscription created
  ✓ Log sink created
  ✓ Sink allowed to write to the project
  ✓ Sink allowed to publish to the topic
  ✓ Check message sent to Maple through the topic

Metrics and resources
  ✓ APIs enabled (Cloud Monitoring, Cloud Asset, IAM, IAM Credentials, Cloud Resource Manager)
  ✓ Read-only service account created
  ✓ Read-only roles granted (Monitoring Viewer, Cloud Asset Viewer, Service Usage Consumer)
  ✓ Maple allowed to read as that account
  ✓ Maple notified

Done. Google Cloud is set up for Maple.
  Maple confirms it within a minute: https://app.maple.dev/integrations?integration=gcp
  Logs:    a new sink can take about 10 minutes to start forwarding. What is logged before
           it does is not forwarded later.
  Metrics: the first read lands within about 10 minutes.
```

If a step fails, the script stops and prints what to do. Fix it and paste the script again: it continues where it stopped. Running the script again is safe, and its last line says what the run did:

| The script ends with                                                             | The run                                                                                            |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| "Done. Google Cloud is set up for Maple."                                        | Created the log sink or the read-only service account.                                             |
| "Done. Everything is in place."                                                  | Created and removed nothing. It makes every grant again, so it also restores one that was removed. |
| "Done. The log sink has the filter of this script. Everything else is in place." | Replaced the sink's filter and created nothing.                                                    |
| "Done. Google Cloud matches your Maple switches."                                | Removed what a switch that is now off had set up.                                                  |

After the check mark, each switch waits for its first data:

| Switch                | First data                                                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Log forwarding        | A new sink can take about 10 minutes to start forwarding. Entries logged before that are not forwarded.                             |
| Metrics and resources | The first read lands within about 10 minutes. Maple reads every 5 minutes, about 5 minutes behind, so that each minute is complete. |

The script contains a secret that lets anyone send logs to your Maple organization. Don't share it or commit it, and run it in Cloud Shell: there neither the paste nor the secret ends up in shell history. zsh keeps the whole paste, secret included. If you paste the script into zsh on your own machine, remove the entry from your shell history afterwards.

The push endpoint with the secret is also visible in the subscription's configuration and in the host project's Admin Activity audit log, to anyone who can read those. If it leaks, disconnect and connect again: the new connection gets a new secret.

The first two lines and the last two lines of the pasted text run the script in a bash process of its own, so a failed step can't close your Cloud Shell session.

A project, folder or organization can be connected once per Maple organization. A project that sits inside a connected organization or folder is collected twice if you also connect it on its own.

### Change what a connection collects

1. Flip **Log forwarding** or **Metrics and resources** on the connection. Maple saves the switch at once.
2. The connection reads **Changes pending** and lists what the script will create or remove in Google Cloud. A connection whose setup script has not run yet reads **Setup pending** instead.
3. The setup panel opens with the updated script. Copy it and run it in Cloud Shell again. If the panel is closed, click **Show setup script**. The notice goes away when the run reports to Maple.

A run that switches **Log forwarding** off takes one to two minutes: after it deletes the sink it waits a minute for Google to stop routing to the topic, so your project logs no sink error.

Until the script runs, Google Cloud keeps what the last run set up:

| Switched off          | Until the script runs again                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| Log forwarding        | Google Cloud keeps publishing logs to Pub/Sub. Maple discards them within about a minute of the switch. |
| Metrics and resources | The read-only service account stays in Google Cloud. Maple no longer uses it.                           |

A connection keeps one switch on. To stop collecting, [disconnect](#disconnect).

### Log filter

The setup panel's **Log filter** decides which filter the script writes onto the sink:

| Log filter                             | The script                                                                                                                                                                                                                                           |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Recommended: no GKE container logs** | Sets the [recommended filter](#logs). Preselected for a connection that has no sink yet.                                                                                                                                                             |
| **Include GKE container logs**         | Sets the recommended filter without its GKE container clause. Maple asks you to confirm before it shows the script.                                                                                                                                  |
| **Keep the sink's current filter**     | Leaves an existing sink's filter as it is. Offered, and preselected, once a run has set log forwarding up. Maple can't see the sink's filter: read it in the console under **Logging → [Log Router](https://console.cloud.google.com/logs/router)**. |

Include GKE container logs only for workloads that don't send their logs to Maple over OpenTelemetry. Otherwise each line is stored twice: see [GKE container logs](/docs/integrations/gcp-opentelemetry#gke-container-logs).

For any other filter, paste the script into an editor first, edit `LOG_FILTER` near its top and set `LOG_FILTER_MODE` to `set`. The filter uses the [Logging query language](https://cloud.google.com/logging/docs/view/logging-query-language). The script checks the filter with Google before it creates anything. Later runs with **Keep the sink's current filter** leave your filter in place, while the other two options replace it.

## Verify

Each connection shows a status per switch. The page updates on its own.

| Log forwarding             | Meaning                                                                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Setup pending**          | The setup script has not set log forwarding up yet. Run it.                                                                        |
| **Setup running**          | A run reported on the other switch in the last two minutes and has not reported on this one yet.                                   |
| **Waiting for first logs** | The script ran and no entry has arrived. After 20 minutes the row shows a `gcloud logging write` command that writes a test entry. |
| **Receiving logs**         | Entries arrive. The row shows when the last one did.                                                                               |
| **No logs in 24 hours**    | Nothing passed the filter for a day. Not an error.                                                                                 |
| **Rejecting logs**         | Maple refused the last push. The row says why and what to do.                                                                      |
| **Off**                    | Switched off. A second line appears while Google Cloud still forwards logs.                                                        |

| Metrics and resources             | Meaning                                                                                                                                       |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Setup pending**                 | The setup script has not granted Maple read access yet. Run it.                                                                               |
| **Setup running**                 | A run reported on log forwarding in the last two minutes and has not reported on this switch yet.                                             |
| **Waiting for first metrics**     | The script ran and the first read has not landed. After 15 minutes the row says that no read has arrived yet.                                 |
| **Receiving metrics**             | Reads succeed. A folder or organization also shows how many projects Maple found. A second line appears when the resource list is incomplete. |
| **Receiving metrics, incomplete** | The last read is under 10 minutes old, but some metric queries failed or were cut short. The row says which.                                  |
| **Metrics stalled**               | No read for 30 minutes and no error. Maple retries on its own.                                                                                |
| **Can't read metrics**            | Reads fail, and none has succeeded in the last 10 minutes. The row says why and what to do.                                                   |
| **Off**                           | Switched off. A second line appears while the read-only service account still exists.                                                         |

The page header and the Integrations list show the connection's worst status: **Needs attention**, **Setup pending**, **Changes pending**, **Waiting for data** or **Healthy**.

Then check the data:

1. Open [Logs](/docs/explore/logs) and look for a service named after one of your Cloud Run services, functions or instances.
2. In the [metrics explorer](/docs/explore/metrics), search for the prefix `gcp`.
3. Under **Dashboards → Browse templates**, select **Google Cloud** and click **Create dashboard**. To chart one project only, first fill in **Project ID** under **Parameters**, below the preview.
4. Open **Infrastructure → Google Cloud** for a table of your workloads per service.

## Permissions

The script enables these APIs in the host project:

- `pubsub.googleapis.com` and `logging.googleapis.com`, for log forwarding: carrying the log entries and routing them through the sink.
- `monitoring.googleapis.com`, `cloudasset.googleapis.com`, `iam.googleapis.com` and `iamcredentials.googleapis.com`, for metrics and resources: reading metrics, listing resources, creating the read-only service account and minting its short-lived tokens. No key is ever created.
- `cloudresourcemanager.googleapis.com`, for both: granting the roles below.

For log forwarding it creates a Pub/Sub topic and push subscription in the host project and a log sink on the project, folder or organization. For metrics and resources it creates a read-only service account in the host project. Each is named `maple-` followed by 24 hexadecimal characters unique to the connection.

It grants these roles:

- **Pub/Sub Publisher** (`roles/pubsub.publisher`) to the sink's Google-managed writer identity, on Maple's topic: publishing log entries to the topic.
- **Logs Writer** (`roles/logging.logWriter`) to the same writer identity, on the host project: Google requires it on the project that holds a sink's destination.
- **Monitoring Viewer** (`roles/monitoring.viewer`) to the read-only service account, on the project, folder or organization: reading metrics (`monitoring.timeSeries.list`).
- **Cloud Asset Viewer** (`roles/cloudasset.viewer`) to the read-only service account, on the project, folder or organization: listing resources (`cloudasset.assets.searchAllResources`). The role can also read resource metadata and IAM policies.
- **Service Usage Consumer** (`roles/serviceusage.serviceUsageConsumer`) to the read-only service account, on the host project: calling both read APIs through the host project.
- **Service Account Token Creator** (`roles/iam.serviceAccountTokenCreator`) to Maple's service account, on the read-only service account: minting short-lived tokens for that one account.

`roles/monitoring.viewer` and `roles/cloudasset.viewer` are the narrowest predefined roles for these calls, and both are read-only. On a folder or organization, every project under it inherits them.

### Roles for running the script

Owner on the host project is the simplest. Without it, these predefined roles together cover what the script does:

| On                                  | Role                                                                                                                                                                                             | For                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| The host project                    | Service Usage Admin (`roles/serviceusage.serviceUsageAdmin`)                                                                                                                                     | Switching on the APIs above.                          |
| The host project                    | Project IAM Admin (`roles/resourcemanager.projectIamAdmin`)                                                                                                                                      | The role grants on the host project.                  |
| The host project                    | Pub/Sub Admin (`roles/pubsub.admin`)                                                                                                                                                             | Log forwarding: the topic and the subscription.       |
| The host project                    | Service Account Admin (`roles/iam.serviceAccountAdmin`)                                                                                                                                          | Metrics and resources: the read-only service account. |
| The project, folder or organization | Logs Configuration Writer (`roles/logging.configWriter`)                                                                                                                                         | Log forwarding: the sink.                             |
| The project, folder or organization | Project IAM Admin (`roles/resourcemanager.projectIamAdmin`), Folder IAM Admin (`roles/resourcemanager.folderIamAdmin`) or Organization Administrator (`roles/resourcemanager.organizationAdmin`) | Metrics and resources: the read-only roles.           |

Before it changes anything, the script asks Google which permissions the signed-in account holds and stops with the missing ones.

## Collected data

### Logs

Maple receives every entry the sink's filter lets through. The recommended filter excludes:

| Excluded                    | Reason                                                                                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data Access audit logs      | They record every API read.                                                                                                                                                                       |
| Load balancer health checks | Probes hit each backend every few seconds.                                                                                                                                                        |
| Kubernetes lease renewals   | A GKE cluster renews its leader-election leases all day: hundreds of audit entries a minute for an idle node.                                                                                     |
| VM serial console output    | A VM writes thousands of lines of raw terminal output at boot.                                                                                                                                    |
| GKE container logs          | Workloads that send logs over OpenTelemetry already deliver them to Maple, so each line would be stored twice. See [GKE container logs](/docs/integrations/gcp-opentelemetry#gke-container-logs). |

The filter, one clause per line in the same order:

```text
NOT log_id("cloudaudit.googleapis.com/data_access")
AND NOT httpRequest.userAgent:"GoogleHC"
AND NOT protoPayload.methodName="io.k8s.coordination.v1.leases.update"
AND NOT logName:"serialconsole.googleapis.com"
AND NOT resource.type="k8s_container"
```

**Include GKE container logs** sets the filter without the last clause. To forward different logs, see [Log filter](#log-filter).

The script reports to Maple through a log named `maple-setup`. Maple reads that entry as the report and does not store it, so don't write your own logs under that name.

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

## Infrastructure → Google Cloud

**Infrastructure → Google Cloud** is in the sidebar and on the Infrastructure overview while a connection has **Metrics and resources** switched on.

The page opens with a band that counts the workloads of every service by health, then one tab per service that reported metrics in the selected time range, with one row per workload. The tab you are on stays when you change the range. Counts and byte totals cover the time range; everything else is the average over it.

| Band cell | Workloads it counts                                                                     |
| --------- | --------------------------------------------------------------------------------------- |
| Saturated | Using 90% or more of a CPU, memory or disk limit                                        |
| Elevated  | Using 60% or more of one                                                                |
| Erroring  | Failing 1% or more of at least 100 requests, executions or push deliveries in the range |

Click a cell to narrow every service tab to those workloads, and click it again to clear it.

| Tab             | One row per                               | Columns                                                                                                |
| --------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Cloud Run       | Service, project and region               | Requests, 5xx rate, latency p95 and p99, active instances, CPU p95, memory p95                         |
| Cloud Functions | 1st gen function, project and region      | Executions, error rate, duration p95 and p99, active instances, memory p95                             |
| GKE             | Container name, namespace and cluster     | CPU cores, CPU of limit, memory, memory of limit, restarts                                             |
| Compute Engine  | Instance, project and zone                | CPU, memory (E2 machine types only), network in and out, disk read and write                           |
| Cloud SQL       | Instance, project and region              | CPU, memory, disk, connections, replica lag                                                            |
| Pub/Sub         | Subscription and project                  | Backlog, age of the oldest unacknowledged message, delivered, acknowledged, dead-lettered, push errors |
| Load Balancing  | URL map, backend and project              | Requests, 5xx rate, latency p95 and p99, backend latency p95, response bytes                           |
| Resources       | Resource from the [inventory](#resources) | Type, project, location, state and labels, with a filter by type and by project                        |

Search a tab by name, project or location, filter every service tab by project and region, and click a column to sort by it. The search, the filters and the band cell are part of the page's address, so a link opens the same view. A dash means the workload did not report that metric. CPU below one core is written in millicores: `250m` is a quarter of a core. Cloud Functions (2nd gen) run on Cloud Run and appear on the Cloud Run tab. Pub/Sub topic metrics are collected but have no tab: chart them in a dashboard.

### Workload pages

Click a row to open that workload: its headline numbers, then its charts over the selected time range.

| Service         | Charts                                                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloud Run       | Requests by response class, 5xx rate, request latency, active and idle instances, CPU and memory utilization, peak concurrent requests per instance, billable instances   |
| Cloud Functions | Executions by status, error rate, execution time, active and idle instances, memory per execution, network egress                                                         |
| GKE             | CPU cores, CPU of limit, memory, memory of limit and restarts of the container, then CPU and memory of allocatable for the nodes of its cluster                           |
| Compute Engine  | CPU utilization, memory used (E2 machine types only), network received and sent, disk read and written                                                                    |
| Cloud SQL       | CPU, memory and disk utilization, connections, disk read and write operations, replica lag (read replicas only)                                                           |
| Pub/Sub         | Backlog, age of the oldest unacknowledged message, delivered and acknowledged messages, dead-lettered messages, push requests by response and push error rate (push only) |
| Load Balancing  | Requests by response class, 5xx rate, total latency, backend latency, backend requests by response class, request and response traffic                                    |

Latency charts draw p50, p95 and p99, and so do Cloud Run's CPU, memory and concurrency and a function's memory; every other line is the average. Traffic, messages and disk operations are per second; the charts by response class or status, restarts and dead-lettered messages are counts per point. A point covers at least 5 minutes, and more on a long range. A share of a limit carries a line at 80%. Hovering one chart marks the same moment on the others.

From a workload's page:

- **Logs** opens the workload's logs. A Cloud SQL instance, a subscription and a URL map open the logs of their resource type, narrowed to the resource.
- **Traces** is there when a service of the same name sent traces in the time range.
- The icon beside a chart's title opens its metric in the metrics explorer.
- When the workload is in the [inventory](#resources), a panel lists its project, location, state and labels, with a link to its product's list in the Google Cloud console, opened on the resource's project. A GKE container shows its cluster. The match is by type, project, name and location: a workload Maple cannot match exactly shows no panel.

### Elsewhere in Maple

- The **Infrastructure overview** row counts the workloads, colors them by health and lists up to three that are saturated, elevated or erroring. Each opens the workload's page. While every workload is healthy the row names the services that report.
- On the **service map**, the panel of a traced service shows the numbers of the Cloud Run service, function, GKE container or VM of the same name, with a link to its page.
- A row of the **Resources** tab that is one workload (a Cloud Run service, a 1st gen function, a VM, a Cloud SQL instance, a subscription) opens that workload's page.

The **Resources** tab shows the first 500 resources that match its filters, and how many projects Maple found. It does not depend on the time range.

Until a connection's setup script has run, the page reads **Finish setting up Google Cloud**. After the run it reads **Collecting your first Google Cloud metrics** until the first read lands, within about 10 minutes.

With **Metrics and resources** switched off on every connection, the page leaves the sidebar and the overview. Its address still opens it: for a time range with data it shows the service tabs with what Maple collected before, under the notice **Google Cloud metrics are switched off**, and otherwise it reads **Turn on metrics for Google Cloud**. The **Resources** tab is back once a connection collects again.

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
- One read takes up to 20,000 data points per metric, about 4,000 series, and up to 2 minutes in total. Past that, the connection says how many metric queries were cut short. For a folder or organization, connect its folders or projects separately to collect all of it.
- Maple reads up to 10 connections of one Maple organization every 5 minutes. With more, they take turns.
- The resource list holds up to 10,000 resources per connection.
- Load balancer metrics cover global external Application Load Balancers only.

## Troubleshooting

### In Cloud Shell

A step that fails stops the script. It prints what went wrong, Google's answer, and a line that starts with `What to do:`. Nothing needs undoing: fix it and paste the script again. A connection's ID can't be changed, so a wrong ID is fixed by removing the connection in Maple and connecting the right ID. In the lines below, _account_ stands for the account you are signed in as.

| The script prints                                                               | Cause and fix                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Can't open project acme-prod as _account_."                                    | The ID is wrong, or the account has no access to the project. Check the ID with `gcloud projects list`. It is the project ID, not the name or number. If it is wrong, remove the connection and connect the right ID.                                                                                       |
| "_account_ has none of the permissions this script needs on project acme-prod." | Check the ID in Maple first. If it is wrong, remove the connection and connect the right ID. If it is right, the account has no rights there: ask for the roles under [Prerequisites](#prerequisites), or have an administrator run the script.                                                             |
| "_account_ is missing permissions on project acme-prod:" and a list             | The account lacks a role. The line names the permissions and the role to ask for. If the only one listed is the permission to enable services, an API the script needs is off: ask for Service Usage Admin on the host project, or have an administrator switch the named APIs on. Nothing was created yet. |
| "Project acme-prod has no billing account."                                     | Link a billing account to the host project, then paste the script again.                                                                                                                                                                                                                                    |
| "Google does not accept the log filter."                                        | `LOG_FILTER` was edited into something Google can't parse. Correct it near the top of the script and paste it again. Nothing was created yet.                                                                                                                                                               |
| "An organization policy (domain restricted sharing) blocks this grant."         | See [Domain restricted sharing](#domain-restricted-sharing).                                                                                                                                                                                                                                                |
| "Google is still switching an API on, or the API is off."                       | Wait a minute and paste the script again.                                                                                                                                                                                                                                                                   |
| "Google has not published the new service account yet."                         | Wait a minute and paste the script again.                                                                                                                                                                                                                                                                   |
| "Couldn't reach Maple to confirm."                                              | Cloud Shell could not reach Maple. Google Cloud is set up, and Maple shows **Setup pending** or **Changes pending** until a later run reaches it. Paste the script again.                                                                                                                                   |

When you create a connection in Maple, "The Google Cloud project acme-prod is already connected." means this Maple organization already has a connection for it. Change that connection's switches instead.

### Log forwarding

| The connection shows                                                                             | Cause and fix                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Setup pending** after the script ran                                                           | The script stopped before it finished, or could not reach Maple. Read its last lines in Cloud Shell and paste it again.                                                                                      |
| **Waiting for first logs** for more than 20 minutes                                              | Either nothing was logged that passes the filter, or the sink can't publish. Run the `gcloud logging write` command the row shows. If the entry does not arrive within a minute, run the setup script again. |
| **Rejecting logs**: "The Pub/Sub subscription wraps each entry in an envelope Maple can't read." | The subscription was changed to deliver wrapped messages. Run the setup script again: it resets the subscription. Entries sent meanwhile are lost.                                                           |
| **Rejecting logs**: "Maple could not store an entry just now."                                   | Nothing to do. Pub/Sub retries the entry for up to a day, and the status returns to **Receiving logs** with the next accepted entry.                                                                         |
| **Rejecting logs**: "This Maple organization is over its plan limit, so Maple refuses new logs." | Raise the plan limit under **Settings → Billing**. Pub/Sub retries refused entries for up to a day.                                                                                                          |
| GKE container logs appear twice                                                                  | The sink forwards GKE container logs and the workloads also send them over OpenTelemetry. Choose **Recommended: no GKE container logs** as the [log filter](#log-filter) and run the script again.           |
| GKE container logs are missing                                                                   | The recommended filter leaves them out. If the workloads don't send their logs over OpenTelemetry, choose **Include GKE container logs** as the [log filter](#log-filter) and run the script again.          |

### Metrics and resources

**Can't read metrics** and **Receiving metrics, incomplete** come with one of the messages below. The first means no read has succeeded in the last 10 minutes. The second means the last read is under 10 minutes old and something is missing. The messages about the resource list show under a green **Receiving metrics**. Where a project's message says "the project", a folder's or organization's says "the host project".

| The connection shows                                                                | Cause and fix                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Metrics stalled**                                                                 | No read for 30 minutes and no error. Maple retries on its own. If it stays for more than an hour, write to support.                                                                                                                                                                                |
| "Maple can't sign in as this connection's read-only service account yet."           | Shown from 10 minutes after a setup run, on a connection Maple has never read. The account does not exist, or the grant to Maple is missing or blocked by an organization policy. Run the setup script again and read its last lines. See [Domain restricted sharing](#domain-restricted-sharing). |
| "Maple can no longer sign in as this connection's read-only service account."       | Maple has read this connection before. The account was deleted, or the grant to Maple was removed or is blocked by an organization policy. Run the setup script again: it restores both, or says what blocks it.                                                                                   |
| "The project acme-prod has no active billing account"                               | Link a billing account to the host project. The message carries the link. Maple retries every 5 minutes.                                                                                                                                                                                           |
| "The Cloud Monitoring API is switched off in the project acme-prod."                | Run the setup script again: it switches the API on.                                                                                                                                                                                                                                                |
| "Google denied Maple's read of project acme-prod: the read-only roles are missing." | Run the setup script again: it grants them. A new grant can take a few minutes to work.                                                                                                                                                                                                            |
| "Google rate-limited the Cloud Monitoring API for the project acme-prod."           | Maple keeps what it read and retries in 5 minutes. If it repeats, raise that API's quota on the host project.                                                                                                                                                                                      |
| "3 of 46 metric queries failed, first ..."                                          | The rest were stored. The failed metrics miss those minutes, and Maple retries in 5 minutes.                                                                                                                                                                                                       |
| "3 of 46 metric queries were not read in full"                                      | The project, folder or organization holds more series than one read takes. Connect the folders or projects of a folder or organization as separate connections. For a single project, write to support.                                                                                            |
| "Reading the metrics took longer than two minutes."                                 | Maple reads the same minutes again, which can store part of them twice. If it repeats, connect the folders or projects of a folder or organization separately. For a single project, write to support.                                                                                             |
| "Metrics are paused: this Maple organization is over its plan limit."               | Raise the plan limit under **Settings → Billing**. Maple tries again in an hour.                                                                                                                                                                                                                   |
| "Maple could not store the metrics it read just now."                               | Nothing to do. Maple reads the same minutes again.                                                                                                                                                                                                                                                 |
| "Google denied the resource listing for project acme-prod."                         | Run the setup script again: it grants Cloud Asset Viewer. Metrics are unaffected.                                                                                                                                                                                                                  |
| "The project holds more than 10,000 resources, so the resource list is incomplete." | Metrics are unaffected. For a full list, connect the folders or projects of a folder or organization separately. For a single project, write to support.                                                                                                                                           |
| "The resource listing ran out of time and is incomplete."                           | Nothing to do. Maple retries within the hour.                                                                                                                                                                                                                                                      |

A message that ends in parentheses, such as "(Cloud Monitoring returned 403, BILLING_DISABLED)", quotes Google's answer. Include it when you write to support.

On a self-hosted Maple, the **Metrics and resources** switch reads **Not available on this Maple deployment** until `MAPLE_GCP_SERVICE_ACCOUNT_EMAIL` names a Google service account the deployment owns. Reading metrics also needs `MAPLE_GCP_SERVICE_ACCOUNT_KEY`, that account's key file, base64-encoded.

### Domain restricted sharing

An organization policy can restrict which identities may hold IAM roles in your organization (`constraints/iam.allowedPolicyMemberDomains`, or a custom constraint on member domains). Maple's service account lives outside your organization, so such a policy can reject a grant the script makes, most often the one that lets Maple read as your read-only service account. The script then stops with "An organization policy (domain restricted sharing) blocks this grant."

An Organization Policy Administrator can lift the policy for the host project while the script runs:

1. In the Google Cloud console, open **IAM & Admin → Organization Policies** with the host project selected.
2. Open **Domain restricted sharing**, click **Manage policy**, choose **Override parent's policy** and add a rule that allows all. This applies to the host project only.
3. Paste the setup script again. It continues where it stopped.

Google checks the policy when a grant is made, so the grant stays in place if you restore the policy afterwards.

## Disconnect

1. On **Integrations → Google Cloud**, click **Disconnect** on the connection.
2. Click **Copy cleanup script** and run it in Cloud Shell. It deletes the log sink, topic, subscription and read-only service account, and ends with "Done. Everything the setup script created is gone."
3. Wait for the check mark in the dialog, then click **Disconnect**. Maple stops reading the connection's metrics, and stops accepting its logs within about a minute. Data already in Maple is kept.

The cleanup takes one to two minutes when the connection forwards logs: after it deletes the sink it waits a minute for Google to stop routing to the topic, so your project logs no sink error. Switching **Log forwarding** off and running the setup script takes as long, for the same reason.

**Disconnect anyway** disconnects without the cleanup. Google Cloud then keeps publishing logs to Pub/Sub, billed by Google, until the cleanup script runs. Maple keeps a panel with **Copy cleanup script** on the page until you click **Done**.

The cleanup script leaves the APIs it switched on enabled, and the Logs Writer role of Google's logging service account on the host project, which other sinks share.

A connection whose setup script Maple never saw run has a **Remove** button instead and asks once. Maple still offers the cleanup script afterwards, in case the setup script ran part of the way.

## Next steps

- [Google Cloud with OpenTelemetry](/docs/integrations/gcp-opentelemetry): what to instrument on GKE, Cloud Run and Compute Engine.
- [Logs](/docs/explore/logs): search Google Cloud logs next to your application logs.
- [Dashboards](/docs/dashboards/build-dashboards#templates): start from the **Google Cloud** template.
- **Infrastructure → Google Cloud**: scan every workload of a service in one table.
- [Alert rules](/docs/alerting/alert-rules): alert on any `gcp.*` metric.
- [API reference](/docs/reference/api): manage connections with the `/v2/integrations/gcp` endpoints.
