import { gcpFleet } from "../../../components/infra/gcp/tabs"
import { HOST_LIST_LIMIT } from "../../../components/infra/host-scopes"
import {
	summarizeCloudflare,
	summarizeContainers,
	summarizeGcp,
	summarizeHosts,
	summarizePlanetScale,
	summarizePods,
	summarizeRailway,
	summarizeSupabase,
} from "../../../components/infra/overview/summaries"
import { getCloudflareZones } from "@maple/web-data/warehouse/cloudflare-infra"
import { getAwsInfraFleet } from "@maple/web-data/warehouse/aws-infra"
import { getGcpInfraFleet } from "@maple/web-data/warehouse/gcp-infra"
import { containersSummary, listHosts, podsSummary } from "@maple/web-data/warehouse/infra"
import { getRailwayServices } from "@maple/web-data/warehouse/railway-infra"
import { getSupabaseProjects } from "@maple/web-data/warehouse/supabase-infra"
import { getServiceMapPlanetScale } from "@maple/web-data/warehouse/service-map"
import { Effect, Option, Schema } from "effect"
import { Command } from "foldkit"
import { IntegrationStatuses } from "../../../data/integration-statuses"
import { loadInfraPresence } from "../../../data/infra-surfaces"
import { toLoadFailure } from "../../../data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import { Message } from "./message"
import { SourceId, type SourceReading } from "./model"
import { summarizeAws } from "./summarize-aws"

// One read per source.

const reading = (summary: SourceReading["summary"]): SourceReading => ({ summary })

const read = (source: SourceId, window: TimeWindow) => {
	const data = { startTime: window.startTime, endTime: window.endTime }
	switch (source) {
		case "hosts":
			return Effect.map(listHosts({ data: { ...data, limit: HOST_LIST_LIMIT } }), (response) =>
				reading(summarizeHosts(response.data, window.endTime)),
			)
		case "containers":
			return Effect.map(containersSummary({ data }), (counts) =>
				reading(summarizeContainers(counts)),
			)
		case "kubernetes":
			return Effect.map(podsSummary({ data }), (counts) =>
				reading(summarizePods(counts)),
			)
		case "cloudflare":
			return Effect.map(getCloudflareZones({ data }), ({ zones }) =>
				reading(summarizeCloudflare(zones)),
			)
		case "railway":
			return Effect.map(getRailwayServices({ data }), ({ services }) =>
				reading(summarizeRailway(services)),
			)
		// Discovery names the projects; without it the findings fall back to refs.
		case "supabase":
			return Effect.gen(function* () {
				const { projects } = yield* getSupabaseProjects({ data })
				const status = yield* Effect.option((yield* IntegrationStatuses).supabase())
				const names = new Map(
					Option.match(status, {
						onNone: () => [],
						onSome: ({ projects: discovered }) =>
							discovered.map((project): readonly [string, string] => [project.ref, project.name]),
					}),
				)
				return reading(summarizeSupabase(projects, names))
			})
		case "planetscale":
			return Effect.map(getServiceMapPlanetScale({ data }), ({ databases }) =>
				reading(summarizePlanetScale(databases)),
			)
		case "gcp":
			return Effect.map(getGcpInfraFleet({ data }), ({ services }) =>
				reading(summarizeGcp(gcpFleet(services))),
			)
		case "aws":
			return Effect.map(getAwsInfraFleet({ data }), ({ kinds }) => reading(summarizeAws(kinds)))
	}
}

/** `infraPresenceResultAtom({ data: window })`, one cache entry with the sidebar's when the windows match. */
export const FetchPresence = Command.define("FetchInfraOverviewPresence", {
	args: { orgId: Schema.String, key: Schema.String, window: TimeWindow },
	messages: [Message.CompletedFetchPresence],
	execute: ({ orgId, key, window }) =>
		loadInfraPresence(orgId, window).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchPresence({ key, result })),
		),
})

export const FetchSource = Command.define("FetchInfraOverviewSource", {
	args: { source: SourceId, key: Schema.String, window: TimeWindow },
	messages: [Message.CompletedFetchSource],
	execute: ({ source, key, window }) =>
		read(source, window).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchSource({ source, key, result })),
		),
})
