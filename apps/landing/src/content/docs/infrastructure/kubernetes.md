---
title: "Kubernetes Infrastructure"
description: "Deploy Maple's Kubernetes infrastructure collector with Helm to stream host, kubelet and cluster metrics, and wire the service map's Infrastructure tab to your workloads."
group: "Infrastructure"
order: 1
---

The `maple-k8s-infra` Helm chart collects host, kubelet and cluster metrics from your Kubernetes cluster over OpenTelemetry and sends them to Maple. Once it runs, the **Infrastructure** pages list your nodes, pods and workloads, and each service on the service map gains a pod-count badge and an Infrastructure tab.

Running plain Docker hosts instead of, or alongside, Kubernetes? See [Docker Infrastructure](/docs/infrastructure/docker). A single-container agent covers per-container metrics and logs. For hosts outside Kubernetes, see [Hosts](/docs/infrastructure/hosts).

The chart uses a split-collector architecture:

- a **DaemonSet** for node-local OTLP, host metrics, kubelet/pod metrics, and optional pod logs
- a single-replica **Deployment** for cluster-wide metrics and optional Kubernetes events

All signals are exported over OTLP HTTP to Maple's ingest gateway, which authenticates the ingest key.

## Prerequisites

- `kubectl` and `helm` (v3.8+, for OCI registry support) pointed at the target cluster
- Cluster-admin (the chart installs RBAC and, by default, the OpenTelemetry Operator)
- A **private ingest key**. Copy it from **Settings → Ingestion**.

## Install

The install script creates the namespace and the ingest-key Secret and runs Helm for you. It prints your active `kubectl` context and asks for confirmation first (set `MAPLE_INSTALL_YES=1` to skip):

```bash
curl -fsSL https://raw.githubusercontent.com/MapleTechLabs/maple/main/deploy/k8s-infra/install.sh | \
  MAPLE_INGEST_KEY=YOUR_INGEST_KEY \
  MAPLE_CLUSTER_NAME=production \
  bash
```

Prefer Helm directly? Install the published OCI chart:

```bash
helm upgrade --install maple-k8s-infra \
  oci://ghcr.io/mapletechlabs/charts/maple-k8s-infra \
  --namespace maple --create-namespace \
  --set-string maple.ingestKey.value=YOUR_INGEST_KEY \
  --set-string global.clusterName=production
```

For production, keep the key out of your Helm values and reference an existing Secret instead:

```bash
kubectl create namespace maple
kubectl -n maple create secret generic maple-ingest-key \
  --from-literal=ingest-key=YOUR_INGEST_KEY

helm upgrade --install maple-k8s-infra \
  oci://ghcr.io/mapletechlabs/charts/maple-k8s-infra \
  --namespace maple \
  --set maple.ingestKey.existingSecret.name=maple-ingest-key \
  --set maple.ingestKey.existingSecret.key=ingest-key \
  --set-string global.clusterName=production
```

Confirm the rollout:

```bash
kubectl -n maple rollout status daemonset/maple-k8s-infra-agent
kubectl -n maple rollout status deployment/maple-k8s-infra-cluster
```

### EU organizations

The chart defaults to the US ingest endpoint (`https://ingest.maple.dev`). EU organizations add:

```bash
  --set-string maple.ingest.endpoint=https://ingest.eu.maple.dev
```

The command on **Infrastructure → Hosts → Add host → Kubernetes** includes this flag when your organization is in the EU region.

## What gets collected

Enabled by default:

- **Host metrics:** CPU, memory, disk, network and load per node. These fill the [Hosts](/docs/infrastructure/hosts) page.
- **Kubelet and pod metrics:** per-pod CPU usage, and CPU and memory utilization against limits and requests.
- **Cluster metrics:** node conditions, pod phases, deployment availability and namespace phases.
- **OTLP receivers:** gRPC `:4317` and HTTP `:4318` on every node, so in-cluster apps can send traces, logs and metrics to the local agent.

Off by default (enable per your ingestion budget):

