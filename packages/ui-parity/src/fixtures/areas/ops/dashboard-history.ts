import { Effect, Schema } from "effect"
import { DashboardDocument, DashboardVersionNotFoundError } from "@maple/domain/http"
import { paginateArray, V2DashboardMutation, V2DashboardVersion, V2DashboardVersionDetail } from "@maple/domain/http/v2"
import { DashboardId, DashboardVersionId } from "@maple/domain/primitives"
import type { Dataset, EndpointHandler } from "../../dataset.ts"
import { acmeAdmin, DAY, HOUR, isoBefore, MINUTE } from "../../identity.ts"
import { str } from "./synthetic.ts"

// `dashboards.listVersions` / `retrieveVersion` / `restoreVersion`: every board has the same four
// saves, newest first; a snapshot is the live board minus its later widgets.

type Entry = Readonly<{
	id: string
	versionNumber: number
	changeKind: "created" | "widget_added" | "renamed" | "restored"
	changeSummary: string | null
	ageMs: number
	sourceVersionId: string | null
	/** How many of the live board's widgets the snapshot keeps. */
	widgetCount: number
}>

const ENTRIES: ReadonlyArray<Entry> = [
	{ id: "0192a3b4-0000-7000-8000-000000000004", versionNumber: 4, changeKind: "restored", changeSummary: "Restored from v2", ageMs: 20 * MINUTE, sourceVersionId: "0192a3b4-0000-7000-8000-000000000002", widgetCount: 99 },
	{ id: "0192a3b4-0000-7000-8000-000000000003", versionNumber: 3, changeKind: "renamed", changeSummary: null, ageMs: 5 * HOUR, sourceVersionId: null, widgetCount: 99 },
	{ id: "0192a3b4-0000-7000-8000-000000000002", versionNumber: 2, changeKind: "widget_added", changeSummary: "Added “Error rate”", ageMs: 2 * DAY, sourceVersionId: null, widgetCount: 3 },
	{ id: "0192a3b4-0000-7000-8000-000000000001", versionNumber: 1, changeKind: "created", changeSummary: null, ageMs: 12 * DAY, sourceVersionId: null, widgetCount: 1 },
]

const versionOf = (dashboardId: string, entry: Entry) => ({
	id: DashboardVersionId.make(entry.id),
	object: "dashboard_version" as const,
	dashboardId,
	versionNumber: entry.versionNumber,
	changeKind: entry.changeKind,
	changeSummary: entry.changeSummary,
	sourceVersionId: entry.sourceVersionId === null ? null : DashboardVersionId.make(entry.sourceVersionId),
	createdAt: isoBefore(entry.ageMs),
	createdBy: acmeAdmin.userId,
})

const encodeVersion = Schema.encodeUnknownEffect(V2DashboardVersion)
const encodeDetail = Schema.encodeUnknownEffect(V2DashboardVersionDetail)
const encodeMutation = Schema.encodeUnknownEffect(V2DashboardMutation)
const decodeDocument = Schema.decodeUnknownEffect(DashboardDocument)

const documentOf = (dataset: Dataset, id: string) =>
	decodeDocument((dataset.synced.dashboards ?? []).find((row) => row.id === id)?.payload_json)

const entryOf = (dashboardId: string, versionId: string) =>
	Effect.fromNullishOr(ENTRIES.find((entry) => entry.id === versionId)).pipe(
		Effect.mapError(
			() =>
				new DashboardVersionNotFoundError({
					dashboardId: DashboardId.make(dashboardId),
					versionId: DashboardVersionId.make(versionId),
					message: "No such dashboard version.",
				}),
		),
	)

const snapshotOf = (document: DashboardDocument, entry: Entry) => ({
	id: document.id,
	object: "dashboard" as const,
	name: document.name,
	description: document.description ?? null,
	tags: document.tags ?? [],
	timeRange: document.timeRange,
	widgets: document.widgets.slice(0, entry.widgetCount),
	sections: document.sections ?? [],
	variables: document.variables ?? [],
	refreshIntervalSeconds: document.refreshIntervalSeconds ?? null,
	createdAt: document.createdAt,
	updatedAt: isoBefore(entry.ageMs),
})

export const dashboardHistoryEndpoints = {
	"dashboards.listVersions": ({ params, query }) =>
		Effect.gen(function* () {
			const dashboardId = str(params, "id") ?? ""
			const versions = yield* Effect.forEach(ENTRIES, (entry) => encodeVersion(versionOf(dashboardId, entry)))
			const page = yield* paginateArray(versions, { limit: Number(str(query, "limit") ?? "100") })
			return { object: "list", ...page }
		}),
	"dashboards.retrieveVersion": ({ dataset, params }) =>
		Effect.gen(function* () {
			const dashboardId = str(params, "id") ?? ""
			const entry = yield* entryOf(dashboardId, str(params, "version_id") ?? "")
			const document = yield* documentOf(dataset, dashboardId)
			return yield* encodeDetail({ ...versionOf(dashboardId, entry), snapshot: snapshotOf(document, entry) })
		}),
	"dashboards.restoreVersion": ({ dataset, params }) =>
		Effect.gen(function* () {
			const dashboardId = str(params, "id") ?? ""
			const entry = yield* entryOf(dashboardId, str(params, "version_id") ?? "")
			const document = yield* documentOf(dataset, dashboardId)
			return yield* encodeMutation({ ...snapshotOf(document, entry), updatedAt: isoBefore(0), txid: "4242" })
		}),
} satisfies Readonly<Record<string, EndpointHandler>>
