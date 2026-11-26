import { ingestUrl } from "../../../platform/ingest-url"
import { Array as Arr } from "effect"
import { commandStep, fileStep, type InstallRecipe } from "../../kit/install-recipe"

// The collector's install snippets, and the recipes the install dialog and a Kubernetes, Docker or
// Host source show them as.

const CHART_DEFAULT_INGEST_URL = "https://ingest.maple.dev"

export const isCustomEndpoint = ingestUrl !== CHART_DEFAULT_INGEST_URL

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
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { homedir } from "node:os"
import { join } from "node:path"

const ingestKey = process.env.MAPLE_INGEST_KEY
if (!ingestKey) throw new Error("Set MAPLE_INGEST_KEY to your Maple ingest key.")
const context = process.env.KUBE_CONTEXT
if (!context) throw new Error("Set KUBE_CONTEXT to the kubeconfig context to deploy into.")
const kubeconfig = process.env.KUBECONFIG?.split(":")[0] || join(homedir(), ".kube", "config")

export default Alchemy.Stack(
  "maple-k8s-infra",
  { providers: Kubernetes.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const collector = yield* Kubernetes.HelmChart("maple-k8s-infra", {
      cluster: Kubernetes.KubeConfig({ path: kubeconfig, context }),
      chart: "oci://ghcr.io/mapletechlabs/charts/maple-k8s-infra",
      version: "${CHART_VERSION}",
      releaseName: "maple-k8s-infra",
      // Made by the deploy command, not the stack: a destroy then leaves the namespace and the rest of it alone.
      namespace: "maple",
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

# The apply command writes both to maple.auto.tfvars, so plan and destroy reach the same cluster.
variable "kubeconfig" {
  type    = string
  default = "~/.kube/config"
}

variable "kube_context" {
  type = string
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
			`printf 'kubeconfig = "%s"\\nkube_context = "%s"\\n' \\`,
			'  "${KUBECONFIG:-$HOME/.kube/config}" "$(kubectl config current-context)" > maple.auto.tfvars',
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

export const KUBERNETES_RECIPES: ReadonlyArray<InstallRecipe> = [
	{
		tool: "helm",
		steps: [
			commandStep({
				id: "helm",
				title: "Run this against your cluster",
				hint: ["For production, use an existing Secret instead of an inline key. See the docs."],
				build: helmCommand,
			}),
		],
	},
	{
		tool: "alchemy",
		steps: [
			fileStep({
				id: "alchemy",
				name: ALCHEMY_FILE,
				lang: "typescript",
				text: alchemyStack(),
				hint: [
					"The deploy command pins it to your current kubeconfig context and makes the namespace. Pod auto-instrumentation stays off: it needs Helm's install hooks.",
				],
			}),
			commandStep({ id: "alchemy-deploy", title: "Deploy it", build: alchemyDeployCommand }),
		],
	},
	{
		tool: "terraform",
		steps: [
			fileStep({
				id: "terraform",
				name: TERRAFORM_FILE,
				lang: "hcl",
				text: terraformConfig(),
				hint: [
					"The apply command pins it to your current kubeconfig context. Pod auto-instrumentation stays off.",
				],
			}),
			commandStep({ id: "terraform-apply", title: "Apply it", build: terraformApplyCommand }),
		],
	},
]

export const DOCKER_RECIPES: ReadonlyArray<InstallRecipe> = [
	{
		tool: "docker",
		steps: [
			commandStep({
				id: "docker",
				title: "Run the agent",
				hint: ["Container logs come from the mounted log directory. Drop that mount to skip them."],
				build: dockerCommand,
			}),
		],
	},
]

export const HOST_RECIPES: ReadonlyArray<InstallRecipe> = [
	{
		tool: "host",
		steps: [
			fileStep({
				id: "host-config",
				name: "config.yaml",
				lang: "yaml",
				text: HOST_CONFIG,
				hint: [
					"Install the OpenTelemetry Collector Contrib distribution, ",
					{ code: "otelcol-contrib" },
					", first. This is its config.",
				],
			}),
			commandStep({ id: "host", title: "Start the collector", build: hostCommand }),
		],
	},
]
