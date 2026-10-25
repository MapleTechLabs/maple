import { AttributeMappingPublicId, RecommendationPublicId } from "@maple/domain/http/v2"
import { readLocalStorage } from "@maple/ui/lib/local-storage"
import { collectV2Pages } from "@maple/web-data/lib/v2-pagination"
import { getServiceOverview } from "@maple/web-data/warehouse/services"
import { Clock, Effect, Option, type Result, Schema } from "effect"
import { Command } from "foldkit"
import { type LoadFailure, toLoadFailure } from "../../../data/load-failure"
import { resolveWindow } from "../../../data/time-range"
import { MapleApiV2Client } from "../../../platform/api-clients"
import { Message } from "./message"
import { IngestKeyKind } from "./model"

const PAGE_LIMIT = 100

const settle = <A, B>(toMessage: (result: Result.Result<A, LoadFailure>) => B) =>
	<E, R>(effect: Effect.Effect<A, E, R>) =>
		effect.pipe(Effect.mapError(toLoadFailure), Effect.result, Effect.map(toMessage))

/** `useIngestConnection`: the last hour's service overview, snapped like `useEffectiveTimeRange`. */
export const FetchIngestOverview = Command.define("FetchIngestOverview", {
	args: { timeZone: Schema.String, pinnedNamespace: Schema.NullOr(Schema.String) },
	messages: [Message.CompletedFetchOverview],
	execute: ({ timeZone, pinnedNamespace }) =>
		Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis
			const window = resolveWindow({ preset: "1h", snap: true, timeZone }, now)
			// `applyGlobalNamespace(input, "top")`: a pinned namespace narrows the overview.
			const range = { startTime: window.startTime, endTime: window.endTime }
			const response = yield* getServiceOverview({
				data: pinnedNamespace === null ? range : { ...range, namespaces: [pinnedNamespace] },
			})
			return response.data.map((row) => ({ serviceName: String(row.serviceName), spanCount: row.spanCount ?? 0 }))
		}).pipe(settle((result) => Message.CompletedFetchOverview({ result }))),
})

export const FetchIngestionKeys = Command.define("FetchIngestionKeys", {
	messages: [Message.CompletedFetchIngestKeys],
	execute: Effect.flatMap(MapleApiV2Client, (client) => client.ingestKeys.retrieve()).pipe(
		settle((result) => Message.CompletedFetchIngestKeys({ result })),
	),
})

/** `ingestKeys.rollPublic` / `rollPrivate`: the previous key stops working immediately. */
export const RollIngestKey = Command.define("RollIngestKey", {
	args: { kind: IngestKeyKind },
	messages: [Message.CompletedRollKey],
	execute: ({ kind }) =>
		Effect.flatMap(MapleApiV2Client, (client) =>
			kind === "public" ? client.ingestKeys.rollPublic() : client.ingestKeys.rollPrivate(),
		).pipe(
			Effect.asVoid,
			settle((result) => Message.CompletedRollKey({ kind, result })),
		),
})

/** `recommendationIssuesListAtom`: every page. */
export const FetchRecommendations = Command.define("FetchRecommendations", {
	messages: [Message.CompletedFetchRecommendations],
	execute: Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		return yield* collectV2Pages((cursor) =>
			client.instrumentationRecommendations.list({
				query: cursor === undefined ? { limit: PAGE_LIMIT } : { limit: PAGE_LIMIT, cursor },
			}),
		)
	}).pipe(settle((result) => Message.CompletedFetchRecommendations({ result }))),
})

/** `ingestAttributeMappingsListAtom`: every page. */
export const FetchMappings = Command.define("FetchAttributeMappings", {
	messages: [Message.CompletedFetchMappings],
	execute: Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		return yield* collectV2Pages((cursor) =>
			client.attributeMappings.list({
				query: cursor === undefined ? { limit: PAGE_LIMIT } : { limit: PAGE_LIMIT, cursor },
			}),
		)
	}).pipe(settle((result) => Message.CompletedFetchMappings({ result }))),
})

// QUICK-START FRAMEWORK (`quickStartAtomFamily`, an `Atom.kvs` JSON entry)

