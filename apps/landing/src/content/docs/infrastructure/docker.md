---
title: "Docker infrastructure"
description: "Run the Maple Docker agent as a single container to stream per-container CPU, memory, network, block I/O and logs, and correlate them with your app's traces."
group: "Infrastructure"
order: 3
---

Maple's Docker agent is a single OpenTelemetry Collector container with read-only access to the Docker socket. Once it runs, **Infrastructure → Containers** lists every container on the host, spans and logs that carry container identity gain an **Infrastructure** tab, and the **Docker Containers** dashboard template fills in.

Running Kubernetes? Use [Kubernetes infrastructure](/docs/infrastructure/kubernetes) instead. The Helm chart covers pods, nodes and workloads across the cluster. For host-level CPU, memory and disk, see [Hosts](/docs/infrastructure/hosts).

The agent collects:

- **Per-container metrics** through the `docker_stats` receiver: CPU, memory, network, block I/O, restarts, uptime and PID counts, every 30 seconds.
- **Container logs** from the mounted `json-file` log directory. This is optional: drop the mount to skip logs.
- **App OTLP** on ports 4317 (gRPC) and 4318 (HTTP), so it also serves as the host's local collector.

All signals are exported over OTLP HTTP to Maple's ingest gateway.

## Prerequisites

- Docker Engine with the default `json-file` logging driver (for log collection).
- A **private ingest key**. Copy it from **Settings → Ingestion**.
- Ports 4317 and 4318 free on the host. If you already run a collector there, drop the `-p` flags below and keep pointing your apps at the existing one. The agent still collects container metrics and logs without them.

## Install

Run the agent on each Docker host:

```bash
docker run -d --name maple-agent \
  --restart unless-stopped --user 0:0 \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -v /var/lib/docker/containers:/var/lib/docker/containers:ro \
  -v maple-agent-state:/var/lib/otelcol \
  -p 4317:4317 -p 4318:4318 \
  -e MAPLE_INGEST_KEY=YOUR_INGEST_KEY \
  ghcr.io/mapletechlabs/maple/otel-collector-maple:0.2.0 \
  --config /etc/otel/docker-config.yaml
```

The same command, with your key filled in, is on **Infrastructure → Hosts → Add host → Docker**.

Notes on the flags:

- `--user 0:0` is required. The Docker socket and `/var/lib/docker/containers` are not readable by the image's non-root user. The socket mount is read-only.
- The `/var/lib/docker/containers` mount only feeds **log** collection. Drop it if you do not want container logs.
- The `maple-agent-state` volume keeps log-read checkpoints across agent restarts.
- `-e MAPLE_ENVIRONMENT=staging` sets the deployment environment. The default is `production`.
- EU organizations add `-e MAPLE_ENDPOINT=https://ingest.eu.maple.dev`. The default is the US endpoint, `https://ingest.maple.dev`.

### Docker Compose

```yaml
services:
    maple-agent:
        image: ghcr.io/mapletechlabs/maple/otel-collector-maple:0.2.0
        command: ["--config", "/etc/otel/docker-config.yaml"]
        restart: unless-stopped
        user: "0:0"
        environment:
            MAPLE_INGEST_KEY: YOUR_INGEST_KEY
        volumes:
            - /var/run/docker.sock:/var/run/docker.sock:ro
            - /var/lib/docker/containers:/var/lib/docker/containers:ro
            - maple-agent-state:/var/lib/otelcol
        ports:
            - "4317:4317"
            - "4318:4318"

volumes:
    maple-agent-state:
```

The agent copies the `com.docker.compose.project` and `com.docker.compose.service` labels onto every container's metrics, so the Containers page can filter by Compose project and service.

## Verify

Open **Infrastructure → Containers**. Containers on the host appear within about a minute, with CPU and memory filled in. If you kept the log mount, container logs appear under **Logs**.

## What gets collected

| Metric                                           | What it powers                               |
| ------------------------------------------------ | -------------------------------------------- |
| `container.cpu.utilization`                      | CPU column, saturation ranking, CPU chart    |
| `container.memory.percent`                       | Memory-vs-limit column and chart             |
| `container.memory.usage.total` / `.limit`        | Memory bytes chart and limit metadata        |
| `container.network.io.usage.rx_bytes`/`tx_bytes` | Network I/O chart                            |
| `container.blockio.io_service_bytes_recursive`   | Block I/O chart (by operation)               |
| `container.restarts`, `container.uptime`         | Restart count and uptime on the detail page  |
| `container.cpu.limit`, `container.pids.count`    | Returned by the container API; not charted   |

Identity rides on resource attributes: `container.name`, `container.id`, `container.image.name`, `container.runtime`, and `host.name`. The agent reads `host.name` from the Docker daemon, so it reports the host, not the agent container. Container names are only unique per host, so Maple keys every container on `(container.name, host.name)`.

CPU utilization is Docker's percentage. It can exceed 100% on multi-core containers. Most plain-Docker containers run without CPU limits, so read the saturation ranking as a list of the heaviest containers first. It does not measure remaining capacity.

## Correlate app telemetry

Spans and logs open an **Infrastructure** tab when they carry container identity. Kubernetes injects that identity through the OpenTelemetry Operator. Plain Docker has no injection mechanism, so your app's SDK has to set it:

- **`@maple-dev/effect-sdk`** detects Docker identity automatically. It reads `/proc/self/mountinfo`, then `/proc/self/cgroup`, and falls back to the short container id in the hostname.
- **Any other OpenTelemetry SDK:** set it in your Compose file. Docker's default hostname is the short container id:

    ```yaml
    environment:
        OTEL_RESOURCE_ATTRIBUTES: "container.id=${HOSTNAME},container.name=myservice"
    ```

If your containers set a custom `hostname:`, the hostname fallback cannot work. Set `OTEL_RESOURCE_ATTRIBUTES` explicitly.

## Security notes

- The agent mounts the Docker socket read-only, but socket access is still effectively root on the host. Run the agent only on hosts you control, and pin the image tag instead of using `latest`.
- The install command embeds your **private ingest key**. Rotate it from **Settings → Ingestion** if it leaks.

## Troubleshooting

- **Nothing after two minutes.** Check the agent's own logs with `docker logs maple-agent`. A `401` from the exporter means the ingest key is wrong or was rotated.
- **`port is already allocated`.** Another collector already owns 4317 or 4318 on this host. Drop the `-p` flags (see Prerequisites) or remap them.
- **`permission denied` on the socket.** The agent is not running as root (`--user 0:0`), or the socket lives elsewhere. Rootless Docker uses `$XDG_RUNTIME_DIR/docker.sock`, and the command above does not support rootless setups.
- **Metrics but no logs.** The log-directory mount is missing, or your daemon uses a logging driver other than `json-file`.
- **Containers counted under Stale agent.** The agent has not reported them for over five minutes. Check whether the agent restarted or the host is overloaded.

## Uninstall

Stop and remove the agent container:

```bash
docker rm -f maple-agent
```

To also delete the saved log-read checkpoints:

```bash
docker volume rm maple-agent-state
```

With Docker Compose, remove the `maple-agent` service and its volume from your Compose file, then run `docker compose up -d --remove-orphans`.

Data already sent to Maple stays until it ages out under your plan's [retention](/docs/reference/retention).
