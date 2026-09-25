---
title: "Hosts"
description: "Send host CPU, memory, disk, network and load metrics to Maple with the OpenTelemetry Collector hostmetrics receiver, and read them on the Hosts page."
group: "Infrastructure"
order: 0
---

The **Hosts** page (**Infrastructure → Hosts**) lists every machine that sends OpenTelemetry host metrics to Maple, with its CPU, memory, disk and load. Each host has a detail page with charts over time and its platform metadata.

Hosts appear from the OpenTelemetry `hostmetrics` receiver. There are two ways to run it:

- **Kubernetes.** The `maple-k8s-infra` Helm chart runs it on every node. Follow [Kubernetes Infrastructure](/docs/infrastructure/kubernetes) and your nodes appear here with no extra setup.
- **Any other Linux, macOS or Windows host.** Run the OpenTelemetry Collector with the `hostmetrics` receiver, as below.

The [Docker agent](/docs/infrastructure/docker) collects per-container metrics, not host metrics. Its containers appear under **Infrastructure → Containers**.

## Prerequisites

- The [OpenTelemetry Collector Contrib](https://github.com/open-telemetry/opentelemetry-collector-releases/releases) distribution (`otelcol-contrib`) on the host. It includes the `hostmetrics` receiver and the `resourcedetection` processor.
- A private ingest key (`maple_sk_…`) from **Settings → Ingestion**.

## Configure the Collector

Save this as `config.yaml`:

```yaml
receivers:
    hostmetrics:
        collection_interval: 30s
        scrapers:
            cpu:
                metrics:
                    system.cpu.utilization:
                        enabled: true
            load: {}
            memory:
                metrics:
                    system.memory.utilization:
                        enabled: true
            filesystem:
                metrics:
                    system.filesystem.utilization:
                        enabled: true
            network: {}

processors:
    resourcedetection:
        detectors: [env, system]
    batch: {}

exporters:
    otlphttp/maple:
        endpoint: https://ingest.maple.dev
        compression: gzip
        headers:
            x-maple-ingest-key: ${env:MAPLE_INGEST_KEY}

service:
    pipelines:
        metrics:
            receivers: [hostmetrics]
            processors: [resourcedetection, batch]
            exporters: [otlphttp/maple]
```

Then start the Collector with your key in the environment:

```bash
MAPLE_INGEST_KEY=YOUR_INGEST_KEY otelcol-contrib --config config.yaml
```

Notes on the config:

- **The three `*.utilization` metrics must be enabled.** The `hostmetrics` receiver leaves them off by default, and the Hosts page reads them for CPU, memory and disk.
- **`resourcedetection` sets `host.name`.** Maple keys each host on `host.name`. The `system` detector also sets `os.type` and `host.arch`, which the detail page shows. Add a cloud detector (`ec2`, `gcp` or `azure`) to fill in `cloud.provider` and `cloud.region`.
- **EU organizations** use `https://ingest.eu.maple.dev` as the endpoint.

If you already run a Collector on the host for application telemetry, add the `hostmetrics` receiver and a `metrics` pipeline to it instead of running a second one.

## What the Hosts page shows

| Metric                          | Where it appears                                               |
| ------------------------------- | -------------------------------------------------------------- |
| `system.cpu.utilization`        | CPU in **Usage**, **Avg CPU** card, fleet grid, CPU chart      |
| `system.memory.utilization`     | MEM in **Usage**, **Avg memory** card, fleet grid, Memory chart |
| `system.filesystem.utilization` | DSK in **Usage**, fleet grid, Filesystem chart (per mountpoint) |
| `system.cpu.load_average.15m`   | **Load 15m** column and chart                                  |
| `system.network.io`             | Network chart (per device, in and out)                         |

The list shows each host's **Status**, **Usage** (CPU, memory and disk), **Load 15m** and **Last seen**. With four or more hosts, a fleet grid shows them side by side. Filter by name, or by status:

| Status | Meaning                                             |
| ------ | --------------------------------------------------- |
| Active | Last report less than 1 minute ago.                 |
| Idle   | Last report between 1 and 5 minutes ago.            |
| Ended  | No report for 5 minutes or more.                    |

Click a host to open its detail page: **CPU**, **Memory**, **Filesystem**, **Network** and **Load 15m** charts, and the host's `host.name`, `os.type`, `host.arch`, `cloud.provider`, `cloud.region`, and first and last seen times.

## Verify

Start the Collector and open **Infrastructure → Hosts**. The host appears within about a minute, with status **Active**. CPU and memory fill in on the first report. Charts on the detail page need a few reports to draw a line.

## Troubleshooting

- **The host does not appear.** Check the Collector's output for exporter errors. A `401` means the ingest key is wrong or was rotated. Confirm `resourcedetection` is in the pipeline: without `host.name`, Maple cannot list the host.
- **The host appears but CPU, memory or disk read 0.** The matching `*.utilization` metric is not enabled in the receiver config.
- **The host shows Ended.** The Collector stopped or cannot reach Maple. Status turns **Active** again on the next report.
- **Two rows for one machine.** `host.name` changed, for example after a hostname change or a container restart. Each distinct `host.name` is its own host.

## Next steps

- [Kubernetes Infrastructure](/docs/infrastructure/kubernetes): nodes, pods and workloads.
- [Docker Infrastructure](/docs/infrastructure/docker): per-container metrics and logs.
- [Metrics](/docs/explore/metrics): query any metric, including the `system.*` metrics above.
