---
title: "Google Cloud"
description: "Connect a Google Cloud organization, folder or project by running one script in Cloud Shell. Maple receives Cloud Logging entries through Pub/Sub and reads Cloud Monitoring metrics every 5 minutes."
group: "Integrations"
order: 7
---

The Google Cloud integration connects an organization, a folder or a single project to Maple. You choose what each connection collects:

| What to collect           | Collects                                                                                                                                                                                                                                                                       |
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

1. Open **Integrations → Google Cloud** in Maple and click **Connect Google Cloud**. When the page already has a connection, click **Add connection** above the list. The dialog **Connect Google Cloud** opens on its first stage, **Connect**.
2. Under **What to connect**, choose **Organization**, **Folder** or **Project** and enter its ID. An organization or folder covers every project in it, including new ones.
3. For an organization or folder, enter the **Host project ID**.
4. Under **Collect**, leave **Log forwarding** and **Metrics and resources** ticked, or untick one. To change which logs are forwarded, choose a [log filter](#log-filter) under **Log filter**.
5. Click **Create and continue**. Maple creates the connection and the dialog moves to its second stage, **Apply in Google Cloud**. Nothing changes in Google Cloud until you run the script.
6. In step 1, click **Open Cloud Shell** and sign in with the roles above. Click **Authorize** if Cloud Shell asks.
7. In step 2, click **Copy script**, paste it into Cloud Shell and press Enter. The script takes about a minute. **Read the script** shows it in the dialog.
8. Return to Maple. Step 3, **Maple is waiting for the run**, updates on its own. Within a minute of the script ending, usually in seconds, the dialog shows **Google Cloud matches this configuration**. Click **Done**.

If you close the dialog before the script has run, the connection's row shows **Setup pending**. Click **Finish setup** to open the dialog at the script. After five minutes without a report from the script, step 3 reads **Maple has no confirmation yet** and lists what to check.

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
| "Done. Google Cloud matches your Maple switches."                                | Removed what **Log forwarding** or **Metrics and resources**, now off, had set up.                 |

After Maple confirms the run, **Log forwarding** and **Metrics and resources** each wait for their first data:

| What to collect       | First data                                                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Log forwarding        | A new sink can take about 10 minutes to start forwarding. Entries logged before that are not forwarded.                             |
| Metrics and resources | The first read lands within about 10 minutes. Maple reads every 5 minutes, about 5 minutes behind, so that each minute is complete. |

The script contains a secret that lets anyone send logs to your Maple organization. Don't share it or commit it, and run it in Cloud Shell: there neither the paste nor the secret ends up in shell history. The pasted text keeps itself out of the history files of bash 5 and zsh, but it still shows in your terminal's scrollback.

The push endpoint with the secret is also visible in the subscription's configuration and in the host project's Admin Activity audit log, to anyone who can read those. If it leaks, disconnect and connect again: the new connection gets a new secret.

The first two lines and the last two lines of the pasted text run the script in a bash process of its own, so a failed step can't close your Cloud Shell session.

A project, folder or organization can be connected once per Maple organization. A project that sits inside a connected organization or folder is collected twice if you also connect it on its own.

### Change what a connection collects

1. On the connection's row, click **Configure**. The dialog opens on its first stage, **Configure**.
2. Under **Collect**, tick or untick **Log forwarding** or **Metrics and resources**. The line beside a changed checkbox says what saving it does.
3. Click **Save and continue**. For a change that takes effect in Maple at once, Maple asks first, in a dialog titled for example "Turn log forwarding off for Project acme-prod?". The dialog says what happens **In Maple** and what goes on **In Google Cloud**. Click **Turn off and continue**, or **Turn on** when you turn something back on that still exists in Google Cloud. Then the button of the first stage reads **Save**, and there is nothing to run.
4. The dialog moves to **Apply in Google Cloud**. Its recap says what is saved and what this run does. Copy the script and run it in Cloud Shell again.
5. When the run reports, the dialog shows **Google Cloud matches this configuration**. Click **Done**.

A change takes effect in Maple and in Google Cloud at different times:

| Change in **Configure**                                                  | In Maple                                                                                                       | In Google Cloud                                                                                             |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Log forwarding** off                                                   | Maple stops storing the connection's logs within about a minute of saving.                                     | Google Cloud keeps publishing logs to Pub/Sub, billed by Google, until the script has removed the log sink. |
| **Metrics and resources** off                                            | Maple stops reading from the next 5-minute read.                                                               | The read-only service account and its roles stay until the script has removed them.                         |
| **Log forwarding** or **Metrics and resources** on                       | Starts once the script has run.                                                                                | The script creates the log sink, or the read-only service account.                                          |
| Back on while Google Cloud still has the log sink or the service account | At once: Maple stores the logs again as soon as you save, and reads metrics again from the next 5-minute read. | Nothing changes.                                                                                            |

Until the script has run, the connection's row shows **Changes not applied in Google Cloud** and says what goes on until then, for example "Google Cloud keeps forwarding logs, billed by Google, until the script has removed the log sink." Click **Apply changes** to open the dialog at the script.

A run that removes the log sink takes one to two minutes: after it deletes the sink it waits a minute for Google to stop routing to the topic, so your project logs no sink error.

When nothing is changed, the button in the first stage reads **Continue to the script**. The setup script exists only in the second stage of this dialog, so this is how you get it again, for example to change the [log filter](#log-filter) or to repair something. **Back** returns to the first stage.

A connection collects at least one of the two: the last one that is on can't be unticked. To stop collecting, [disconnect](#disconnect).

### Log filter

**Log filter** decides which filter the script writes onto the sink. It is in the first stage of **Connect Google Cloud** and of **Configure**, below **Collect**, while **Log forwarding** is ticked.

Platform, request and audit logs are always forwarded. Application output, what the code of a runtime writes to stdout and stderr, is not: send it with your [OpenTelemetry setup](/docs/integrations/gcp-opentelemetry), where each line links to its trace.

For workloads that can't send logs over OpenTelemetry, click **Can't forward via OpenTelemetry** and tick the runtimes whose application output to forward. None is ticked until you do. **Use OpenTelemetry instead** closes the ticks and forwards none again.

| Runtime             | Covers                                              |
| ------------------- | --------------------------------------------------- |
| **Cloud Run**       | Services, jobs, worker pools and 2nd gen functions. |
| **Cloud Functions** | 1st gen functions.                                  |
| **App Engine**      | Standard and flexible.                              |
| **GKE containers**  | Every container of a cluster.                       |

Don't tick a runtime whose workloads already send their logs to Maple over OpenTelemetry. Otherwise each line is stored twice: see [Application output](/docs/integrations/gcp-opentelemetry#application-output). Maple does not check which workloads do.

On a connection that already has a sink, the choice starts on **Keep current filter**: the script leaves the sink's filter as it is. Maple can't see that filter, so **Current filter in Log Router** opens it in the console. To change it, click **Configure**, choose **Replace filter**, set the runtimes, click **Continue to the script** and run the script again.

For any other filter, paste the script into an editor first, edit `LOG_FILTER` near its top and set `LOG_FILTER_MODE` to `set`. The filter uses the [Logging query language](https://cloud.google.com/logging/docs/view/logging-query-language). The script checks the filter with Google before it creates anything. Later runs with **Keep current filter** leave your filter in place, while **Replace filter** replaces it.

## Verify

Once a connection has delivered data, **Integrations → Google Cloud** opens with a row of numbers, summed over every connection:

| Number                | Counts                                                                  |
| --------------------- | ----------------------------------------------------------------------- |
| **Log entries · 24h** | Entries forwarded in the last 24 hours, with a bar per hour.            |
| **Errors · 24h**      | The entries among them of severity error and above.                     |
| **Workloads · 24h**   | Workloads that reported metrics in the last 24 hours.                   |
| **Resources**         | Resources in the [inventory](#resources), and the projects they are in. |

The row follows what has delivered. While only **Log forwarding** delivers, it shows **Log entries**, **Errors** and **Warnings**. While only **Metrics and resources** delivers, it shows **Workloads**, **Resources** and **Projects**. A number Maple cannot count yet shows a dash. Below the numbers, **Workloads** lists what reported metrics in the last 24 hours, the worst first, each a link to its page under **Infrastructure → Google Cloud**. Beside it, **Resources** counts the [inventory](#resources) by type.

Under **Connections**, each connection is a row, the worst state first, with a status for **Logs** and one for **Metrics**. A hint, a warning or a failure shows in a band under the row. The page updates on its own.

| Logs                            | Meaning                                                                                                                                                                 |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Not set up**                  | The setup script has not set log forwarding up yet. Run it.                                                                                                             |
| **Setup running**               | A run reported on metrics and resources in the last two minutes and has not reported on log forwarding yet.                                                             |
| **Waiting for the first entry** | The script ran and no entry has arrived. After 20 minutes the band reads **No log entry in 20 minutes** with a `gcloud logging write` command that writes a test entry. |
| **Receiving**                   | Entries arrive. The row shows when the last one did.                                                                                                                    |
| **Nothing in 24 hours**         | Nothing passed the filter for a day. Not an error.                                                                                                                      |
| **Rejected**                    | Maple refused the last push. The band says why and what to do.                                                                                                          |
| **Off**                         | Turned off in **Configure**. While Google Cloud still has the log sink, the band **Changes not applied in Google Cloud** says so.                                       |

| Metrics                        | Meaning                                                                                                                                                  |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Not set up**                 | The setup script has not granted Maple read access yet. Run it.                                                                                          |
| **Setup running**              | A run reported on log forwarding in the last two minutes and has not reported on metrics and resources yet.                                              |
| **Waiting for the first read** | The script ran and the first read has not landed. After 15 minutes the band says that no metrics have arrived yet.                                       |
| **Receiving**                  | Reads succeed. The row shows when the last one landed. The label reads **Receiving, resource list incomplete** when Maple could not list every resource. |
| **Incomplete**                 | The last read is under 10 minutes old, but some metric queries failed or were cut short. The band says which.                                            |
| **Stalled**                    | No read for 30 minutes and no error. Maple retries every 5 minutes.                                                                                      |
| **Can't be read**              | Reads fail, and none has succeeded in the last 10 minutes. The band says why and what to do.                                                             |
| **Off**                        | Turned off in **Configure**. While the read-only service account still exists, the band **Changes not applied in Google Cloud** says so.                 |

The page header and the Integrations list show the connection's worst status: **Needs attention**, **Setup pending**, **Changes pending**, **Waiting for data** or **Healthy**.

A connection that needs the setup script shows a band with one button. The button opens **Configure** at its second stage, **Apply in Google Cloud**.

| Band                                    | Button                   | Shown when                                                                                                             |
| --------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| **Setup pending**                       | **Finish setup**         | The script of a new connection has not reported, or its last run stopped part of the way.                              |
| **Changes not applied in Google Cloud** | **Apply changes**        | The saved configuration and what the script last reported differ. The band says what goes on until the script has run. |
| A failure's own message                 | **Run the script again** | The text of the failure asks for another run of the setup script.                                                      |

Members who are not admins of the Maple organization see the statuses and the numbers, without **Configure**, the **⋮** menu or the band's button. The band asks them to have an admin run the setup script, and a line under the list says "Only Maple organization admins can add, configure or disconnect connections."

Then check the data:

1. Open [Logs](/docs/explore/logs) and look for a service named after one of your Cloud Run services, functions or instances.
2. In the [metrics explorer](/docs/explore/metrics), search for the prefix `gcp`.
3. Under **Dashboards → Browse templates**, select **Google Cloud** and click **Create dashboard**. It has one tab per service. Use the **Project**, **Region** and **Workload** filters in the toolbar to narrow every chart. To open it on one project, first fill in **Project ID** under **Parameters**, below the preview.
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

Maple receives every entry the sink's filter lets through. The default filter excludes:

| Excluded                                | Reason                                                                                                                                                                                         |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data Access audit logs                  | They record every API read.                                                                                                                                                                    |
| Load balancer health checks             | Probes hit each backend every few seconds.                                                                                                                                                     |
| Kubernetes lease renewals               | A GKE cluster renews its leader-election leases all day: hundreds of audit entries a minute for an idle node.                                                                                  |
| VM serial console output                | A VM writes thousands of lines of raw terminal output at boot.                                                                                                                                 |
| Application output of unticked runtimes | By default every runtime: workloads send their logs over OpenTelemetry, so each line would be stored twice. See [Application output](/docs/integrations/gcp-opentelemetry#application-output). |

The filter, one clause per line in the same order:

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

The last four clauses are the application output of each runtime: ticking one under [Log filter](#log-filter) removes its clause.

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

Every entry also carries `cloud.provider` (`gcp`), `gcp.resource.type` and the resource's labels as `gcp.resource.labels.*`, plus `cloud.account.id` (the project ID) and `cloud.region` when the resource has them. GKE container entries add `k8s.cluster.name`, `k8s.namespace.name`, `k8s.pod.name` and `k8s.container.name`. Cloud Run service entries add `faas.name`, `faas.version` (the revision) and `faas.instance`, Cloud Run job entries `gcp.cloud_run.job.execution` and `gcp.cloud_run.job.task_index`, and Compute Engine entries `host.id`, `host.name` and `gcp.gce.instance.name`.

The log body is `textPayload`, or the `message` or `msg` field of `jsonPayload`, or the whole `jsonPayload` as JSON when it has neither. The other `jsonPayload` fields become log attributes. Audit logs use the method name as the body, and request logs the method, URL and status. An entry's `trace` and `spanId` become the log's trace and span IDs.

Entry fields that have an OpenTelemetry semantic convention take its name and type:

| Cloud Logging field                                      | Attribute                                                                                                                                                                                           |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `httpRequest`                                            | `http.request.method`, `url.full`, `http.response.status_code`, `http.request.size`, `http.response.size`, `user_agent.original`, `client.address`, `server.address`, `http.request.header.referer` |
| `sourceLocation`                                         | `code.file.path`, `code.line.number`, `code.function.name`                                                                                                                                          |
| `insertId`                                               | `log.record.uid`                                                                                                                                                                                    |
| Audit `authenticationInfo.principalEmail`, `status.code` | `user.email`, `rpc.response.status_code` (the code name, for example `PERMISSION_DENIED`)                                                                                                           |

Other fields keep their Cloud Logging names under `gcp.`: `gcp.log_name`, `gcp.labels.*`, `gcp.http_request.*` (for example `latency`), `gcp.source_location.*` and `gcp.audit.*`.

| Cloud Logging severity           | Maple severity |
| -------------------------------- | -------------- |
| `DEBUG`                          | `DEBUG`        |
| `INFO`, `NOTICE`                 | `INFO`         |
| `WARNING`                        | `WARN`         |
| `ERROR`                          | `ERROR`        |
| `CRITICAL`, `ALERT`, `EMERGENCY` | `FATAL`        |
| `DEFAULT`                        | Not set        |

### Metrics

Maple stores these Cloud Monitoring metrics at one-minute resolution, under the `gcp.` namespace and named the way OpenTelemetry semantic conventions name metrics. Two Cloud Monitoring types that measure the same thing share a name: the byte and operation counters are split by a direction attribute, shown in brackets, and Cloud SQL reports connections from whichever of the two types its engine has.

| Service                              | Metric                                               | Cloud Monitoring type                                                             | Kind         | Unit           |
| ------------------------------------ | ---------------------------------------------------- | --------------------------------------------------------------------------------- | ------------ | -------------- |
| Cloud Run, Cloud Functions (2nd gen) | `gcp.cloud_run.requests`                             | `run.googleapis.com/request_count`                                                | Counter      | `{request}`    |
| Cloud Run, Cloud Functions (2nd gen) | `gcp.cloud_run.request.duration`                     | `run.googleapis.com/request_latencies`                                            | Distribution | `s`            |
| Cloud Run, Cloud Functions (2nd gen) | `gcp.cloud_run.container.instance.count`             | `run.googleapis.com/container/instance_count`                                     | Gauge        | `{instance}`   |
| Cloud Run, Cloud Functions (2nd gen) | `gcp.cloud_run.container.cpu.utilization`            | `run.googleapis.com/container/cpu/utilizations`                                   | Distribution | `1`            |
| Cloud Run, Cloud Functions (2nd gen) | `gcp.cloud_run.container.memory.utilization`         | `run.googleapis.com/container/memory/utilizations`                                | Distribution | `1`            |
| Cloud Run, Cloud Functions (2nd gen) | `gcp.cloud_run.container.request.max_concurrency`    | `run.googleapis.com/container/max_request_concurrencies`                          | Distribution | `{request}`    |
| Cloud Run, Cloud Functions (2nd gen) | `gcp.cloud_run.container.billable_time`              | `run.googleapis.com/container/billable_instance_time`                             | Counter      | `s`            |
| Cloud Functions (1st gen)            | `gcp.cloud_functions.executions`                     | `cloudfunctions.googleapis.com/function/execution_count`                          | Counter      | `{execution}`  |
| Cloud Functions (1st gen)            | `gcp.cloud_functions.execution.duration`             | `cloudfunctions.googleapis.com/function/execution_times`                          | Distribution | `s`            |
| Cloud Functions (1st gen)            | `gcp.cloud_functions.instance.count`                 | `cloudfunctions.googleapis.com/function/instance_count`                           | Gauge        | `{instance}`   |
| Cloud Functions (1st gen)            | `gcp.cloud_functions.memory.usage`                   | `cloudfunctions.googleapis.com/function/user_memory_bytes`                        | Distribution | `By`           |
| Cloud Functions (1st gen)            | `gcp.cloud_functions.network.io` (`transmit`)        | `cloudfunctions.googleapis.com/function/network_egress`                           | Counter      | `By`           |
| GKE containers                       | `gcp.gke.container.cpu.time`                         | `kubernetes.io/container/cpu/core_usage_time`                                     | Counter      | `s`            |
| GKE containers                       | `gcp.gke.container.cpu.limit.utilization`            | `kubernetes.io/container/cpu/limit_utilization`                                   | Gauge        | `1`            |
| GKE containers                       | `gcp.gke.container.memory.usage`                     | `kubernetes.io/container/memory/used_bytes`                                       | Gauge        | `By`           |
| GKE containers                       | `gcp.gke.container.memory.limit.utilization`         | `kubernetes.io/container/memory/limit_utilization`                                | Gauge        | `1`            |
| GKE containers                       | `gcp.gke.container.restarts`                         | `kubernetes.io/container/restart_count`                                           | Counter      | `{restart}`    |
| GKE nodes                            | `gcp.gke.node.cpu.allocatable.utilization`           | `kubernetes.io/node/cpu/allocatable_utilization`                                  | Gauge        | `1`            |
| GKE nodes                            | `gcp.gke.node.memory.allocatable.utilization`        | `kubernetes.io/node/memory/allocatable_utilization`                               | Gauge        | `1`            |
| Compute Engine                       | `gcp.gce.cpu.utilization`                            | `compute.googleapis.com/instance/cpu/utilization`                                 | Gauge        | `1`            |
| Compute Engine                       | `gcp.gce.memory.usage`                               | `compute.googleapis.com/instance/memory/balloon/ram_used` (E2 machine types only) | Gauge        | `By`           |
| Compute Engine                       | `gcp.gce.network.io` (`receive`)                     | `compute.googleapis.com/instance/network/received_bytes_count`                    | Counter      | `By`           |
| Compute Engine                       | `gcp.gce.network.io` (`transmit`)                    | `compute.googleapis.com/instance/network/sent_bytes_count`                        | Counter      | `By`           |
| Compute Engine                       | `gcp.gce.disk.io` (`read`)                           | `compute.googleapis.com/instance/disk/read_bytes_count`                           | Counter      | `By`           |
| Compute Engine                       | `gcp.gce.disk.io` (`write`)                          | `compute.googleapis.com/instance/disk/write_bytes_count`                          | Counter      | `By`           |
| Cloud SQL                            | `gcp.cloud_sql.cpu.utilization`                      | `cloudsql.googleapis.com/database/cpu/utilization`                                | Gauge        | `1`            |
| Cloud SQL                            | `gcp.cloud_sql.memory.utilization`                   | `cloudsql.googleapis.com/database/memory/utilization`                             | Gauge        | `1`            |
| Cloud SQL                            | `gcp.cloud_sql.disk.utilization`                     | `cloudsql.googleapis.com/database/disk/utilization`                               | Gauge        | `1`            |
| Cloud SQL                            | `gcp.cloud_sql.connection.count`                     | `cloudsql.googleapis.com/database/network/connections` (MySQL, SQL Server)        | Gauge        | `{connection}` |
| Cloud SQL                            | `gcp.cloud_sql.connection.count`                     | `cloudsql.googleapis.com/database/postgresql/num_backends` (PostgreSQL)           | Gauge        | `{connection}` |
| Cloud SQL                            | `gcp.cloud_sql.disk.operations` (`read`)             | `cloudsql.googleapis.com/database/disk/read_ops_count`                            | Counter      | `{operation}`  |
| Cloud SQL                            | `gcp.cloud_sql.disk.operations` (`write`)            | `cloudsql.googleapis.com/database/disk/write_ops_count`                           | Counter      | `{operation}`  |
| Cloud SQL                            | `gcp.cloud_sql.replication.lag`                      | `cloudsql.googleapis.com/database/replication/replica_lag`                        | Gauge        | `s`            |
| Pub/Sub subscriptions                | `gcp.pubsub.subscription.undelivered_messages`       | `pubsub.googleapis.com/subscription/num_undelivered_messages`                     | Gauge        | `{message}`    |
| Pub/Sub subscriptions                | `gcp.pubsub.subscription.oldest_unacked_message.age` | `pubsub.googleapis.com/subscription/oldest_unacked_message_age`                   | Gauge        | `s`            |
| Pub/Sub subscriptions                | `gcp.pubsub.subscription.sent_messages`              | `pubsub.googleapis.com/subscription/sent_message_count`                           | Counter      | `{message}`    |
| Pub/Sub subscriptions                | `gcp.pubsub.subscription.acked_messages`             | `pubsub.googleapis.com/subscription/ack_message_count`                            | Counter      | `{message}`    |
| Pub/Sub subscriptions                | `gcp.pubsub.subscription.push_requests`              | `pubsub.googleapis.com/subscription/push_request_count`                           | Counter      | `{request}`    |
| Pub/Sub subscriptions                | `gcp.pubsub.subscription.dead_lettered_messages`     | `pubsub.googleapis.com/subscription/dead_letter_message_count`                    | Counter      | `{message}`    |
| Pub/Sub topics                       | `gcp.pubsub.topic.publish_requests`                  | `pubsub.googleapis.com/topic/send_request_count`                                  | Counter      | `{request}`    |
| Load balancers                       | `gcp.load_balancing.requests`                        | `loadbalancing.googleapis.com/https/request_count`                                | Counter      | `{request}`    |
| Load balancers                       | `gcp.load_balancing.request.duration`                | `loadbalancing.googleapis.com/https/total_latencies`                              | Distribution | `s`            |
| Load balancers                       | `gcp.load_balancing.backend.request.duration`        | `loadbalancing.googleapis.com/https/backend_latencies`                            | Distribution | `s`            |
| Load balancers                       | `gcp.load_balancing.backend.requests`                | `loadbalancing.googleapis.com/https/backend_request_count`                        | Counter      | `{request}`    |
| Load balancers                       | `gcp.load_balancing.network.io` (`receive`)          | `loadbalancing.googleapis.com/https/request_bytes_count`                          | Counter      | `By`           |
| Load balancers                       | `gcp.load_balancing.network.io` (`transmit`)         | `loadbalancing.googleapis.com/https/response_bytes_count`                         | Counter      | `By`           |

Value conventions:

- Counters are delta sums per minute. Chart them with `sum`, not `rate`.
- Distributions are gauges with a `quantile` attribute (`0.5`, `0.95`, `0.99`).
- Utilization is a fraction from 0 to 1.
- Durations, such as latency, execution time, message age and replica lag, are in seconds.

Service names follow the same rule as logs: Cloud Run services, functions, GKE containers and Compute Engine instances use the workload name, and everything else is `gcp/<resource type>`. Narrow further by resource attribute:

| Service        | Resource attributes                                                           |
| -------------- | ----------------------------------------------------------------------------- |
| GKE containers | `k8s.cluster.name`, `k8s.namespace.name`, `k8s.container.name`                |
| GKE nodes      | `k8s.cluster.name`                                                            |
| Compute Engine | `gcp.gce.instance.name`, `host.name`, `host.id`                               |
| Cloud SQL      | `gcp.resource.labels.database_id`                                             |
| Pub/Sub        | `gcp.resource.labels.subscription_id`, `gcp.resource.labels.topic_id`         |
| Load balancers | `gcp.resource.labels.url_map_name`, `gcp.resource.labels.backend_target_name` |

Every series also carries `cloud.account.id` (the project ID) and, for resources with a location, `cloud.region`. Google aggregates away every other label, such as revision, pod, response code and device, before the data reaches Maple. These attributes are kept, Cloud Monitoring metric labels under `gcp.metric.labels.`:

| Attribute                               | On                                                                                             |
| --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `gcp.metric.labels.response_code_class` | `gcp.cloud_run.requests`, `gcp.load_balancing.requests`, `gcp.load_balancing.backend.requests` |
| `gcp.metric.labels.state`               | `gcp.cloud_run.container.instance.count`, `gcp.cloud_functions.instance.count`                 |
| `gcp.metric.labels.status`              | `gcp.cloud_functions.executions`                                                               |
| `gcp.metric.labels.memory_type`         | The GKE memory metrics                                                                         |
| `gcp.metric.labels.response_class`      | `gcp.pubsub.subscription.push_requests`, `gcp.pubsub.topic.publish_requests`                   |
| `network.io.direction`                  | The `network.io` metrics: `receive` or `transmit`                                              |
| `disk.io.direction`                     | `gcp.gce.disk.io`, `gcp.cloud_sql.disk.operations`: `read` or `write`                          |

### Resources

Every hour Maple lists these resources from Cloud Asset Inventory, with their project, location, state and labels: projects, Cloud Run services and jobs, Cloud Functions, GKE clusters, Compute Engine instances, Cloud SQL instances, Pub/Sub topics and subscriptions, and load balancer URL maps, backend services and forwarding rules.

## Infrastructure → Google Cloud

**Infrastructure → Google Cloud** is in the sidebar and on the Infrastructure overview while a connection has **Metrics and resources** on.

The page opens with a band that counts the workloads of every service by health, then one tab per service that reported metrics in the selected time range, with one row per workload. The tab you are on stays when you change the range. Counts and byte totals cover the time range; everything else is the average over it.

| Band cell | Workloads it counts                                                                     |
| --------- | --------------------------------------------------------------------------------------- |
| Saturated | Using 90% or more of a CPU, memory or disk limit, on average over the time range        |
| Elevated  | Using 60% or more of one                                                                |
| Erroring  | Failing 1% or more of at least 100 requests, executions or push deliveries in the range |

Click a cell to narrow every service tab to those workloads, and click it again to clear it. While a cell is active each tab shows how many of its workloads it holds.

| Tab             | One row per                               | Columns                                                                                                |
| --------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Cloud Run       | Service, project and region               | Requests, 5xx rate, latency p95 and p99, active instances, CPU p95, memory p95                         |
| Cloud Functions | 1st gen function, project and region      | Executions, error rate, duration p95 and p99, active instances, memory p95                             |
| GKE             | Container name, namespace and cluster     | CPU cores, CPU of limit, memory, memory of limit, restarts                                             |
| Compute Engine  | Instance, project and zone                | CPU, memory (E2 machine types only), network in and out, disk read and write                           |
| Cloud SQL       | Instance, project and region              | CPU, memory, disk, connections, replica lag                                                            |
| Pub/Sub         | Subscription and project                  | Backlog, age of the oldest unacknowledged message, delivered, acknowledged, dead-lettered, push errors |
| Load Balancing  | URL map, backend and project              | Requests, 5xx rate, latency p95 and p99, backend latency p95, bytes sent                               |
| Resources       | Resource from the [inventory](#resources) | Type, project, location, state and labels, with a filter by type and by project                        |

Search a tab by name, project or location, filter every service tab by project and region, and click a column to sort by it. The search, the filters and the band cell are part of the page's address, so a link opens the same view. A dash means the workload did not report that metric. CPU below one core is written in millicores: `250m` is a quarter of a core. Cloud Functions (2nd gen) run on Cloud Run and appear on the Cloud Run tab. Pub/Sub topic metrics are collected but have no tab: chart them in a dashboard.

### Workload pages

Click a row to open that workload: its headline numbers, each marked as a total or an average over the time range, then its charts.

| Service         | Charts                                                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloud Run       | Requests by response class, 5xx rate, request latency, active and idle instances, CPU and memory utilization, peak concurrent requests per instance, billable instances   |
| Cloud Functions | Executions by status, error rate, execution time, active and idle instances, memory per execution, network egress                                                         |
| GKE             | CPU cores, CPU of limit, memory, memory of limit and restarts of the container, then CPU and memory of allocatable for the nodes of its cluster                           |
| Compute Engine  | CPU utilization, memory used (E2 machine types only), network received and sent, disk read and written                                                                    |
| Cloud SQL       | CPU, memory and disk utilization, connections, disk read and write operations, replica lag (read replicas only)                                                           |
| Pub/Sub         | Backlog, age of the oldest unacknowledged message, delivered and acknowledged messages, dead-lettered messages, push requests by response and push error rate (push only) |
| Load Balancing  | Requests by response class, 5xx rate, total latency, backend latency, backend requests by response class, request and response traffic                                    |

Latency charts draw p50, p95 and p99, and so do Cloud Run's CPU, memory and concurrency and a function's memory; every other line is the average. Requests and executions by class, traffic, messages and disk operations are per second; restarts and dead-lettered messages are counts per point. A point covers at least 5 minutes, and more on a long range. While a workload reports nothing, as a Cloud Run service scaled to zero does, its counters read zero and its other lines have a gap. A share of a limit carries a line at 80%. Hovering one chart marks the same moment on the others.

From a workload's page:

- **Logs** opens the workload's logs. A Cloud SQL instance, a subscription and a URL map open the logs of their resource type, narrowed to the resource.
- **Traces** is there when a service of the same name sent traces in the time range.
- The icon beside a chart's title opens its metric in the metrics explorer.
- When the workload is in the [inventory](#resources), its state and labels show under its name, and **Google Cloud** opens its product's list in the Google Cloud console, on the resource's project. A GKE container gets the link to its cluster's list, without state or labels. The match is by type, project, name and location: a workload Maple cannot match exactly shows neither.

### Elsewhere in Maple

- The **Infrastructure overview** row counts the workloads, colors them by health and lists up to three that are saturated, elevated or erroring. Each opens the workload's page. While every workload is healthy the row names the services that report.
- On the **service map**, the panel of a traced service shows the numbers of the Cloud Run service, function, GKE container or VM of the same name, with a link to its page.
- A row of the **Resources** tab that is one workload (a Cloud Run service, a 1st gen function, a VM, a Cloud SQL instance, a subscription) opens that workload's page.

The **Resources** tab shows the first 500 resources that match its filters, and how many projects Maple found. It does not depend on the time range.

Until a connection's setup script has run, the page reads **Finish setting up Google Cloud**. After the run it reads **Collecting your first Google Cloud metrics** until the first read lands, within about 10 minutes.

With **Metrics and resources** off on every connection, the page leaves the sidebar and the overview. Its address still opens it: for a time range with data it shows the service tabs with what Maple collected before, under the notice **Google Cloud metrics are switched off**, and otherwise it reads **Turn on metrics for Google Cloud**. The **Resources** tab is back once a connection collects again.

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

To run the setup script again, click **Configure** on the connection's row, then **Continue to the script**. When a failure asks for another run, its band has the button **Run the script again**.

### In Cloud Shell

A step that fails stops the script. It prints what went wrong, Google's answer, and a line that starts with `What to do:`. Nothing needs undoing: fix it and paste the script again. A connection's ID can't be changed, so a wrong ID is fixed by removing the connection in Maple and connecting the right ID. In the lines below, _account_ stands for the account you are signed in as.

| The script prints                                                                            | Cause and fix                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Can't open project acme-prod as _account_."                                                 | The ID is wrong, or the account has no access to the project. Check the ID with `gcloud projects list`. It is the project ID, not the name or number. If it is wrong, remove the connection and connect the right ID.                                                                                       |
| "_account_ has none of the permissions this script needs on project acme-prod."              | Check the ID in Maple first. If it is wrong, remove the connection and connect the right ID. If it is right, the account has no rights there: ask for the roles under [Prerequisites](#prerequisites), or have an administrator run the script.                                                             |
| "_account_ is missing permissions on project acme-prod:" and a list                          | The account lacks a role. The line names the permissions and the role to ask for. If the only one listed is the permission to enable services, an API the script needs is off: ask for Service Usage Admin on the host project, or have an administrator switch the named APIs on. Nothing was created yet. |
| "Project acme-prod has no billing account."                                                  | Link a billing account to the host project, then paste the script again.                                                                                                                                                                                                                                    |
| "gcloud _version_ is too old for this script."                                               | Run the script in Cloud Shell, or update gcloud (`gcloud components update`, or the package manager that installed it). Versions before 470 can't update a folder or organization sink.                                                                                                                     |
| "_account_ can't see folder 123456789012." (or organization)                                 | The ID is wrong, or the account has no rights there. Check it with `gcloud resource-manager folders list --organization=ORGANIZATION_ID` or `gcloud organizations list`.                                                                                                                                    |
| "Couldn't look for _a resource_: its API is off in project acme-prod."                       | Cleanup only. The API was switched off after a setup run, so the resource may still be there. Switch the API on and paste the cleanup script again.                                                                                                                                                         |
| "Google does not accept the log filter."                                                     | `LOG_FILTER` was edited into something Google can't parse. Correct it near the top of the script and paste it again. Nothing was created yet.                                                                                                                                                               |
| "An organization policy (domain restricted sharing) blocks granting Maple's service account" | See [Domain restricted sharing](#domain-restricted-sharing).                                                                                                                                                                                                                                                |
| "Google is still switching an API on, or the API is off."                                    | Wait a minute and paste the script again.                                                                                                                                                                                                                                                                   |
| "Google has not published the new service account yet."                                      | Wait a minute and paste the script again.                                                                                                                                                                                                                                                                   |
| "Couldn't reach Maple to confirm."                                                           | Cloud Shell could not reach Maple. Google Cloud is set up, and Maple shows **Setup pending** or **Changes pending** until a later run reaches it. Paste the script again.                                                                                                                                   |

When you create a connection in Maple, "The Google Cloud project acme-prod is already connected." means this Maple organization already has a connection for it. Click **Configure** on that connection instead.

### Log forwarding

| The connection shows                                                                       | Cause and fix                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Setup pending** after the script ran                                                     | The script stopped before it finished, or could not reach Maple. Read its last lines in Cloud Shell and paste it again.                                                                                                              |
| **Waiting for the first entry** for more than 20 minutes                                   | Either nothing was logged that passes the filter, or the sink can't publish. Run the `gcloud logging write` command the band shows. If the entry does not arrive within a minute, open **Configure** and run the setup script again. |
| **Rejected**: "The Pub/Sub subscription wraps each entry in an envelope Maple can't read." | The subscription was changed to deliver wrapped messages. Run the setup script again: it resets the subscription. Entries sent meanwhile are lost.                                                                                   |
| **Rejected**: "Maple could not store an entry just now."                                   | Nothing to do. Pub/Sub retries the entry for up to a day, and the status returns to **Receiving** with the next accepted entry.                                                                                                      |
| **Rejected**: "This Maple organization is over its plan limit, so Maple refuses new logs." | Raise the plan limit under **Settings → Billing**. Pub/Sub retries refused entries for up to a day.                                                                                                                                  |
| A workload's logs appear twice                                                             | The sink forwards its application output and the workload also sends its logs over OpenTelemetry. In **Configure**, choose **Replace filter**, leave its runtime unticked under [Log filter](#log-filter) and run the script again.  |
| A workload's stdout and stderr are missing                                                 | Application output is not forwarded by default. Send it over OpenTelemetry, or tick its runtime under [Log filter](#log-filter) in **Configure** and run the script again.                                                           |

### Metrics and resources

**Can't be read** and **Incomplete** come with one of the messages below. The first means no read has succeeded in the last 10 minutes. The second means the last read is under 10 minutes old and something is missing. The messages about the resource list show under **Receiving, resource list incomplete**. Where a project's message says "the project", a folder's or organization's says "the host project".

| The connection shows                                                                | Cause and fix                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stalled**                                                                         | No read for 30 minutes and no error. Maple retries on its own. If it stays for more than an hour, write to support.                                                                                                                                                                                |
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

On a self-hosted Maple, the **Metrics and resources** checkbox reads **Not available on this Maple deployment** until `MAPLE_GCP_SERVICE_ACCOUNT_EMAIL` names a Google service account the deployment owns. Reading metrics also needs `MAPLE_GCP_SERVICE_ACCOUNT_KEY`, that account's key file, base64-encoded.

### Domain restricted sharing

An organization policy can restrict which identities may hold IAM roles in your organization (`constraints/iam.allowedPolicyMemberDomains`, or a custom constraint on member domains). Maple's service account lives outside your organization, so such a policy can reject a grant the script makes, most often the one that lets Maple read as your read-only service account. The script then stops with "An organization policy (domain restricted sharing) blocks granting Maple's service account".

Don't turn the policy off or allow all principals for this. An Organization Policy Administrator can allow Maple's one service account on the host project, and nothing else:

1. Use the managed constraint **Restrict allowed policy members in IAM allow policies** (`iam.managed.allowedPolicyMembers`). The older `iam.allowedPolicyMemberDomains` can't make an exception for a single principal.
2. On the host project, set a policy for it whose allowed principals are your organization's principal set plus Maple's service account (`serviceAccount:` followed by the address the script's error names). Listing your organization keeps everyone in it allowed on the project. Google's steps: [Restrict identities with domain-restricted sharing](https://cloud.google.com/resource-manager/docs/organization-policy/restricting-domains).
3. Paste the setup script again. It continues where it stopped.

Google checks the policy when a grant is made, so leave the exception in place: a later re-run grants again.

## Disconnect

1. On **Integrations → Google Cloud**, open the **⋮** menu (**More actions**) on the connection's row and choose **Disconnect**.
2. Click **Copy cleanup script** and run it in Cloud Shell. It deletes the log sink, topic, subscription and read-only service account, and ends with "Done. Everything the setup script created is gone."
3. Wait for the check mark in the dialog, then click **Disconnect**. Maple stops reading the connection's metrics, and stops accepting its logs within about a minute. Data already in Maple is kept.

The cleanup takes one to two minutes when the connection forwards logs: after it deletes the sink it waits a minute for Google to stop routing to the topic, so your project logs no sink error. Turning **Log forwarding** off in **Configure** and running the setup script takes as long, for the same reason.

**Disconnect anyway** disconnects without the cleanup. Google Cloud then keeps publishing logs to Pub/Sub, billed by Google, until the cleanup script runs. Maple keeps a panel with **Copy cleanup script** on the page until you click **Dismiss** and confirm.

The cleanup script leaves the APIs it switched on enabled, and the Logs Writer role of Google's logging service account on the host project, which other sinks share.

For a connection whose setup script Maple never saw run, **Disconnect** asks once and has no cleanup step. Maple still offers the cleanup script afterwards, in case the setup script ran part of the way.

## Next steps

- [Google Cloud with OpenTelemetry](/docs/integrations/gcp-opentelemetry): what to instrument on GKE, Cloud Run and Compute Engine.
- [Logs](/docs/explore/logs): search Google Cloud logs next to your application logs.
- [Dashboards](/docs/dashboards/build-dashboards#templates): start from the **Google Cloud** template.
- **Infrastructure → Google Cloud**: scan every workload of a service in one table.
- [Alert rules](/docs/alerting/alert-rules): alert on any `gcp.*` metric.
- [API reference](/docs/reference/api): manage connections with the `/v2/integrations/gcp` endpoints.
