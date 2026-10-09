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

If you can't get Owner, see [Roles for running the script](#roles-for-running-the-script).

The host project holds Maple's Pub/Sub topic, subscription and read-only service account. A project is its own host project. For a folder or organization, name a shared operations project inside it that won't be deleted. Google bills the Pub/Sub and Cloud Monitoring usage to the host project.

**Metrics and resources** needs billing enabled on the host project: Cloud Monitoring only answers for projects that have a billing account. The script checks this before it changes anything.

### Find your IDs

| ID              | Where to find it                                                                                                                                               |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project ID      | The console's project picker lists it next to each project name, or run `gcloud projects list`. It is not the project name or number.                          |
| Organization ID | **IAM & Admin → [Manage resources](https://console.cloud.google.com/cloud-resource-manager)** in the console, or run `gcloud organizations list`. Digits only. |
| Folder ID       | The same console page, or run `gcloud resource-manager folders list --organization=ORGANIZATION_ID`. Digits only.                                              |

## Connect

1. Open **Integrations → Google Cloud** in Maple.
2. Under **What to connect**, choose **Organization**, **Folder** or **Project** and enter its ID. An organization or folder covers every project in it, including new ones.
3. For an organization or folder, enter the **Host project ID**.
4. Under **What to collect**, leave **Log forwarding** and **Metrics and resources** ticked, or untick one. Click **Get setup script**.
5. Click **Open Cloud Shell** and sign in with the roles above.
6. Click **Copy script**, paste it into Cloud Shell and press Enter. The script takes about a minute and is safe to run again.
7. Return to Maple. **Maple confirms the connection** shows a check mark about 15 seconds after the script ends.

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

If a step fails, the script stops and prints what to do. Fix it and paste the script again: it continues where it stopped.

After the check mark, each switch waits for its first data:

| Switch                | First data                                                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Log forwarding        | A new sink can take about 10 minutes to start forwarding. Entries logged before it does are not forwarded later.        |
| Metrics and resources | The first read lands within about 10 minutes. Maple reads every 5 minutes, about 5 minutes behind, to get full minutes. |

The first two lines and the last two lines of the pasted text run the script in a bash process of its own, so a failed step can't close your Cloud Shell session. In Cloud Shell they also keep the paste out of shell history. zsh, and bash before version 5, keep it: clear the history entry if you paste there.

The script contains a secret that lets anyone send logs to your Maple organization. Don't share it or commit it. The push endpoint with the secret is also visible in the subscription's configuration and in the host project's Admin Activity audit log, to anyone who can read those. If it leaks, disconnect and connect again: the new connection gets a new secret.

A project, folder or organization can be connected once per Maple organization. A project that sits inside a connected organization or folder is collected twice if you also connect it on its own.

### Change what a connection collects

1. Flip **Log forwarding** or **Metrics and resources** on the connection. Maple saves the switch at once.
2. The connection reads **Changes pending** and lists what the script will create or remove in Google Cloud.
3. Click **Show setup script**, copy the script and run it in Cloud Shell again. The notice goes away when the run reports to Maple.

Until the script runs, Google Cloud keeps what the last run set up:

| Switched off          | Until the script runs again                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| Log forwarding        | Google Cloud keeps publishing logs to Pub/Sub. Maple discards them within about a minute of the switch. |
| Metrics and resources | The read-only service account stays in Google Cloud. Maple no longer uses it.                           |

A connection keeps at least one switch on. To stop both, [disconnect](#disconnect).

### Log filter

The setup panel's **Log filter** decides which filter the script writes onto the sink:

| Log filter                                    | The script                                                                                                                                                 |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Keep the sink's current filter**            | Leaves an existing sink's filter as it is. Offered, and preselected, once a run has set log forwarding up.                                                 |
| **Maple default**                             | Sets the [default filter](#logs).                                                                                                                          |
| **Maple default, without GKE container logs** | Sets the default filter and also leaves out GKE container logs. Use it when your pods already send their logs to Maple through an OpenTelemetry collector. |

For any other filter, edit `LOG_FILTER` at the top of the script and set `LOG_FILTER_MODE` to `set`. The filter uses the [Logging query language](https://cloud.google.com/logging/docs/view/logging-query-language). Later runs with **Keep the sink's current filter** leave your filter in place.

## Verify

Each connection shows a status per switch. The page updates on its own.

| Log forwarding             | Meaning                                                                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Setup pending**          | The setup script has not set log forwarding up yet. Run it.                                                                        |
| **Waiting for first logs** | The script ran and no entry has arrived. After 20 minutes the row shows a `gcloud logging write` command that writes a test entry. |
| **Receiving logs**         | Entries arrive. The row shows when the last one did.                                                                               |
| **No logs in 24 hours**    | Nothing passed the filter for a day. Not an error.                                                                                 |
| **Rejecting logs**         | Maple refused the last push. The row says why and what to do.                                                                      |
| **Off**                    | Switched off. A second line appears while Google Cloud still forwards logs.                                                        |

| Metrics and resources             | Meaning                                                                                                                                       |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Setup pending**                 | The setup script has not granted Maple read access yet. Run it.                                                                               |
| **Waiting for first metrics**     | The script ran and the first read has not landed.                                                                                             |
| **Receiving metrics**             | Reads succeed. A folder or organization also shows how many projects Maple found. A second line appears when the resource list is incomplete. |
| **Receiving metrics, incomplete** | Recent reads arrive, but some metric queries failed or were cut short. The row says which.                                                    |
| **Metrics stalled**               | No read for 30 minutes and no error. Maple retries on its own.                                                                                |
| **Can't read metrics**            | Reads fail. The row says why and what to do.                                                                                                  |
| **Off**                           | Switched off. A second line appears while the read-only service account still exists.                                                         |

The page header and the Integrations list show the connection's worst status: **Needs attention**, **Setup pending**, **Changes pending**, **Waiting for data** or **Healthy**.

Then check the data:

1. Open [Logs](/docs/explore/logs) and look for a service named after one of your Cloud Run services, functions, containers or instances.
2. In the [metrics explorer](/docs/explore/metrics), search for `gcp.`.
3. Under **Dashboards → Browse templates**, select **Google Cloud** and click **Create dashboard**. To chart one project only, first fill in **Project ID** under **Parameters**, below the preview.
4. Open **Infrastructure → Google Cloud** for a table of your workloads per service.

## Permissions

The script enables these APIs in the host project:

| API                                   | Enabled for           | Used for                                                     |
| ------------------------------------- | --------------------- | ------------------------------------------------------------ |
| `pubsub.googleapis.com`               | Log forwarding        | Carrying the log entries.                                    |
| `logging.googleapis.com`              | Log forwarding        | Routing them through the sink.                               |
| `monitoring.googleapis.com`           | Metrics and resources | Reading metrics.                                             |
| `cloudasset.googleapis.com`           | Metrics and resources | Listing resources.                                           |
| `iam.googleapis.com`                  | Metrics and resources | Creating the reader service account.                         |
| `iamcredentials.googleapis.com`       | Metrics and resources | Short-lived tokens for that account. No key is ever created. |
| `cloudresourcemanager.googleapis.com` | Both                  | Granting the roles below.                                    |

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

### Roles for running the script

Owner on the host project is the simplest. Without it, these predefined roles together cover what the script does:

| On                                  | Role                                                              | For                                                   |
| ----------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------- |
| The host project                    | Service Usage Admin (`roles/serviceusage.serviceUsageAdmin`)      | Switching on the APIs above.                          |
| The host project                    | Project IAM Admin (`roles/resourcemanager.projectIamAdmin`)       | The role grants on the host project.                  |
| The host project                    | Pub/Sub Admin (`roles/pubsub.admin`)                              | Log forwarding: the topic and the subscription.       |
| The host project                    | Service Account Admin (`roles/iam.serviceAccountAdmin`)           | Metrics and resources: the read-only service account. |
| The project, folder or organization | Logs Configuration Writer (`roles/logging.configWriter`)          | Log forwarding: the sink.                             |
| The project, folder or organization | Project IAM Admin, Folder IAM Admin or Organization Administrator | Metrics and resources: the read-only roles.           |

Before it changes anything, the script asks Google which permissions the signed-in account holds and stops with the missing ones.

## Collected data

### Logs

Maple receives every entry the sink's filter lets through. The default filter excludes:

| Excluded                    | Filter clause                                                        |
| --------------------------- | -------------------------------------------------------------------- |
| Data Access audit logs      | `NOT log_id("cloudaudit.googleapis.com/data_access")`                |
| Load balancer health checks | `NOT httpRequest.userAgent:"GoogleHC"`                               |
| Kubernetes lease renewals   | `NOT protoPayload.methodName="io.k8s.coordination.v1.leases.update"` |
| VM serial console output    | `NOT logName:"serialconsole.googleapis.com"`                         |

All four are high in volume and say little about a workload. Data Access audit logs record every API read. Health checks probe each backend every few seconds. A GKE cluster renews its leader-election leases all day, hundreds of audit entries a minute for an idle node. A VM writes thousands of lines of raw terminal output to its serial console at boot.

**Maple default, without GKE container logs** adds `NOT resource.type="k8s_container"`. To forward different logs, see [Log filter](#log-filter).

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

**Infrastructure → Google Cloud** appears in the sidebar and on the Infrastructure overview once a connection has **Metrics and resources** switched on. It has one tab per service that reported metrics in the selected time range, with one row per workload. Counts and byte totals cover the time range; everything else is the average over it.

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

Search a tab by name, project or location, and click a column to sort by it. A dash means the workload did not report that metric. CPU below one core is written in millicores: `250m` is a quarter of a core. Cloud Functions (2nd gen) run on Cloud Run and appear on the Cloud Run tab. GKE node and Pub/Sub topic metrics are collected but have no tab: chart them in a dashboard.

The **Resources** tab shows the first 500 resources that match its filters, and how many projects Maple found. It does not depend on the time range.

Until a connection's setup script has run, the page reads **Finish setting up Google Cloud**. After the run it reads **Collecting your first Google Cloud metrics** until the first read lands, within about 10 minutes.

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
- One read takes up to 20,000 data points per metric, about 4,000 series, and up to 2 minutes in total. Past that, the connection says how many metric queries were cut short. Connect folders or projects separately to collect all of it.
- Maple reads up to 10 connections of one Maple organization every 5 minutes. With more, they take turns.
- The resource list holds up to 10,000 resources per connection.
- Load balancer metrics cover global external Application Load Balancers only.

## Troubleshooting

### In Cloud Shell

A failed step ends with `What to do:` and one line of remedy. These are the common ones:

| The script prints                                                       | Cause and fix                                                                                                                                                             |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Can't open project <ID> as <account>.`                                 | The ID is wrong, or the account has no access to the project. Check the ID with `gcloud projects list`. It is the project ID, not the name or number.                     |
| `<account> is missing permissions on <scope>: ...`                      | The account lacks a role. The line names the permissions and the role to ask for. Nothing was created yet.                                                                |
| `Project <ID> has no billing account.`                                  | Link a billing account to the host project, then paste the script again.                                                                                                  |
| `An organization policy (domain restricted sharing) blocks this grant.` | See [Domain restricted sharing](#domain-restricted-sharing).                                                                                                              |
| `Google is still switching an API on, or the API is off.`               | Wait a minute and paste the script again.                                                                                                                                 |
| `Google has not published the new service account yet.`                 | Wait a minute and paste the script again.                                                                                                                                 |
| `Couldn't reach Maple to confirm.`                                      | Cloud Shell could not reach Maple. Google Cloud is set up, and Maple shows **Setup pending** or **Changes pending** until a later run reaches it. Paste the script again. |

In Maple, `The Google Cloud <project, folder or organization> <ID> is already connected.` means this Maple organization already has a connection for it. Change that connection's switches instead.

### Log forwarding

| The connection shows                                                                             | Cause and fix                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Setup pending** after the script ran                                                           | The script stopped before it finished, or could not reach Maple. Read its last lines in Cloud Shell and paste it again.                                                                                      |
| **Waiting for first logs** for more than 20 minutes                                              | Either nothing was logged that passes the filter, or the sink can't publish. Run the `gcloud logging write` command the row shows. If the entry does not arrive within a minute, run the setup script again. |
| **Rejecting logs**: `The Pub/Sub subscription wraps each entry in an envelope Maple can't read.` | The subscription was changed to deliver wrapped messages. Run the setup script again: it resets the subscription. Entries sent meanwhile are lost.                                                           |
| **Rejecting logs**: `Maple could not store an entry just now.`                                   | Nothing to do. Pub/Sub retries the entry for up to a day, and the status returns to **Receiving logs** with the next accepted entry.                                                                         |
| **Rejecting logs**: `This Maple organization is over its plan limit, so Maple refuses new logs.` | Raise the plan limit under **Settings → Billing**. Pub/Sub retries refused entries for up to a day.                                                                                                          |
| GKE logs appear twice                                                                            | Your pods also send logs through an OpenTelemetry collector. Choose **Maple default, without GKE container logs** as the [log filter](#log-filter) and run the script again.                                 |

### Metrics and resources

| The connection shows                                                                   | Cause and fix                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Maple can't sign in as this connection's read-only service account yet.`              | Shown from 10 minutes after a setup run. The account does not exist, or the grant to Maple is missing or blocked by an organization policy. Run the setup script again and read its last lines. See [Domain restricted sharing](#domain-restricted-sharing). |
| `The host project <ID> has no active billing account`                                  | Link a billing account to the host project. The message carries the link. Maple retries every 5 minutes.                                                                                                                                                     |
| `The <API> API is switched off in the host project <ID>.`                              | Run the setup script again: it switches the API on.                                                                                                                                                                                                          |
| `Google denied Maple's read of <scope>: the read-only roles are missing.`              | Run the setup script again: it grants them. A new grant can take a few minutes to work.                                                                                                                                                                      |
| `Google rate-limited the <API> API for the host project <ID>.`                         | Maple keeps what it read and retries in 5 minutes. If it repeats, raise that API's quota on the host project.                                                                                                                                                |
| `<n> of 46 metric queries failed, first <metric>.`                                     | The rest were stored. The failed metrics miss those minutes, and Maple retries in 5 minutes.                                                                                                                                                                 |
| `<n> of 46 metric queries were not read in full`                                       | The scope holds more series than one read takes. Connect its folders or projects as separate connections.                                                                                                                                                    |
| `Reading the metrics took longer than two minutes.`                                    | Maple reads the same minutes again, which can store part of them twice. If it repeats, connect folders or projects separately.                                                                                                                               |
| `Metrics are paused: this Maple organization is over its plan limit.`                  | Raise the plan limit under **Settings → Billing**. Maple tries again in an hour.                                                                                                                                                                             |
| `Maple could not store the metrics it read just now.`                                  | Nothing to do. Maple reads the same minutes again.                                                                                                                                                                                                           |
| `Google denied the resource listing for <scope>.`                                      | Run the setup script again: it grants Cloud Asset Viewer. Metrics are unaffected.                                                                                                                                                                            |
| `The scope holds more than 10,000 resources, so the resource list is incomplete.`      | Metrics are unaffected. Connect folders or projects separately for a full list.                                                                                                                                                                              |
| `The resource listing ran out of time and is incomplete.`                              | Nothing to do. Maple retries within the hour.                                                                                                                                                                                                                |
| The **Metrics and resources** switch reads **Not available on this Maple deployment.** | A self-hosted deployment needs `MAPLE_GCP_SERVICE_ACCOUNT_EMAIL` set to a Google service account it owns. Reading metrics also needs `MAPLE_GCP_SERVICE_ACCOUNT_KEY`, that account's key file, base64-encoded.                                               |

A message that ends in parentheses, such as `(Cloud Monitoring returned 403)`, quotes Google's answer. Include it when you write to support.

### Domain restricted sharing

An organization policy can restrict which identities may hold IAM roles in your organization (`constraints/iam.allowedPolicyMemberDomains`, or a custom constraint on member domains). Maple's service account lives outside your organization, so such a policy rejects the one grant that lets Maple read as your read-only service account. The script then stops with `An organization policy (domain restricted sharing) blocks this grant.`

An Organization Policy Administrator can lift the policy for the host project:

1. In the Google Cloud console, open **IAM & Admin → Organization Policies** with the host project selected.
2. Open **Domain restricted sharing** and override the parent's policy for this project so that the grant is allowed.
3. Paste the setup script again. It continues where it stopped.
4. Restore the policy afterwards if your organization requires it. The grant stays in place.

## Disconnect

1. On **Integrations → Google Cloud**, click **Disconnect** on the connection.
2. Click **Copy cleanup script** and run it in Cloud Shell. It deletes the log sink, topic, subscription and read-only service account, and ends with `Done. Everything the setup script created is gone.` The dialog shows a check mark when the script has run.
3. Click **Disconnect**. Maple stops accepting the connection's logs and reading its metrics. Data already in Maple is kept.

If you disconnect before the cleanup ran, Google Cloud keeps publishing logs to Pub/Sub, billed by Google, until the script runs. Maple keeps a panel with the cleanup script on the page until you click **Done**.

The cleanup script leaves the APIs it switched on enabled, and the Logs Writer role of Google's logging service account on the host project, which other sinks share.

A connection whose setup script never ran has nothing in Google Cloud. **Disconnect** removes it after one confirmation.

## Next steps

- [Logs](/docs/explore/logs): search Google Cloud logs next to your application logs.
- [Dashboards](/docs/dashboards/build-dashboards#templates): start from the **Google Cloud** template.
- **Infrastructure → Google Cloud**: scan every workload of a service in one table.
- [Alert rules](/docs/alerting/alert-rules): alert on any `gcp.*` metric.
- [API reference](/docs/reference/api): manage connections with the `/v2/integrations/gcp` endpoints.
