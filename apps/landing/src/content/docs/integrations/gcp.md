---
title: "Google Cloud"
description: "Connect a Google Cloud organization, folder or project with a script in Cloud Shell, by hand in the console, or with Terraform or Alchemy. Maple receives Cloud Logging entries through Pub/Sub and reads Cloud Monitoring metrics every 5 minutes."
group: "Integrations"
order: 7
---

The Google Cloud integration connects an organization, a folder or a single project to Maple. You choose what each connection collects:

| What to collect           | Collects                                                                                                                                                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Log forwarding**        | A Log Router sink sends Cloud Logging entries through Pub/Sub to Maple. They appear in [Logs](/docs/explore/logs) under the service that wrote them.                                                                                                                           |
| **Metrics and resources** | Maple reads Cloud Monitoring metrics for Cloud Run, Cloud Functions, GKE, Compute Engine, Cloud SQL, Pub/Sub and HTTP(S) load balancers every 5 minutes, and lists the resources behind them every hour. The metrics are named `gcp.*` and work in dashboards and alert rules. |

There is no OAuth step and no service account key, and Maple gets no write access to Google Cloud. You set a connection up in one of three ways, chosen in the dialog's **Method** step. Each creates the same resources under the same names:

| Method                     | What you do                                                                                                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cloud Shell script**     | Paste a generated `gcloud` script into Cloud Shell. About a minute. This page covers it.                                                                    |
| **Manual setup**           | Create each resource in the Google Cloud console from a step list in the dialog. About 20 minutes. See [Manual setup](/docs/integrations/gcp-manual-setup). |
| **Infrastructure as code** | Copy a generated Terraform or Alchemy file into your own repo and apply it. See [Terraform and Alchemy](/docs/integrations/gcp-infrastructure-as-code).     |

If your workloads also send telemetry over OpenTelemetry, read [Google Cloud with OpenTelemetry](/docs/integrations/gcp-opentelemetry) first: it covers which logs to collect where.

## Before you start

You need to be an admin of the Maple organization, and in Google Cloud:

| You connect     | Roles you need                                                                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| A project       | Owner on the project.                                                                                                                               |
| A folder        | Owner on the host project. On the folder: Logs Configuration Writer for the log sink, and Folder IAM Admin for the read-only roles.                 |
| An organization | Owner on the host project. On the organization: Logs Configuration Writer for the log sink, and Organization Administrator for the read-only roles. |

The host project holds Maple's Pub/Sub topic, subscription and service accounts, and Google bills the Pub/Sub and Cloud Monitoring usage to it. A project is its own host project. For a folder or organization, name a shared operations project inside it that won't be deleted. **Metrics and resources** needs billing enabled on the host project.