```yaml
presets:
    podLogs:
        enabled: true
    k8sEvents:
        enabled: true
    fargateMetrics: # EKS Fargate per-pod CPU/memory
        enabled: true
```

In-cluster apps can export to the agent's Service:

```
OTLP gRPC: maple-k8s-infra-agent.maple.svc:4317
OTLP HTTP: http://maple-k8s-infra-agent.maple.svc:4318
```

## Verify

Within about a minute of a healthy rollout:

1. Open **Infrastructure → Hosts**. Your nodes appear with CPU, memory and disk. The **Kubernetes** pages list pods, nodes and workloads.
2. If a view stays empty, check the agent logs: `kubectl -n maple logs -l app.kubernetes.io/component=agent --tail=200`.

## Wire the service map's Infrastructure tab

To get a pod-count badge and an Infrastructure tab on each **service** node (correlating your app traces to the workload running them), opt a namespace into env-var injection:

```bash
kubectl annotate namespace shop \
  instrumentation.opentelemetry.io/inject-sdk=maple/maple-default

kubectl rollout restart deployment -n shop
```

The chart bundles the OpenTelemetry Operator and an `Instrumentation/maple-default` resource. It injects downward-API environment variables: `OTEL_EXPORTER_OTLP_ENDPOINT`, and the pod IP, UID, name, namespace and node in `OTEL_RESOURCE_ATTRIBUTES`. Your app's OpenTelemetry SDK reads those on startup. The agent's `k8sattributes` processor then adds `k8s.deployment.name`, `k8s.statefulset.name` or `k8s.daemonset.name` to each span, which joins `service.name` to its workload.

**This only injects environment variables. It does not add an SDK to your app.** Your service must already emit OTLP spans, and its SDK must read the standard `OTEL_*` variables. Most auto-instrumentation agents and Maple's SDKs do. To opt many namespaces in at install time, list them under `autoInstrumentation.instrumentation.autoInstrumentNamespaces` instead of annotating each one.

## Per-cloud notes

| Distribution                    | Notes                                                                                                                                                                               |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EKS standard, GKE Standard, AKS | Works out of the box.                                                                                                                                                               |
| EKS Fargate                     | The DaemonSet can't run on Fargate nodes. Keep one EC2 node for the agent, and set `presets.fargateMetrics.enabled=true` so per-pod CPU/memory is scraped via the API-server proxy. |
| GKE Autopilot                   | Only annotate your own namespaces. Mutating webhooks are rejected on Google-managed namespaces.                                                                                      |
| k3s / kind / k0s                | Works with auto-generated webhook certs (no cert-manager needed).                                                                                                                   |
| Service mesh (Linkerd, Istio)   | Sidecars rewrite source IPs, but the `k8s.pod.uid` / `(name, namespace)` association keys ride inside the OTLP payload and rescue the workload join. No mesh-side config needed.    |

## Troubleshooting

- **No hosts or pods after a few minutes.** Confirm both workloads are `Ready` and look for `k8sattributes` or exporter errors in `kubectl -n maple logs -l app.kubernetes.io/component=agent`.
- **Empty Infrastructure tab on a service.** The namespace annotation wasn't applied or the pods weren't restarted, or your SDK ignores `OTEL_*` env vars. Verify with `kubectl exec -n <ns> <pod> -- env | grep OTEL`.
- **Operator webhook crash-looping.** This is usually a certificate issue. Switch to cert-manager with `opentelemetryOperator.admissionWebhooks.certManager.enabled=true` if your cluster requires it.

Already running the OpenTelemetry Operator yourself? Set `autoInstrumentation.operator.enabled=false`. The `Instrumentation` resource still renders, so you can apply it to your own setup.

## Uninstall

```bash
helm uninstall maple-k8s-infra --namespace maple
```

To stop env-var injection for a namespace without uninstalling, remove the annotation and restart:

```bash
kubectl annotate namespace shop instrumentation.opentelemetry.io/inject-sdk-
kubectl rollout restart deployment -n shop
```
