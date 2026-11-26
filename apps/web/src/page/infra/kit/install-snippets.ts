import { ingestUrl } from "../../../platform/ingest-url"
import { Array as Arr, String as Str } from "effect"

// The install modal's snippet builders.

const CHART_DEFAULT_INGEST_URL = "https://ingest.maple.dev"

export const isCustomEndpoint = ingestUrl !== CHART_DEFAULT_INGEST_URL

export const maskToken = (token: string): string => {
	const prefix = "maple_sk_"
	return Str.startsWith(prefix)(token) ? `${prefix}${Str.repeat(24)("•")}` : Str.repeat(24)("•")
}

export const helmCommand = (token: string): string => {
	const lines = [
		"helm upgrade --install maple-k8s-infra \\",
		"  oci://ghcr.io/mapletechlabs/charts/maple-k8s-infra \\",
		"  --namespace maple --create-namespace \\",
		`  --set-string maple.ingestKey.value=${token} \\`,
		"  --set-string global.clusterName=production",
	]
	return Arr.join(
		isCustomEndpoint
			? [
					...lines.slice(0, -1),
					`${lines[lines.length - 1]} \\`,
					`  --set-string maple.ingest.endpoint=${ingestUrl}`,
				]
			: lines,
		"\n",
	)
}

// The chart version the Alchemy and Terraform files pin; the helm command takes the latest.
const CHART_VERSION = "0.6.0"
const ALCHEMY_VERSION = "2.0.0-beta.87"

export const ALCHEMY_FILE = "maple.ts"
export const TERRAFORM_FILE = "maple.tf"

// Alchemy renders the chart without Helm hooks, which is where the bundled operator makes its webhook
// certificate, and the chart's Instrumentation resource fails a first install before the operator's
// CRDs exist. Both files leave pod auto-instrumentation off; the collectors are unaffected.
export const alchemyStack =
	(): string => `// Maple's Kubernetes collector, deployed by Alchemy onto your kubeconfig's current context.
// Written for alchemy ${ALCHEMY_VERSION}:
//   bun add alchemy@${ALCHEMY_VERSION} @alchemy.run/kubernetes@${ALCHEMY_VERSION} effect@^4.1.4
// Needs the helm CLI. Alchemy's state keeps the ingest key, so keep .alchemy/ private.
import * as Alchemy from "alchemy"
import * as Kubernetes from "@alchemy.run/kubernetes"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"

const ingestKey = process.env.MAPLE_INGEST_KEY
if (!ingestKey) throw new Error("Set MAPLE_INGEST_KEY to your Maple ingest key.")

export default Alchemy.Stack(
  "maple-k8s-infra",
  { providers: Kubernetes.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const collector = yield* Kubernetes.HelmChart("maple-k8s-infra", {
      cluster: Kubernetes.KubeConfig(),
      chart: "oci://ghcr.io/mapletechlabs/charts/maple-k8s-infra",
      version: "${CHART_VERSION}",
      releaseName: "maple-k8s-infra",
      namespace: "maple",
      createNamespace: true,
      values: {
        global: { clusterName: "production" },
        maple: { ingestKey: { value: Redacted.make(ingestKey) }${isCustomEndpoint ? `, ingest: { endpoint: "${ingestUrl}" }` : ""} },
        // Pod auto-instrumentation needs Helm's install hooks: use the Helm command for it.
        autoInstrumentation: { enabled: false, operator: { enabled: false } },
      },
    })
    return { namespace: collector.namespace }
  }),
)`

export const alchemyDeployCommand = (token: string): string =>
	`MAPLE_INGEST_KEY=${token} bunx alchemy deploy ${ALCHEMY_FILE} --stage maple`

export const terraformConfig =
	(): string => `# Maple's Kubernetes collector, installed as a Helm release onto your kubeconfig's current context.
terraform {
  required_providers {
    helm = {
      source  = "hashicorp/helm"
      version = "~> 3.0"
    }
  }
}

provider "helm" {
  kubernetes = {
    config_path = "~/.kube/config"
  }
}

variable "maple_ingest_key" {
  type      = string
  sensitive = true
}

resource "helm_release" "maple_k8s_infra" {
  name             = "maple-k8s-infra"
  repository       = "oci://ghcr.io/mapletechlabs/charts"
  chart            = "maple-k8s-infra"
  version          = "${CHART_VERSION}"
  namespace        = "maple"
  create_namespace = true

  values = [yamlencode({
    global = { clusterName = "production" }${
		isCustomEndpoint
			? `
    maple  = { ingest = { endpoint = "${ingestUrl}" } }`
			: ""
	}
    # The Instrumentation resource fails a first install before the operator's CRDs exist.
    autoInstrumentation = { enabled = false, operator = { enabled = false } }
  })]

  set_sensitive = [{
    name  = "maple.ingestKey.value"
    value = var.maple_ingest_key
  }]
}`

export const terraformApplyCommand = (token: string): string =>
	`terraform init && TF_VAR_maple_ingest_key=${token} terraform apply`

export const dockerCommand = (token: string): string =>
	Arr.join(
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
		],
		"\n",
	)

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
