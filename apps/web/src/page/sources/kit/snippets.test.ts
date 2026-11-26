import { Array as Arr, Option } from "effect"
import { describe, expect, it } from "vitest"
import { sourceSnippets } from "./snippets"

describe("sourceSnippets", () => {
	it("gives the browser SDK snippet the service name init() requires, slugged from the source", () => {
		const [browser] = sourceSnippets("browser", "maple_pk_test", "Marketing Site")
		expect(browser?.code).toContain('serviceName: "marketing-site"')
		expect(browser?.code).toContain('ingestKey: "maple_pk_test"')
	})

	it("gives a Python source everything to start sending: env over HTTP, the install, then the run", () => {
		const snippets = sourceSnippets("python", "maple_src_test", "Billing API")
		expect(Arr.map(snippets, (snippet) => snippet.id)).toEqual(["env", "install", "sdk"])
		const [env, install, run] = snippets
		expect(env?.code).toContain('OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"')
		expect(env?.code).toContain('OTEL_SERVICE_NAME="billing-api"')
		expect(install?.code).toContain("opentelemetry-distro")
		expect(run?.code).toContain("opentelemetry-instrument")
	})

	it("offers a Kubernetes source Helm, Alchemy and Terraform, keeping the key out of the files", () => {
		const snippets = sourceSnippets("kubernetes", "maple_src_test", "Cluster")
		expect(Arr.map(snippets, (snippet) => snippet.id)).toEqual([
			"helm",
			"alchemy",
			"alchemy-deploy",
			"terraform",
			"terraform-apply",
		])
		const code = (id: string): string =>
			Option.match(
				Arr.findFirst(snippets, (snippet) => snippet.id === id),
				{ onNone: () => "", onSome: (snippet) => snippet.code },
			)
		expect(code("alchemy")).not.toContain("maple_src_test")
		expect(code("terraform")).not.toContain("maple_src_test")
		expect(code("alchemy")).toContain('chart: "oci://ghcr.io/mapletechlabs/charts/maple-k8s-infra"')
		expect(code("terraform")).toContain('resource "helm_release" "maple_k8s_infra"')
		expect(code("alchemy-deploy")).toContain(
			"MAPLE_INGEST_KEY=maple_src_test bunx alchemy deploy maple.ts --stage maple",
		)
		expect(code("terraform-apply")).toContain(
			"terraform init && TF_VAR_maple_ingest_key=maple_src_test terraform apply",
		)
	})

	it("pins both IaC installs to one cluster and leaves the namespace outside the Alchemy stack", () => {
		const snippets = sourceSnippets("kubernetes", "maple_src_test", "Cluster")
		const code = (id: string): string =>
			Option.match(
				Arr.findFirst(snippets, (snippet) => snippet.id === id),
				{ onNone: () => "", onSome: (snippet) => snippet.code },
			)
		// A destroy reads the context back from the stack or the tfvars file, not the shell's current one.
		expect(code("alchemy")).toContain("Kubernetes.KubeConfig({ path: kubeconfig, context })")
		expect(code("alchemy-deploy")).toContain('export KUBE_CONTEXT="$(kubectl config current-context)"')
		expect(code("terraform")).toContain("config_context = var.kube_context")
		expect(code("terraform-apply")).toContain("> maple.auto.tfvars")
		// Tracking the namespace would make a destroy delete everything else in it.
		expect(code("alchemy")).not.toContain("createNamespace")
		expect(code("alchemy-deploy")).toContain("create namespace maple")
	})
})
