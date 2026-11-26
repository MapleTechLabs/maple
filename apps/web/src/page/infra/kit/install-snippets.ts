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
	(): string => `// Maple's Kubernetes collector, deployed by Alchemy into the kubeconfig context in KUBE_CONTEXT.
// The stack keeps that file and context, so a later destroy reaches the same cluster.
// Written for alchemy ${ALCHEMY_VERSION}:
//   bun add alchemy@${ALCHEMY_VERSION} @alchemy.run/kubernetes@${ALCHEMY_VERSION} effect@^4.1.4
// Needs the helm CLI. Alchemy's state keeps the ingest key, so keep .alchemy/ private.
import * as Alchemy from "alchemy"
import * as Kubernetes from "@alchemy.run/kubernetes"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { homedir } from "node:os"
import { join } from "node:path"

export default Alchemy.Stack(
  "maple-k8s-infra",
  { providers: Kubernetes.providers(), state: Alchemy.localState() },
  // A destroy skips this program and reuses the saved cluster, so it needs neither variable.
  Effect.gen(function* () {
    const ingestKey = yield* Config.schema(Schema.Redacted(Schema.NonEmptyString), "MAPLE_INGEST_KEY")
    const context = yield* Config.NonEmptyString("KUBE_CONTEXT")
    // The stack keeps one kubeconfig file, so it must be the one that defines the context.
    const kubeconfigs = (yield* Config.String("KUBECONFIG").pipe(Config.withDefault(""))).split(":").filter(Boolean)
    if (kubeconfigs.length > 1)
      return yield* Effect.die(new Error("KUBECONFIG lists several files: set it to the one that defines KUBE_CONTEXT."))
    const kubeconfig = kubeconfigs[0] ?? join(homedir(), ".kube", "config")
    const collector = yield* Kubernetes.HelmChart("maple-k8s-infra", {
      cluster: Kubernetes.KubeConfig({ path: kubeconfig, context }),
      chart: "oci://ghcr.io/mapletechlabs/charts/maple-k8s-infra",
      version: "${CHART_VERSION}",
      releaseName: "maple-k8s-infra",
      // Made by the deploy command, not the stack: a destroy then leaves the namespace and the rest of it alone.
      namespace: "maple",
      values: {
        global: { clusterName: "production" },
        maple: { ingestKey: { value: ingestKey }${isCustomEndpoint ? `, ingest: { endpoint: "${ingestUrl}" }` : ""} },
        // Pod auto-instrumentation needs Helm's install hooks: use the Helm command for it.
        autoInstrumentation: { enabled: false, operator: { enabled: false } },
      },
    })
    return { namespace: collector.namespace }
  }),
)`

export const alchemyDeployCommand = (token: string): string =>
	Arr.join(
		[
			'export KUBE_CONTEXT="$(kubectl config current-context)"',
			'kubectl --context "$KUBE_CONTEXT" create namespace maple --dry-run=client -o yaml \\',
			'  | kubectl --context "$KUBE_CONTEXT" apply -f -',
			`MAPLE_INGEST_KEY=${token} bunx alchemy deploy ${ALCHEMY_FILE} --stage maple`,
		],
		"\n",
	)

export const terraformConfig =
	(): string => `# Maple's Kubernetes collector, installed as a Helm release into the kubeconfig context in kube_context.
# The state file holds the ingest key: keep terraform.tfstate out of git, or use an encrypted backend.
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
    config_paths   = split(":", var.kubeconfig)
    config_context = var.kube_context
  }
}

# The apply command writes both to maple.auto.tfvars once and leaves it on reruns, so plan and destroy
# reach the cluster of the first apply. Another cluster gets its own directory and state.
variable "kubeconfig" {
  type    = string
  default = "~/.kube/config"
}

variable "kube_context" {
  type = string
  validation {
    condition     = length(var.kube_context) > 0
    error_message = "Set kube_context to the kubeconfig context the release lives in."
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
	Arr.join(
		[
			'test -f maple.auto.tfvars || { context="$(kubectl config current-context)" &&',
			`  printf 'kubeconfig = "%s"\\nkube_context = "%s"\\n' "\${KUBECONFIG:-$HOME/.kube/config}" "$context" > maple.auto.tfvars; }`,
			`terraform init && TF_VAR_maple_ingest_key=${token} terraform apply`,
		],
		"\n",
	)

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
