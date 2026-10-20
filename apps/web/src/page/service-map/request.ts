import { DB_NODE_PREFIX, parseDbNodeId } from "@maple/ui/components/service-map/service-map-utils"
import { Option } from "effect"
import type { Command } from "foldkit"
import * as Keyed from "../../data/keyed"
import { requestKey } from "../../data/request-key"
import type { Resources } from "../../platform/resources"
import { AppRoute, hrefOf } from "../../route"
import type { PageContext, PageReturn } from "../contract"
import { PageOutMessage } from "../contract"
import {
	type DbSummaryInput,
	FetchBranchStats,
	FetchBundle,
	FetchCloudflare,
	FetchDbSummary,
	FetchFacets,
	FetchHyperdrives,
	FetchPlanetScaleInventory,
	FetchPlanetScaleStats,
	type MapInput,
	ResolveWindow,
} from "./command"
import { DEFAULT_PRESET, deploymentEnvOf, durationSecondsOf, type Search } from "./derive"
import type { Message, RequestMode } from "./message"
import type { Model } from "./model"

export type Return = PageReturn<Model, Message>

// The page's requests: one `Keyed` slot per read (S6), and its navigation.

type Step = Readonly<{
	patch: Partial<Model>
	commands: ReadonlyArray<Command.Command<Message, never, Resources>>
}>

/** One `Keyed.request`: `Some` writes the slot and returns its fetch (S6). */
const keyed = <A, E>(
	slot: Keyed.Keyed<A, E>,
	key: string,
	mode: Keyed.RequestMode,
	write: (next: Keyed.Keyed<A, E>) => Partial<Model>,
	fetch: (key: string) => Command.Command<Message, never, Resources>,
): Step =>
	Option.match(Keyed.request(slot, key, mode), {
		onNone: () => ({ patch: {}, commands: [] }),
		onSome: (next) => ({ patch: write(next), commands: [fetch(key)] }),
	})

export const applySteps = (model: Model, steps: ReadonlyArray<Step>): Return => ({
	model: steps.reduce<Model>((next, step) => ({ ...next, ...step.patch }), model),
	commands: steps.flatMap((step) => step.commands),
})

export const resolveCommand = (model: Model, context: PageContext, mode: RequestMode) =>
	ResolveWindow({
		mode,
		startTime: model.search.startTime,
		endTime: model.search.endTime,
		preset: model.search.timePreset ?? DEFAULT_PRESET,
		timeZone: context.timeZone,
	})

const NO_STEP: Step = { patch: {}, commands: [] }

export const facetsStep = (model: Model, context: PageContext, mode: RequestMode): Step => {
	const window = model.facetsWindow
	if (window === null) return NO_STEP
	return keyed(
		model.facets,
		requestKey(context.orgId, "getServicesFacets", { data: window }),
		mode,
		(facets) => ({ facets }),
		(key) => FetchFacets({ key, window, refresh: mode === "Refresh" }),
	)
}

/** The bundle follows the selected environment, which can move once facets land. */
export const bundleStep = (model: Model, context: PageContext, mode: RequestMode): Step => {
	if (model.window === null) return NO_STEP
	const deploymentEnv = deploymentEnvOf(model)
	const input: MapInput = {
		startTime: model.window.startTime,
		endTime: model.window.endTime,
		deploymentEnv,
	}
	return keyed(
		model.bundle,
		requestKey(context.orgId, "getServiceMapBundle", { data: input }),
		mode,
		(bundle) => ({ bundle }),
		(key) => FetchBundle({ key, input }),
	)
}