const quickStartKey = (orgKey: string) => `maple-onboarding-v6-${orgKey}`
const QuickStart = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
const decodeQuickStart = Schema.decodeUnknownOption(QuickStart)
const DEFAULT_QUICK_START = {
	completedSteps: {},
	dismissed: false,
	selectedFramework: null,
	activeStep: "role",
	qualifyAnswers: { role: null, roleDetail: "", intents: [] },
	checklistDismissed: false,
	checklistExpanded: true,
}

const readQuickStart = (orgKey: string) =>
	Option.flatMap(readLocalStorage(quickStartKey(orgKey)), (raw) => decodeQuickStart(raw))

export const ReadFramework = Command.define("ReadQuickStartFramework", {
	args: { orgKey: Schema.String },
	messages: [Message.ReadFramework],
	execute: ({ orgKey }) =>
		Effect.sync(() => {
			const selected = Option.flatMap(readQuickStart(orgKey), (state) =>
				typeof state.selectedFramework === "string" ? Option.some(state.selectedFramework) : Option.none(),
			)
			return Message.ReadFramework({ framework: Option.getOrNull(selected) })
		}),
})

export const SaveFramework = Command.define("SaveQuickStartFramework", {
	args: { orgKey: Schema.String, framework: Schema.String },
	messages: [Message.CompletedSaveFramework],
	execute: ({ orgKey, framework }) =>
		Effect.sync(() => {
			const current = Option.getOrElse(readQuickStart(orgKey), () => DEFAULT_QUICK_START)
			localStorage.setItem(quickStartKey(orgKey), JSON.stringify({ ...current, selectedFramework: framework }))
		}).pipe(Effect.ignore, Effect.as(Message.CompletedSaveFramework())),
})

// WRITES

export const ApplyRecommendation = Command.define("ApplyRecommendation", {
	args: { id: RecommendationPublicId, sourceKey: Schema.String, canonicalKey: Schema.String },
	messages: [Message.CompletedRecommendationAction],
	execute: ({ id, sourceKey, canonicalKey }) =>
		Effect.flatMap(MapleApiV2Client, (client) =>
			client.attributeMappings.create({
				payload: {
					name: `Rename ${sourceKey} → ${canonicalKey}`,
					source_context: "span",
					source_key: sourceKey,
					target_key: canonicalKey,
					operation: "copy",
				},
			}),
		).pipe(
			Effect.asVoid,
			settle((result) =>
				Message.CompletedRecommendationAction({ id, action: "apply", label: `${sourceKey} → ${canonicalKey}`, result }),
			),
		),
})

export const TriageRecommendation = Command.define("TriageRecommendation", {
	args: { id: RecommendationPublicId, action: Schema.Literals(["dismiss", "reopen"]) },
	messages: [Message.CompletedRecommendationAction],
	execute: ({ id, action }) =>
		Effect.flatMap(MapleApiV2Client, (client) =>
			action === "dismiss"
				? client.instrumentationRecommendations.dismiss({ params: { id } })
				: client.instrumentationRecommendations.reopen({ params: { id } }),
		).pipe(
			Effect.asVoid,
			settle((result) => Message.CompletedRecommendationAction({ id, action, label: "", result })),
		),
})

export const ToggleMapping = Command.define("ToggleAttributeMapping", {
	args: { id: AttributeMappingPublicId, isEnabled: Schema.Boolean },
	messages: [Message.CompletedToggleMapping],
	execute: ({ id, isEnabled }) =>
		Effect.flatMap(MapleApiV2Client, (client) =>
			client.attributeMappings.update({ params: { id }, payload: { enabled: isEnabled } }),
		).pipe(
			Effect.asVoid,
			settle((result) => Message.CompletedToggleMapping({ id, result })),
		),
})

export const DeleteMapping = Command.define("DeleteAttributeMapping", {
	args: { id: AttributeMappingPublicId },
	messages: [Message.CompletedDelete],
	execute: ({ id }) =>
		Effect.flatMap(MapleApiV2Client, (client) => client.attributeMappings.delete({ params: { id } })).pipe(
			Effect.asVoid,
			settle((result) => Message.CompletedDelete({ result })),
		),
})
