---
title: "Google Cloud with OpenTelemetry"
description: "Which telemetry to send from your workloads over OpenTelemetry and which to collect through the Google Cloud connection, for GKE, Cloud Run and Compute Engine."
group: "Integrations"
order: 8
---

Your workloads send traces, logs and metrics straight to Maple over OpenTelemetry. The [Google Cloud connection](/docs/integrations/gcp) forwards Cloud Logging entries and reads Cloud Monitoring metrics for everything your code never sees. Set up both, and keep container logs on the OpenTelemetry side.

| Signal    | From your workloads, over OpenTelemetry  | From the Google Cloud connection                                                                                                    |
| --------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Traces    | Every span your services create          | None                                                                                                                                |
| Logs      | Application logs, linked to their traces | Cloud Run and load balancer request logs, audit logs, managed-service logs such as Cloud SQL and Pub/Sub, GKE node and cluster logs |
| Metrics   | Application and runtime metrics          | Platform metrics from Cloud Monitoring, named `gcp.*`                                                                               |
| Resources | None                                     | The resource list: projects, services, clusters, instances and databases                                                            |

## Recommended setup

### GKE

1. Instrument each service with an OpenTelemetry SDK. Export to Maple, or to the [Maple Kubernetes collector](/docs/infrastructure/kubernetes) in the cluster.
2. [Connect Google Cloud](/docs/integrations/gcp#connect) and keep the log filter on **Recommended: without GKE container logs**.

The connection then adds node and cluster logs, audit logs and the `gcp.kubernetes.*` metrics.

### Cloud Run

1. Instrument the service with an OpenTelemetry SDK that exports to Maple.
2. [Connect Google Cloud](/docs/integrations/gcp#connect).

The connection adds Cloud Run's request logs and the `gcp.run.*` metrics. A request log carries the same trace ID as your spans when the SDK continues the incoming `traceparent` header, so it appears on the trace.

The recommended filter still forwards what a Cloud Run container writes to stdout and stderr. If the service also exports its logs over OpenTelemetry, [leave those out](#change-the-filter) too.

### Compute Engine

1. Instrument the application with an OpenTelemetry SDK that exports to Maple.
2. Run the OpenTelemetry Collector on the VM for [host metrics](/docs/infrastructure/hosts).
3. [Connect Google Cloud](/docs/integrations/gcp#connect).

The connection adds audit logs and the `gcp.compute.*` metrics.

## GKE container logs

The recommended filter leaves out `resource.type="k8s_container"`: what the containers of a GKE cluster write to stdout and stderr.

| Reason        | Detail                                                                                                                                             |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Duplicates    | An instrumented workload, or a collector that reads pod logs, already sends each line to Maple. Forwarding it from Google Cloud stores it twice.   |
| No trace link | The OpenTelemetry copy carries the trace and span ID of the request that wrote it. The copy from Google Cloud has neither.                         |
| Volume        | Container output grows with traffic. Every forwarded line counts toward your Maple plan and toward the Pub/Sub usage Google bills to your account. |

Include GKE container logs when the workloads are not instrumented and no collector reads their logs. Cloud Logging is then the only place those lines exist.

## Change the filter

On the connection, click **Show setup script**, choose a **Log filter**, then copy the script and run it in Cloud Shell again.

| Log filter                                  | The sink forwards                                                                                          |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Recommended: without GKE container logs** | Everything except the [default exclusions](/docs/integrations/gcp#logs), which include GKE container logs. |
| **Include GKE container logs**              | The same, plus GKE container logs. Maple asks you to confirm before it shows the script.                   |
| **Keep the sink's current filter**          | What it forwards now. Offered once a run has set log forwarding up.                                        |

For any other filter, paste the script into an editor, edit `LOG_FILTER` near its top, set `LOG_FILTER_MODE` to `set` and run it. To also leave out Cloud Run container output, for services that send their logs over OpenTelemetry, add this at the end of `LOG_FILTER`, inside the quotes:

```text
AND NOT log_id("run.googleapis.com/stdout") AND NOT log_id("run.googleapis.com/stderr")
```

Cloud Run's request logs are in `run.googleapis.com/requests` and still pass. The filter uses the [Logging query language](https://cloud.google.com/logging/docs/view/logging-query-language).

## Instrumentation guides

- Languages: [Node.js](/docs/guides/instrumentation-nodejs), [Next.js](/docs/guides/instrumentation-nextjs), [Python](/docs/guides/instrumentation-python), [Go](/docs/guides/instrumentation-go), [Rust](/docs/guides/instrumentation-rust), [Java](/docs/guides/instrumentation-java), [Kotlin](/docs/guides/instrumentation-kotlin), [C# / .NET](/docs/guides/instrumentation-csharp) and [Laravel](/docs/guides/instrumentation-laravel).
- [Kubernetes infrastructure](/docs/infrastructure/kubernetes): the collector that receives OTLP from in-cluster services.
- [Hosts](/docs/infrastructure/hosts): host metrics from a VM.
- [Google Cloud](/docs/integrations/gcp): connect, verify and troubleshoot the connection.
