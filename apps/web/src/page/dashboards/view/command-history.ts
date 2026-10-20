import { DashboardDocument, DashboardId, DashboardVersionId } from "@maple/domain/http"
import type { V2Dashboard } from "@maple/domain/http/v2"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { toLoadFailure } from "../../../data/load-failure"
import { MapleApiV2Client } from "../../../platform/api-clients"
import { errorMessageOf } from "../kit/store"
import { Message } from "./message"

// `useDashboardVersions`, `useDashboardVersionDetail` and `useRestoreDashboardVersion`.

const decodeDashboardId = Schema.decodeUnknownEffect(DashboardId)
const decodeVersionId = Schema.decodeUnknownEffect(DashboardVersionId)
const decodeDocument = Schema.decodeUnknownEffect(DashboardDocument)

/** A version's snapshot read as the board document the canvas renders. */
export const documentOf = (snapshot: V2Dashboard) =>
	decodeDocument({
		id: snapshot.id,
		name: snapshot.name,
		...(snapshot.description === null ? undefined : { description: snapshot.description }),
		tags: snapshot.tags,
		timeRange: snapshot.timeRange,
		widgets: snapshot.widgets,
		sections: snapshot.sections,
		variables: snapshot.variables,
		...(snapshot.refreshIntervalSeconds === null
			? undefined
			: { refreshIntervalSeconds: snapshot.refreshIntervalSeconds }),
		createdAt: snapshot.createdAt,
		updatedAt: snapshot.updatedAt,
	})

export const FetchVersions = Command.define("FetchDashboardVersions", {
	args: { dashboardId: Schema.String, generation: Schema.Number },
	messages: [Message.CompletedFetchVersions],
	execute: ({ dashboardId, generation }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const id = yield* decodeDashboardId(dashboardId)
			const page = yield* client.dashboards.listVersions({ params: { id }, query: { limit: 100 } })
			return page.data.map((version) => ({
				id: version.id,
				versionNumber: version.versionNumber,
				changeKind: version.changeKind,
				changeSummary: version.changeSummary,
				isRestore: version.sourceVersionId !== null,
				createdAt: version.createdAt,
				createdBy: version.createdBy,
			}))
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchVersions({ generation, result })),
		),
})

export const FetchSnapshot = Command.define("FetchDashboardVersionSnapshot", {
	args: { dashboardId: Schema.String, versionId: Schema.String },
	messages: [Message.CompletedFetchSnapshot],
	execute: ({ dashboardId, versionId }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const id = yield* decodeDashboardId(dashboardId)
			const version_id = yield* decodeVersionId(versionId)
			const detail = yield* client.dashboards.retrieveVersion({ params: { id, version_id } })
			return yield* documentOf(detail.snapshot)
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchSnapshot({ versionId, result })),
		),
})

export const RestoreVersion = Command.define("RestoreDashboardVersion", {
	args: { dashboardId: Schema.String, versionId: Schema.String, versionNumber: Schema.Number },
	messages: [Message.CompletedRestore],
	execute: ({ dashboardId, versionId, versionNumber }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const id = yield* decodeDashboardId(dashboardId)
			const version_id = yield* decodeVersionId(versionId)
			yield* client.dashboards.restoreVersion({ params: { id, version_id } })
		}).pipe(
			Effect.match({
				onFailure: (error) => Message.CompletedRestore({ versionNumber, error: errorMessageOf(error) }),
				onSuccess: () => Message.CompletedRestore({ versionNumber, error: null }),
			}),
		),
})
