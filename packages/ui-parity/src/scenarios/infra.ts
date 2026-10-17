import type { Page } from "playwright"
import type { AreaModule, Scenario } from "./types.ts"

/**
 * Hosts, Kubernetes and containers. Hosts read the `default` org's hostmetrics; the cluster and
 * the Compose host live in `infra-k8s` (src/fixtures/areas/infra.ts), so `default` stays as it is.
 */

const K8S = "infra-k8s"
const EMPTY = "empty"
const HOST = "ip-10-0-12-84"
/** payment-svc 3.5.0, replica p1: crash-looping with OOMKilled since the rollout. */
const PAYMENT_POD = "payment-svc-f8f3f66ef-p1"
const CONTAINER = "ci-stack-ci-worker-1"

const scenario = (
	id: string,
	title: string,
	path: string,
	dataset: string,
	steps?: (page: Page) => Promise<void>,
	pageCalls?: ReadonlyArray<string>,
): Scenario => ({
	id: `infra-${id}`,
	title,
	path,
	dataset,
	viewports: ["desktop"],
	themes: ["light", "dark"],
	steps,
	pageCalls,
	area: "infra",
})

/** One exact-text click: chart tabs, scope cards and facet values carry no richer role. */
const clickText = (text: string) => (page: Page) => page.getByText(text, { exact: true }).first().click()

/**
 * Legacy's service lens fires its CPU series before the workload and the overview's bucket width
 * resolve, so which intermediate requests land depends on response order. Left out of the call diff.
 */
const SERVICE_LENS_RACE = ["queryEngine.workloadInfraTimeseries"]

export const infraArea: AreaModule = {
	area: "infra",
	scenarios: [
		scenario("overview", "Infrastructure overview (cluster org)", "/infra", K8S),
		scenario("overview-empty", "Infrastructure overview (empty org)", "/infra", EMPTY),
		scenario("discover", "Discover redirects to the overview", "/infra/discover", "default"),
		scenario("hosts", "Hosts", "/infra/hosts", "default"),
		scenario("hosts-empty", "Hosts (empty org)", "/infra/hosts", EMPTY),
		scenario("host-detail", "Host detail", `/infra/hosts/${HOST}`, "default"),
		scenario("host-legacy", "Legacy host URL redirects", `/infra/${HOST}`, "default"),
		scenario("kubernetes", "Kubernetes overview", "/infra/kubernetes", K8S),
		scenario("kubernetes-empty", "Kubernetes overview (empty org)", "/infra/kubernetes", EMPTY),
		scenario("pods", "Pods", "/infra/kubernetes/pods", K8S),
		scenario("pods-empty", "Pods (empty org)", "/infra/kubernetes/pods", EMPTY),
		scenario(
			"pod-detail",
			"Pod detail: crash-looping payment pod",
			`/infra/kubernetes/pods/${PAYMENT_POD}?namespace=shop`,
			K8S,
		),
		scenario("nodes", "Nodes", "/infra/kubernetes/nodes", K8S),
		scenario("nodes-empty", "Nodes (empty org)", "/infra/kubernetes/nodes", EMPTY),
		scenario("node-detail", "Node detail", `/infra/kubernetes/nodes/${HOST}`, K8S),
		scenario("services", "Kubernetes services", "/infra/kubernetes/services", K8S),
		scenario("services-empty", "Kubernetes services (empty org)", "/infra/kubernetes/services", EMPTY),
		scenario(
			"service-detail",
			"Kubernetes service: payment-svc",
			"/infra/kubernetes/services/payment-svc",
			K8S,
			undefined,
			SERVICE_LENS_RACE,
		),
		scenario("workloads", "Workloads", "/infra/kubernetes/workloads", K8S),
		scenario("workloads-empty", "Workloads (empty org)", "/infra/kubernetes/workloads", EMPTY),
		scenario(
			"workload-detail",
			"Workload: payment-svc deployment",
			"/infra/kubernetes/workloads/deployment/payment-svc?namespace=shop",
			K8S,
		),
		scenario("containers", "Containers", "/infra/containers", K8S),
		scenario("containers-empty", "Containers (empty org)", "/infra/containers", EMPTY),
		scenario(
			"container-detail",
			"Container detail: ci-worker",
			`/infra/containers/${CONTAINER}?host=build-runner-01`,
			K8S,
		),
		// Interactions.
		scenario("overview-open-attention", "Overview: open the saturated pods", "/infra", K8S, (page) =>
			page.getByText("2 pods at their CPU or memory limit").click(),
		),
		scenario(
			"hosts-scope-elevated",
			"Hosts: elevated scope",
			"/infra/hosts",
			"default",
			clickText("Elevated"),
		),
		scenario(
			"hosts-open-row",
			"Hosts: open the busiest host",
			"/infra/hosts",
			"default",
			clickText("ip-10-0-22-140"),
		),
		scenario(
			"pods-facet-namespace",
			"Pods: filter to observability",
			"/infra/kubernetes/pods",
			K8S,
			clickText("observability"),
		),
		scenario("pods-scope-ended", "Pods: ended scope", "/infra/kubernetes/pods", K8S, clickText("Ended")),
		scenario(
			"pod-detail-memory",
			"Pod detail: memory vs limit chart",
			`/infra/kubernetes/pods/${PAYMENT_POD}?namespace=shop`,
			K8S,
			clickText("Mem / limit"),
		),
		scenario(
			"node-detail-memory",
			"Node detail: memory vs allocatable",
			`/infra/kubernetes/nodes/${HOST}`,
			K8S,
			clickText("Memory / allocatable"),
		),
		scenario(
			"services-pick",
			"Kubernetes services: pick payment-svc",
			"/infra/kubernetes/services",
			K8S,
			clickText("payment-svc"),
			SERVICE_LENS_RACE,
		),
		scenario(
			"workloads-statefulsets",
			"Workloads: StatefulSets",
			"/infra/kubernetes/workloads",
			K8S,
			clickText("StatefulSets"),
		),
		scenario("workloads-jobs", "Workloads: Jobs", "/infra/kubernetes/workloads", K8S, clickText("Jobs")),
		scenario(
			"containers-scope-saturated",
			"Containers: saturated scope",
			"/infra/containers",
			K8S,
			clickText("Saturated"),
		),
		scenario(
			"container-detail-network",
			"Container detail: network chart",
			`/infra/containers/${CONTAINER}?host=build-runner-01`,
			K8S,
			clickText("Network I/O"),
		),
	],
}
