import { ServiceName } from "@maple/domain/http"
import { Option, Schema } from "effect"
import { fromString } from "foldkit/url"
import { describe, expect, test } from "vitest"
import { urlToAppRoute } from "../../route"
import { runtimeLink, type ServiceRuntime, workloadLink } from "./service-runtimes"

const runtime = ({
	name,
	...overrides
}: Partial<Omit<ServiceRuntime, "serviceName">> & Pick<ServiceRuntime, "kind"> & { readonly name: string }): ServiceRuntime => ({
	serviceName: Schema.decodeSync(ServiceName)(name),
	account: "",
	region: "",
	cluster: "",
	railwayServiceId: "",
	railwayEnvironmentId: "",
	railwayEnvironmentName: "",
	...overrides,
})

const TIME = { timePreset: "1h" }
const routeOf = (href: string) => urlToAppRoute(Option.getOrThrow(fromString(`https://app.maple.dev${href}`)))

describe("runtimeLink", () => {
	test("a Cloud Run service opens its Google Cloud page, scoped to its project and region", () => {
		const link = runtimeLink(
			runtime({ kind: "cloudRun", name: "fleet-api", account: "fleet-prod", region: "europe-west1" }),
			TIME,
		)
		expect(routeOf(link.href)).toMatchObject({
			_tag: "InfraGcpResource",
			service: "cloudRun",
			name: "fleet-api",
			search: { project: "fleet-prod", region: "europe-west1", timePreset: "1h" },
		})
		expect(link.location).toEqual(["fleet-prod", "europe-west1"])
	})

	test("an ECS service carries its cluster; a Lambda function its region and account", () => {
		expect(
			routeOf(
				runtimeLink(
					runtime({
						kind: "ecs",
						name: "checkout",
						cluster: "prod",
						region: "us-east-1",
						account: "1234",
					}),
					TIME,
				).href,
			),
		).toMatchObject({
			_tag: "InfraAwsResource",
			kind: "ecs",
			name: "checkout",
			search: { cluster: "prod", region: "us-east-1", account: "1234" },
		})
		const lambda = routeOf(
			runtimeLink(runtime({ kind: "lambda", name: "resize", region: "us-east-1" }), TIME).href,
		)
		expect(lambda).toMatchObject({ _tag: "InfraAwsResource", kind: "lambda", name: "resize" })
		expect(lambda).not.toMatchObject({ search: { cluster: expect.anything() } })
	})

	test("a Railway service opens by its id in its environment, named by the environment", () => {
		const link = runtimeLink(
			runtime({
				kind: "railway",
				name: "fleet-worker",
				railwayServiceId: "svc_1",
				railwayEnvironmentId: "env_prod",
				railwayEnvironmentName: "production",
			}),
			TIME,
		)
		expect(routeOf(link.href)).toMatchObject({
			_tag: "InfraRailwayService",
			serviceId: "svc_1",
			search: { environmentId: "env_prod" },
		})
		expect(link.location).toEqual(["production"])
	})

	test("a Worker opens under its script name, pinned to its account", () => {
		const link = runtimeLink(
			runtime({ kind: "cloudflareWorker", name: "edge-router", account: "cf1" }),
			TIME,
		)
		expect(routeOf(link.href)).toMatchObject({
			_tag: "InfraCloudflareWorker",
			scriptName: "edge-router",
			search: { account: "cf1" },
		})
		expect(link.location).toEqual([])
	})

	test("the same resource in two environments keeps two keys", () => {
		const env = (id: string) =>
			runtimeLink(
				runtime({ kind: "railway", name: "w", railwayServiceId: "s", railwayEnvironmentId: id }),
				TIME,
			)
		expect(env("a").key).not.toBe(env("b").key)
	})
})

describe("workloadLink", () => {
	test("a deployment opens its workload page in its namespace", () => {
		const link = workloadLink(
			{ workloadKind: "deployment", workloadName: "api", namespace: "shop", clusterName: "prod" },
			TIME,
		)
		expect(routeOf(link.href)).toMatchObject({
			_tag: "InfraKubernetesWorkload",
			kind: "deployment",
			workloadName: "api",
			search: { namespace: "shop" },
		})
	})

	test("a workload of unknown kind falls back to its namespace's pods", () => {
		const link = workloadLink(
			{ workloadKind: "unknown", workloadName: "api", namespace: "shop", clusterName: "" },
			TIME,
		)
		expect(routeOf(link.href)).toMatchObject({
			_tag: "InfraKubernetesPods",
			search: { namespaces: ["shop"] },
		})
	})
})
