import { gcpWorkloadSearch } from "../../../components/infra/gcp/tabs"
import { resourceSearch } from "../../infra-integrations/aws/derive"
import { AppRoute, hrefOf } from "../../../route"
import type { TimeSearch } from "../kit/view-tabs"
import type { FindingTarget, SourceId } from "./model"

// `FindingLink` and `SourceLink`, as hrefs.

export const findingHref = (target: FindingTarget, time: TimeSearch): string => {
	switch (target.kind) {
		case "hosts":
			return hrefOf(AppRoute.InfraHosts({ search: { ...time, scope: target.scope } }))
		case "host":
			return hrefOf(AppRoute.InfraHost({ hostName: target.hostName, search: time }))
		case "containers":
			return hrefOf(AppRoute.InfraContainers({ search: { ...time, scope: target.scope } }))
		case "pods":
			return hrefOf(AppRoute.InfraKubernetesPods({ search: { ...time, scope: target.scope } }))
		case "zone":
			return hrefOf(AppRoute.InfraCloudflareZone({ zoneName: target.zoneName, search: time }))
		case "railway":
			return hrefOf(
				AppRoute.InfraRailwayService({
					serviceId: target.serviceId,
					search: { ...time, environmentId: target.environmentId },
				}),
			)
		case "supabase":
			return hrefOf(AppRoute.InfraSupabaseProject({ projectRef: target.projectRef, search: time }))
		case "planetscale":
			return hrefOf(AppRoute.InfraPlanetscaleDatabase({ dbName: target.database, search: time }))
		case "gcpService":
			return hrefOf(AppRoute.InfraGcp({ search: { ...time, tab: target.service } }))
		case "gcp":
			return hrefOf(
				AppRoute.InfraGcpResource({
					service: target.service,
					name: target.keys[0] ?? "",
					search: { ...time, ...gcpWorkloadSearch(target.service, target.keys) },
				}),
			)
		case "aws":
			return hrefOf(
				AppRoute.InfraAwsResource({
					kind: target.resourceKind,
					name: target.name,
					search: { ...time, ...resourceSearch({ ...target, kind: target.resourceKind }) },
				}),
			)
	}
}

export const sourceHref = (id: SourceId, time: TimeSearch): string => {
	switch (id) {
		case "hosts":
			return hrefOf(AppRoute.InfraHosts({ search: time }))
		case "containers":
			return hrefOf(AppRoute.InfraContainers({ search: time }))
		case "kubernetes":
			return hrefOf(AppRoute.InfraKubernetesPods({ search: time }))
		case "cloudflare":
			return hrefOf(AppRoute.InfraCloudflare({ search: time }))
		case "railway":
			return hrefOf(AppRoute.InfraRailway({ search: time }))
		case "supabase":
			return hrefOf(AppRoute.InfraSupabase({ search: time }))
		case "planetscale":
			return hrefOf(AppRoute.InfraPlanetscale({ search: time }))
		case "gcp":
			return hrefOf(AppRoute.InfraGcp({ search: time }))
		case "aws":
			return hrefOf(AppRoute.InfraAws({ search: time }))
	}
}