| ID              | Where to find it                                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Project ID      | The console's project picker, or `gcloud projects list`. Not the project name or number.                                                    |
| Organization ID | **IAM & Admin → [Manage resources](https://console.cloud.google.com/cloud-resource-manager)**, or `gcloud organizations list`. Digits only. |
| Folder ID       | The same console page, or `gcloud resource-manager folders list --organization=ORGANIZATION_ID`. Digits only.                               |

## Connect

1. In Maple, open **Integrations → Google Cloud** and click **Connect Google Cloud**.
2. On **Scope**, choose **Organization**, **Folder** or **Project** and enter its ID, plus the host project for a folder or organization. An organization or folder covers every project in it, including new ones.
3. On **Data**, choose what to collect and, for logs, the [log filter](#log-filter). Click **Continue**: Maple creates the connection.
4. On **Method**, leave **Cloud Shell script** selected and click **Continue**. For the other methods, follow [Manual setup](/docs/integrations/gcp-manual-setup) or [Terraform and Alchemy](/docs/integrations/gcp-infrastructure-as-code) from here.
5. Click **Open Cloud Shell**, then **Copy script**, paste it into Cloud Shell and press Enter. It takes about a minute.
6. The dialog updates on its own and shows **Google Cloud matches this configuration** once the script reports back.

If a step fails, the script stops and prints what to do. Fix it and paste the script again: it continues where it stopped, and running it again is always safe.

Logs start arriving within about 10 minutes of the sink being created; entries written before then are not forwarded. The first metrics read lands within about 10 minutes, and Maple then reads every 5 minutes, about 5 minutes behind.

The script contains a secret that lets anyone send logs to your Maple organization. Don't share or commit it, and run it in Cloud Shell, where it stays out of shell history. If it leaks, disconnect and connect again to get a new one. Manual and infrastructure-as-code setups carry no secret: Pub/Sub signs each push instead.

### Roles for running the script

Owner on the host project is the simplest. Without it, these predefined roles together cover what the script does. Before it changes anything, the script checks the signed-in account's permissions and names any that are missing.

| On                                  | Role                                                                                                                                                                                             | For                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| The host project                    | Service Usage Admin (`roles/serviceusage.serviceUsageAdmin`)                                                                                                                                     | Switching on the APIs.                                |
| The host project                    | Project IAM Admin (`roles/resourcemanager.projectIamAdmin`)                                                                                                                                      | The role grants on the host project.                  |
| The host project                    | Pub/Sub Admin (`roles/pubsub.admin`)                                                                                                                                                             | Log forwarding: the topic and the subscription.       |
| The host project                    | Service Account Admin (`roles/iam.serviceAccountAdmin`)                                                                                                                                          | Metrics and resources: the read-only service account. |
| The project, folder or organization | Logs Configuration Writer (`roles/logging.configWriter`)                                                                                                                                         | Log forwarding: the sink.                             |
| The project, folder or organization | Project IAM Admin (`roles/resourcemanager.projectIamAdmin`), Folder IAM Admin (`roles/resourcemanager.folderIamAdmin`) or Organization Administrator (`roles/resourcemanager.organizationAdmin`) | Metrics and resources: the read-only roles.           |

### Change what a connection collects

Click **Configure** on the connection's row, change **Log forwarding**, **Metrics and resources** or the log filter, and click **Save and continue**. Then apply the change the way you set the connection up: run the script again, follow the dialog's console steps, or apply the regenerated file.

Turning something off takes effect in Maple at once. Google Cloud keeps the sink or the read-only account until the change is applied, and the connection says so until then. A connection collects at least one of the two; to stop collecting, [disconnect](#disconnect).

### Log filter

Platform, request and audit logs are forwarded. The default filter leaves out what costs a lot and says little:

| Left out                    | Reason                                                                                                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Data Access audit logs      | They record every API read.                                                                                                                                                                |
| Load balancer health checks | Probes hit each backend every few seconds.                                                                                                                                                 |
| Kubernetes lease renewals   | Hundreds of audit entries a minute for an idle node.                                                                                                                                       |
| VM serial console output    | Thousands of lines of raw terminal output at boot.                                                                                                                                         |
| Application output          | What your code writes to stdout and stderr: send it over OpenTelemetry. See [Application output](/docs/integrations/gcp-opentelemetry#application-output) to forward it for some runtimes. |

The filter, one clause per line:

```text
NOT log_id("cloudaudit.googleapis.com/data_access")
AND NOT httpRequest.userAgent:"GoogleHC"
AND NOT protoPayload.methodName="io.k8s.coordination.v1.leases.update"
AND NOT logName:"serialconsole.googleapis.com"
AND NOT (log_id("run.googleapis.com/stdout") OR log_id("run.googleapis.com/stderr"))
AND NOT log_id("cloudfunctions.googleapis.com/cloud-functions")
AND NOT (resource.type="gae_app" AND (log_id("stdout") OR log_id("stderr")))
AND NOT resource.type="k8s_container"
```

For any other filter, paste the script into an editor, edit `LOG_FILTER` near its top and set `LOG_FILTER_MODE` to `set`; in the console or a file, edit the sink's filter. It uses the [Logging query language](https://cloud.google.com/logging/docs/view/logging-query-language). On a connection that already has a sink, the dialog starts on **Keep current filter**, which leaves your filter alone.

## Check that it works

**Integrations → Google Cloud** shows each connection with a status for **Logs** and one for **Metrics**, and a band with the fix when something needs attention. Once data arrives, the page also shows log and error counts for the last 24 hours, the workloads that reported metrics, and the resource inventory. Then:

1. Open [Logs](/docs/explore/logs) and look for a service named after one of your Cloud Run services, functions or instances.
2. In the [metrics explorer](/docs/explore/metrics), search for the prefix `gcp`.
3. Under **Dashboards → Browse templates**, create a dashboard from the **Google Cloud** template.
4. Open **Infrastructure → Google Cloud** for a table of your workloads per service.

## What Maple collects

### Logs

Each entry gets its `service.name` from the resource that wrote it, so workload logs join the traced service of the same name:

| Resource                | `service.name`                                                    |
| ----------------------- | ----------------------------------------------------------------- |
| Cloud Run service, job  | The service or job name.                                          |
| Cloud Function          | The function name.                                                |
| GKE container           | The container name.                                               |
| Compute Engine instance | The instance name, or `gcp/gce_instance` when the entry has none. |
| App Engine              | The module ID.                                                    |
| Everything else         | `gcp/<resource type>`, for example `gcp/cloudsql_database`.       |

Entries carry `cloud.provider`, `cloud.account.id` (the project ID), `cloud.region`, the resource's labels as `gcp.resource.labels.*`, and the Kubernetes, Cloud Run or Compute Engine attributes of their resource. Fields with an OpenTelemetry convention take its name (`httpRequest` becomes `http.request.method`, `url.full`, `http.response.status_code` and so on); the rest keep their Cloud Logging names under `gcp.`. An entry's `trace` and `spanId` become the log's trace and span IDs. Entries in a log named `maple-setup` are setup reports: Maple reads them and doesn't store them, so don't log under that name.

### Metrics

One-minute resolution, named like OpenTelemetry metrics under `gcp.`:

| Service                              | Metrics                                                                                                                                                                                                     |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloud Run, Cloud Functions (2nd gen) | `gcp.cloud_run.requests`, `.request.duration`, `.container.instance.count`, `.container.cpu.utilization`, `.container.memory.utilization`, `.container.request.max_concurrency`, `.container.billable_time` |
| Cloud Functions (1st gen)            | `gcp.cloud_functions.executions`, `.execution.duration`, `.instance.count`, `.memory.usage`, `.network.io`                                                                                                  |
| GKE                                  | `gcp.gke.container.cpu.time`, `.cpu.limit.utilization`, `.memory.usage`, `.memory.limit.utilization`, `.restarts`, `gcp.gke.node.cpu.allocatable.utilization`, `.memory.allocatable.utilization`            |
| Compute Engine                       | `gcp.gce.cpu.utilization`, `.memory.usage` (E2 machine types only), `.network.io`, `.disk.io`                                                                                                               |
| Cloud SQL                            | `gcp.cloud_sql.cpu.utilization`, `.memory.utilization`, `.disk.utilization`, `.connection.count`, `.disk.operations`, `.replication.lag`                                                                    |
| Pub/Sub                              | `gcp.pubsub.subscription.undelivered_messages`, `.oldest_unacked_message.age`, `.sent_messages`, `.acked_messages`, `.push_requests`, `.dead_lettered_messages`, `gcp.pubsub.topic.publish_requests`        |
| Load balancers                       | `gcp.load_balancing.requests`, `.request.duration`, `.backend.requests`, `.backend.request.duration`, `.network.io`                                                                                         |

- Counters are delta sums per minute: chart them with `sum`, not `rate`.
- Distributions, such as latency, are gauges with a `quantile` attribute (`0.5`, `0.95`, `0.99`).
- Utilization is a fraction from 0 to 1; durations are in seconds.
- Service names follow the same rule as logs. Every series carries `cloud.account.id` and `cloud.region`; Google aggregates away most other labels before Maple reads them.

### Resources

Every hour Maple lists projects, Cloud Run services and jobs, Cloud Functions, GKE clusters, Compute Engine instances, Cloud SQL instances, Pub/Sub topics and subscriptions, and load balancers from Cloud Asset Inventory, with their location, state and labels.

## Infrastructure → Google Cloud

While a connection has **Metrics and resources** on, **Infrastructure → Google Cloud** shows one tab per service with a row per workload, a band that counts saturated, elevated and erroring workloads, and a **Resources** tab with the inventory. Each workload opens a page with its charts and links to its logs, its traces and the Google Cloud console.

## What Maple can access

The script, the console steps and the generated files grant the same roles. Maple reads as a read-only service account through short-lived tokens; no key is created.

- **Monitoring Viewer** and **Cloud Asset Viewer** on the project, folder or organization: reading metrics and listing resources. Both are read-only; Cloud Asset Viewer can also read resource metadata and IAM policies.
- **Service Usage Consumer** on the host project: calling both APIs through it.
- **Service Account Token Creator** for Maple's service account, on the read-only account only.
- **Pub/Sub Publisher** on Maple's topic for the sink's Google-managed writer identity.

## Google Cloud costs

Google bills Pub/Sub for the log entries that pass through the topic and subscription (a narrower filter lowers it), and Cloud Monitoring reads to the host project: each connection runs 46 `timeSeries.list` queries every 5 minutes, growing with the number of time series. Cloud Asset Inventory searches are free. See [Pub/Sub pricing](https://cloud.google.com/pubsub/pricing) and [Google Cloud Observability pricing](https://cloud.google.com/stackdriver/pricing).

## Limits

- Pub/Sub delivers each log entry at least once; a redelivered entry is stored again (its `insertId` is in `log.record.uid`). Entries Maple could not accept within a day are lost.
- Connecting an organization and a folder or project inside it collects that part twice.
- One read takes up to about 4,000 series per metric. For a large folder or organization, connect its folders or projects separately.
- The first read, and the first after a pause, covers at most the last hour.
- Maple reads up to 10 connections of one Maple organization every 5 minutes; more take turns.
- The resource list holds up to 10,000 resources per connection.
- Load balancer metrics cover global external Application Load Balancers only.

## Troubleshooting

The connection's band names the problem and the fix; when it asks for another setup run, its button **Set up again** opens the dialog at **Method**. For the script, read its last lines in Cloud Shell. A few cases need more:

| You see                                                  | Do                                                                                                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Waiting for the first entry** for more than 20 minutes | Run the `gcloud logging write` command the band shows. If the entry doesn't arrive within a minute, set the connection up again.                        |
| A workload's logs appear twice                           | Its application output is forwarded and it also sends logs over OpenTelemetry. Untick its runtime under [Log filter](#log-filter) and apply the change. |
| A workload's stdout and stderr are missing               | Application output isn't forwarded by default. Send it over OpenTelemetry, or tick its runtime under **Log filter**.                                    |
| A wrong project, folder or organization ID               | A connection's ID can't be changed: disconnect it and connect the right one.                                                                            |

On a self-hosted Maple, **Metrics and resources** reads **Not available on this Maple deployment** until `MAPLE_GCP_SERVICE_ACCOUNT_EMAIL` names a Google service account the deployment owns. Reading metrics also needs `MAPLE_GCP_SERVICE_ACCOUNT_KEY`, that account's key file, base64-encoded.

### Domain restricted sharing

An organization policy can restrict which identities may hold IAM roles in your organization (`constraints/iam.allowedPolicyMemberDomains`, or a custom constraint on member domains). Maple's service account lives outside your organization, so such a policy rejects the grant that lets Maple read as your read-only service account. The script stops with "An organization policy (domain restricted sharing) blocks granting Maple's service account"; the console refuses the grant.

Don't turn the policy off. An Organization Policy Administrator can allow Maple's one service account on the host project, and nothing else:

1. Use the managed constraint **Restrict allowed policy members in IAM allow policies** (`iam.managed.allowedPolicyMembers`). The older `iam.allowedPolicyMemberDomains` can't make an exception for a single principal.
2. On the host project, set a policy whose allowed principals are your organization's principal set plus Maple's service account. Google's steps: [Restrict identities with domain-restricted sharing](https://cloud.google.com/resource-manager/docs/organization-policy/restricting-domains).
3. Make the grant again. Leave the exception in place: Google checks it at every grant.

## Disconnect

Open the **⋮** menu on the connection's row and choose **Disconnect**. Remove Maple's resources from Google Cloud first:

- **Set up by script**: run the cleanup script the dialog shows. Maple sees it finish.
- **Set up in the console**: delete them in the order the dialog lists. See [Removing](/docs/integrations/gcp-manual-setup#removing).
- **Set up with Terraform or Alchemy**: destroy it there. See [Change or remove](/docs/integrations/gcp-infrastructure-as-code#change-or-remove).

Then click **Disconnect**. Maple stops reading the connection's metrics and accepting its logs; data already in Maple is kept. Disconnecting first leaves Google Cloud publishing logs to Pub/Sub, billed by Google, and Maple keeps the cleanup script on the page until you dismiss it.

## Next steps

- [Google Cloud with OpenTelemetry](/docs/integrations/gcp-opentelemetry): what to instrument on GKE, Cloud Run and Compute Engine.
- [Dashboards](/docs/dashboards/build-dashboards#templates): start from the **Google Cloud** template.
- [Alert rules](/docs/alerting/alert-rules): alert on any `gcp.*` metric.
- [API reference](/docs/reference/api): manage connections with the `/v2/integrations/gcp` endpoints.
