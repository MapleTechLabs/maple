import { ingestUrl } from "../../../lib/services/common/ingest-url"

// The install modal's snippet builders.

const CHART_DEFAULT_INGEST_URL = "https://ingest.maple.dev"

export const isCustomEndpoint = ingestUrl !== CHART_DEFAULT_INGEST_URL

export const maskToken = (token: string): string => {
	const prefix = "maple_sk_"
	return token.startsWith(prefix) ? `${prefix}${"•".repeat(24)}` : "•".repeat(24)
}

export const helmCommand = (token: string): string => {
	const lines = [
		"helm upgrade --install maple-k8s-infra \\",
		"  oci://ghcr.io/mapletechlabs/charts/maple-k8s-infra \\",
		"  --namespace maple --create-namespace \\",
		`  --set-string maple.ingestKey.value=${token} \\`,
		"  --set-string global.clusterName=production",
	]
	return (
		isCustomEndpoint
			? [
					...lines.slice(0, -1),
					`${lines[lines.length - 1]} \\`,
					`  --set-string maple.ingest.endpoint=${ingestUrl}`,
				]
			: lines
	).join("\n")
}

export const dockerCommand = (token: string): string =>
	[
		"docker run -d --name maple-agent \\",
		"  --restart unless-stopped --user 0:0 \\",
		"  -v /var/run/docker.sock:/var/run/docker.sock:ro \\",
		"  -v /var/lib/docker/containers:/var/lib/docker/containers:ro \\",
		"  -v maple-agent-state:/var/lib/otelcol \\",
		"  -p 4317:4317 -p 4318:4318 \\",
		`  -e MAPLE_INGEST_KEY=${token} \\`,
		...(isCustomEndpoint ? [`  -e MAPLE_ENDPOINT=${ingestUrl} \\`] : []),
		"  ghcr.io/mapletechlabs/maple/otel-collector-maple:0.2.0 \\",
		"  --config /etc/otel/docker-config.yaml",
	].join("\n")

export const HOST_CONFIG = `receivers:
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
        endpoint: ${ingestUrl}
        compression: gzip
        headers:
            x-maple-ingest-key: \${env:MAPLE_INGEST_KEY}

service:
    pipelines:
        metrics:
            receivers: [hostmetrics]
            processors: [resourcedetection, batch]
            exporters: [otlphttp/maple]`

export const hostCommand = (token: string): string =>
	`MAPLE_INGEST_KEY=${token} otelcol-contrib --config config.yaml`