/** Cloudflare and PlanetScale metrics carry no environment: one env-less window for both. */
const overlaySteps = (model: Model, context: PageContext, mode: RequestMode): ReadonlyArray<Step> => {
	const window = model.window
	if (window === null) return []
	const org = context.orgId
	return [
		keyed(
			model.cloudflare,
			requestKey(org, "getServiceMapCloudflare", { data: window }),
			mode,
			(cloudflare) => ({ cloudflare }),
			(key) => FetchCloudflare({ key, window }),
		),
		keyed(
			model.planetscaleStats,
			requestKey(org, "getServiceMapPlanetScale", { data: window }),
			mode,
			(planetscaleStats) => ({ planetscaleStats }),
			(key) => FetchPlanetScaleStats({ key, window }),
		),
		keyed(
			model.planetscaleInventory,
			requestKey(org, "planetscaleIntegration.databases", {}),
			// `useAtomValue`, not page-refreshable: Reload leaves the inventories alone.
			"Load",
			(planetscaleInventory) => ({ planetscaleInventory }),
			(key) => FetchPlanetScaleInventory({ key }),
		),
		keyed(
			model.hyperdrives,
			requestKey(org, "integrations.cloudflareHyperdrives", {}),
			"Load",
			(hyperdrives) => ({ hyperdrives }),
			(key) => FetchHyperdrives({ key }),
		),
	]
}

/** `pickDbSummaryBucketSeconds`. */
const dbSummaryBucketSeconds = (durationSeconds: number): number =>
	durationSeconds <= 6 * 60 * 60
		? 5 * 60
		: durationSeconds <= 24 * 60 * 60
			? 15 * 60
			: durationSeconds <= 7 * 24 * 60 * 60
				? 60 * 60
				: 6 * 60 * 60

/** The selected database node, with its PlanetScale overlay when the inventory matched it. */
export const selectedDatabase = (model: Model) =>
	Option.flatMap(model.map, (map) =>
		Option.map(
			Option.filter(map.selectedId, (id) => id.startsWith(DB_NODE_PREFIX)),
			(id) => ({
				id,
				...parseDbNodeId(id),
				planetscale: map.source.rawNodes.find((node) => node.id === id)?.data.planetscale,
			}),
		),
	)

/** What `DatabaseDetailPanel` requests: the query summary, and the branches of a PlanetScale node. */
export const databaseSteps = (model: Model, context: PageContext, mode: RequestMode): ReadonlyArray<Step> => {
	const window = model.window
	const database = selectedDatabase(model)
	if (window === null || Option.isNone(database)) return []
	const { dbSystem, dbNamespace, planetscale } = database.value
	const deploymentEnv = deploymentEnvOf(model)
	const input: DbSummaryInput = {
		dbSystem,
		dbNamespace,
		startTime: window.startTime,
		endTime: window.endTime,
		deploymentEnv,
		bucketSeconds: dbSummaryBucketSeconds(durationSecondsOf(window)),
		topN: 8,
	}
	const branchInput =
		planetscale === undefined
			? null
			: { database: planetscale.database, startTime: window.startTime, endTime: window.endTime }
	return [
		keyed(
			model.dbSummary,
			requestKey(context.orgId, "getServiceDbQuerySummary", { data: input }),
			mode,
			(dbSummary) => ({ dbSummary }),
			(key) => FetchDbSummary({ key, input }),
		),
		...(branchInput === null
			? []
			: [
					keyed(
						model.branchStats,
						requestKey(context.orgId, "getPlanetScaleBranchStats", { data: branchInput }),
						mode,
						(branchStats) => ({ branchStats }),
						(key) => FetchBranchStats({ key, input: branchInput }),
					),
				]),
	]
}

/** Every query the page reads for the resolved windows, keyed by its inputs. */
export const requestAll = (model: Model, context: PageContext, mode: RequestMode): Return =>
	applySteps(model, [
		facetsStep(model, context, mode),
		bundleStep(model, context, mode),
		...overlaySteps(model, context, mode),
		...databaseSteps(model, context, mode),
	])

// NAVIGATION

export const navigate = (model: Model, search: Search, isReplace = false): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({
		url: hrefOf(AppRoute.ServiceMap({ search })),
		isReplace,
	}),
})

export const searchHref = (search: Search) => hrefOf(AppRoute.ServiceMap({ search }))
