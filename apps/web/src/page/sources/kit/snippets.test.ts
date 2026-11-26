import { Array as Arr, Option } from "effect"
import { describe, expect, it } from "vitest"
import { sourceRecipes, sourceSnippets } from "./snippets"

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

	it("installs a Kubernetes source with Helm, Alchemy or Terraform, keeping the key out of the files", () => {
		const recipes = sourceRecipes("kubernetes") ?? []
		expect(Arr.map(recipes, (recipe) => recipe.tool)).toEqual(["helm", "alchemy", "terraform"])
		const steps = Arr.flatMap(recipes, (recipe) => recipe.steps)
		const textOf = (id: string): string =>
			Option.match(
				Arr.findFirst(steps, (step) => step.id === id),
				{
					onNone: () => "",
					onSome: (step) => (step._tag === "File" ? step.text : step.build("maple_src_test")),
				},
			)
		expect(textOf("alchemy")).not.toContain("maple_src_test")
		expect(textOf("terraform")).not.toContain("maple_src_test")
		expect(textOf("alchemy")).toContain('chart: "oci://ghcr.io/mapletechlabs/charts/maple-k8s-infra"')
		expect(textOf("terraform")).toContain('resource "helm_release" "maple_k8s_infra"')
		expect(textOf("alchemy-deploy")).toContain(
			"MAPLE_INGEST_KEY=maple_src_test bunx alchemy deploy maple.ts --stage maple",
		)
		expect(textOf("terraform-apply")).toContain(
			"terraform init && TF_VAR_maple_ingest_key=maple_src_test terraform apply",
		)
		expect(sourceSnippets("kubernetes", "maple_src_test", "Cluster")).toEqual([])
		// A destroy reads the context back from the stack or the tfvars file, not the shell's current one.
		expect(textOf("alchemy")).toContain("Kubernetes.KubeConfig({ path: kubeconfig, context })")
		expect(textOf("alchemy-deploy")).toContain('export KUBE_CONTEXT="$(kubectl config current-context)"')
		expect(textOf("terraform")).toContain("config_context = var.kube_context")
		expect(textOf("terraform-apply")).toContain("> maple.auto.tfvars")
		// Tracking the namespace would make a destroy delete everything else in it.
		expect(textOf("alchemy")).not.toContain("createNamespace")
		expect(textOf("alchemy-deploy")).toContain("create namespace maple")
	})
})
