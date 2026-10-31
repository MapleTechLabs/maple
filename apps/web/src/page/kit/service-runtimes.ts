import { ServiceRuntimeRow } from "@maple/domain/http"
import { SERVICE_RUNTIME_KINDS } from "@maple/domain/service-runtimes"
import { gcpWorkloadSearch } from "../../components/infra/gcp/tabs"
import { AppRoute, hrefOf } from "../../route"
import type { IconName } from "../../ui/icon"
import { resourceSearch } from "../infra-integrations/aws/derive"
import { SOURCE_ICON } from "../infra/overview/source-mark"
import type { TimeSearch } from "./time-controls"

// Where a service runs, as links to the infra pages: its platform resources
// (`ServiceRuntimesResponse`) and its Kubernetes workloads. The service page's "Runs on" card and
// the service map panel's Infrastructure tab read these.

export const ServiceRuntime = ServiceRuntimeRow
export type ServiceRuntime = ServiceRuntimeRow

export interface RuntimeLink {
	readonly key: string
	readonly icon: IconName
	/** What the platform calls it: "Cloud Run service". */
	readonly label: string
	readonly name: string
	/** Project, account, region or environment, whichever the platform reports. */
	readonly location: ReadonlyArray<string>
	readonly href: string
}

const present = (values: ReadonlyArray<string>) => values.filter((value) => value !== "")

const runtimeHref = (runtime: ServiceRuntime, time: TimeSearch): string => {
	switch (runtime.kind) {
		case "cloudRun":
		case "cloudFunctions":
			return hrefOf(
				AppRoute.InfraGcpResource({
					service: runtime.kind,
					name: runtime.serviceName,
					search: {
						...time,
						...gcpWorkloadSearch(runtime.kind, [runtime.serviceName, runtime.account, runtime.region]),
					},
				}),
			)
		case "ecs":
		case "lambda":
			return hrefOf(
				AppRoute.InfraAwsResource({
					kind: runtime.kind,
					name: runtime.serviceName,
					search: { ...time, ...resourceSearch({ ...runtime, kind: runtime.kind }) },
				}),
			)
		case "railway":
			return hrefOf(
				AppRoute.InfraRailwayService({
					serviceId: runtime.railwayServiceId,
					search: { ...time, environmentId: runtime.railwayEnvironmentId },
				}),
			)
		case "cloudflareWorker":
			return hrefOf(
				AppRoute.InfraCloudflareWorker({
					scriptName: runtime.serviceName,
					search: { ...time, account: runtime.account === "" ? undefined : runtime.account },
				}),
			)
	}
}

const runtimeLocation = (runtime: ServiceRuntime): ReadonlyArray<string> => {
	switch (runtime.kind) {
		case "railway":
			return present([runtime.railwayEnvironmentName])
		case "ecs":
			return present([runtime.cluster, runtime.region])
		// A Cloudflare account id is a hash nobody reads.
		case "cloudflareWorker":
			return []
		default:
			return present([runtime.account, runtime.region])
	}
}

export const runtimeLink = (runtime: ServiceRuntime, time: TimeSearch): RuntimeLink => {
	const kind = SERVICE_RUNTIME_KINDS[runtime.kind]
	return {
		key: [
			runtime.kind,
			runtime.serviceName,
			runtime.account,
			runtime.region,
			runtime.cluster,
			runtime.railwayEnvironmentId,
		].join("|"),
		icon: SOURCE_ICON[kind.provider],
		label: kind.label,
		name: runtime.serviceName,
		location: runtimeLocation(runtime),
		href: runtimeHref(runtime, time),
	}
}

export type WorkloadKind = "deployment" | "statefulset" | "daemonset" | "unknown"

const WORKLOAD_LABEL = {
	deployment: "Deployment",
	statefulset: "StatefulSet",
	daemonset: "DaemonSet",
	unknown: "Workload",
} as const satisfies Record<WorkloadKind, string>

/** A Kubernetes workload as a link: its workload page, or its pods when the kind is unknown. */
export const workloadLink = (
	workload: {
		readonly workloadKind: WorkloadKind
		readonly workloadName: string
		readonly namespace: string
		readonly clusterName: string
	},
	time: TimeSearch,
): RuntimeLink => {
	const kind = workload.workloadKind
	return {
		key: `k8s|${workload.namespace}|${workload.workloadName}`,
		icon: "KubernetesIcon",
		label: WORKLOAD_LABEL[kind],
		name: workload.workloadName,
		location: present([workload.namespace, workload.clusterName]),
		href:
			kind === "unknown"
				? hrefOf(
						AppRoute.InfraKubernetesPods({
							search: {
								...time,
								namespaces: workload.namespace === "" ? undefined : [workload.namespace],
							},
						}),
					)
				: hrefOf(
						AppRoute.InfraKubernetesWorkload({
							kind,
							workloadName: workload.workloadName,
							search: {
								...time,
								namespace: workload.namespace === "" ? undefined : workload.namespace,
							},
						}),
					),
	}
}
