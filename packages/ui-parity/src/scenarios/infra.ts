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

/** Held far past any capture, so the screenshot is the loading state. */
const HELD_MS = 60_000

/** The loading and error states of a page whose data comes from `tag` (a tag prefix). */
/** `loadingTag` narrows the held prefix: Chromium queues a seventh request per origin, which never settles. */
const timed = (
	id: string,
	title: string,
	path: string,
	dataset: string,
	tag: string,
	loadingTag = tag,
): ReadonlyArray<Scenario> => [
	{
		...scenario(`${id}-loading`, `${title}: loading`, path, dataset),
		faults: { delays: { [loadingTag]: HELD_MS } },
		settle: "held",
	},
	{
		...scenario(`${id}-error`, `${title}: failing`, path, dataset),
		faults: {
			failures: {
				[tag]: {
					status: 502,
					body: {
						_tag: "@maple/http/errors/QueryEngineExecutionError",
						message: "ui-parity: injected infra failure",
					},
				},
			},
		},
	},
]

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
		...timed("host-detail", "Host detail", `/infra/hosts/${HOST}`, "default", "queryEngine.host", "queryEngine.hostDetailSummary"),
		scenario("host-detail-time-range", "Host detail: last 6 hours", `/infra/hosts/${HOST}`, "default", async (page) => {
			await page.getByRole("button", { name: "Last 1 hour" }).click()
			await page.getByRole("dialog").getByRole("button", { name: "Last 6 hours" }).click()
			await page.getByRole("dialog").waitFor({ state: "detached" })
		}),
		scenario("host-detail-copy", "Host detail: copy host.name", `/infra/hosts/${HOST}`, "default", (page) =>
			page.getByRole("button", { name: "Copy host.name" }).click(),
		),
		scenario("host-legacy","Legacy host URL redirects", `/infra/${HOST}`, "default"),
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
		...timed("hosts", "Hosts", "/infra/hosts", "default", "queryEngine.listHosts"),
		scenario("hosts-add-host", "Hosts: the install modal", "/infra/hosts", "default", (page) =>
			page.getByRole("button", { name: "Add host" }).click(),
		),
		scenario("hosts-sort-name", "Hosts: sorted by name", "/infra/hosts", "default", (page) =>
			page.getByRole("button", { name: "Host", exact: true }).click(),
		),
		scenario("hosts-search", "Hosts: searched with no match", "/infra/hosts", "default", (page) =>
			page.getByRole("textbox", { name: "Search hosts…" }).fill("nope"),
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
		...timed("pods", "Pods", "/infra/kubernetes/pods", K8S, "queryEngine.listPods"),
		scenario("pods-sort-cpu", "Pods: sorted by CPU cores", "/infra/kubernetes/pods", K8S, (page) =>
			page.getByRole("button", { name: "CPU cores", exact: true }).click(),
		),
		scenario("pods-search", "Pods: searched by name", "/infra/kubernetes/pods", K8S, async (page) => {
			await page.getByRole("textbox", { name: "Search all pods…" }).fill("payment")
			await page.getByText("2 pods", { exact: true }).waitFor()
		},
		),
		scenario("pods-empty-install", "Pods: the Helm install modal", "/infra/kubernetes/pods", EMPTY, (page) =>
			page.getByRole("button", { name: "Install the Helm chart" }).click(),
		),
		scenario("pods-scope-ended","Pods: ended scope", "/infra/kubernetes/pods", K8S, clickText("Ended")),
		...timed(
			"pod-detail",
			"Pod detail",
			`/infra/kubernetes/pods/${PAYMENT_POD}?namespace=shop`,
			K8S,
			"queryEngine.pod",
			"queryEngine.podDetailSummary",
		),
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
		...timed("containers", "Containers", "/infra/containers", K8S, "queryEngine.listContainers"),
		scenario("containers-sort-cpu", "Containers: sorted by CPU", "/infra/containers", K8S, (page) =>
			page.getByRole("button", { name: "CPU", exact: true }).click(),
		),
		scenario("containers-facet", "Containers: one container ticked", "/infra/containers", K8S, (page) =>
			page.getByRole("checkbox", { name: "ci-stack-redis-1" }).click(),
		),
		scenario("containers-search", "Containers: searched by name", "/infra/containers", K8S, async (page) => {
			await page.getByRole("textbox", { name: "Search all containers…" }).fill("redis")
			// The search is debounced (300 ms): wait for the narrowed page before settling.
			await page.getByText("1 container", { exact: true }).waitFor()
		},
		),
		scenario("containers-empty-install", "Containers: the Docker install modal", "/infra/containers", EMPTY, (page) =>
			page.getByRole("button", { name: "Install the Docker agent" }).click(),
		),
		scenario(
			"containers-scope-saturated",
			"Containers: saturated scope",
			"/infra/containers",
			K8S,
			clickText("Saturated"),
		),
		...timed(
			"container-detail",
			"Container detail",
			`/infra/containers/${CONTAINER}?host=build-runner-01`,
			K8S,
			"queryEngine.container",
			"queryEngine.containerDetailSummary",
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
