import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"

import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"

import { DocsLink } from "@/components/common/docs-link"
import { KubernetesIcon } from "@/components/icons"
import { ServiceLensShell } from "@/components/infra/service-lens/service-lens-shell"
import { useServiceLensRail } from "@/components/infra/service-lens/use-service-lens-rail"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { TimeRangeSearchFields, applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { sessionTimeRangeSearchMiddleware } from "@/components/time-range-picker/session-time-range"

/**
 * The lens with nothing selected.
 *
 * Deliberately not a redirect to the worst service: the rail is already sorted
 * worst-first, so the choice is one click away, and auto-navigating would make
 * the URL you land on depend on data that changes under you.
 */

const searchSchema = Schema.Struct(TimeRangeSearchFields)

export const Route = createFileRoute("/infra/kubernetes/services/")({
	component: ServiceLensIndexPage,
	validateSearch: Schema.toStandardSchemaV1(searchSchema),
	search: { middlewares: [sessionTimeRangeSearchMiddleware()] },
})

function ServiceLensIndexPage() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })

	const { startTime, endTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? "12h",
	)
	// Same atoms as the shell's rail, so this reads the cached result.
	const rail = useServiceLensRail({ startTime, endTime })

	return (
		<ServiceLensShell
			startTime={startTime}
			endTime={endTime}
			timeSearch={search}
			onTimeChange={(range, options) =>
				void navigate({
					replace: options?.replace,
					search: (prev) => ({ ...applyTimeRangeSearch(prev, range) }),
				})
			}
		>
			{!rail.loading && rail.services.length === 0 ? (
				<Empty className="py-24">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<KubernetesIcon size={16} />
						</EmptyMedia>
						<EmptyTitle>No linked services</EmptyTitle>
						<EmptyDescription>
							No services are linked to Kubernetes workloads yet. The Helm chart's k8sattributes
							processor tags spans with their workload.
						</EmptyDescription>
					</EmptyHeader>
					<DocsLink page="kubernetes" />
				</Empty>
			) : (
				<Empty className="py-24">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<KubernetesIcon size={16} />
						</EmptyMedia>
						<EmptyTitle>Pick a service</EmptyTitle>
						<EmptyDescription>
							This view answers one question: whether Kubernetes is why a service got slow. It
							needs a service to ask it about. The rail is sorted worst-first.
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			)}
		</ServiceLensShell>
	)
}
