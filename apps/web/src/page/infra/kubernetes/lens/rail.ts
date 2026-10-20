import { getServiceOverview } from "@maple/web-data/warehouse/services"
import { getServiceWorkloads } from "@maple/web-data/warehouse/service-infra"
import { Effect, Schema } from "effect"
import { AsyncData, Command } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import * as Keyed from "../../../../data/keyed"
import { KeyedSchema } from "../../../../data/keyed"
import { LoadFailure, toLoadFailure } from "../../../../data/load-failure"
import { requestKey } from "../../../../data/request-key"
import type { TimeWindow } from "../../../../data/time-range"
import type { PageContext } from "../../../contract"
import type { Resources } from "../../../../platform/resources"
import { applySteps, keyed } from "../../kit/requests"

// `useServiceLensRail` (components/infra/service-lens/use-service-lens-rail.ts): the services with
// a Kubernetes workload, in two hops (the service overview's names, then `serviceWorkloads`).

export const ServiceWorkload = Schema.Struct({
	serviceName: Schema.String,
	workloadKind: Schema.Literals(["deployment", "statefulset", "daemonset", "unknown"]),
	workloadName: Schema.String,
	namespace: Schema.String,
	clusterName: Schema.String,
	podCount: Schema.Number,
	avgCpuLimitUtilization: Schema.NullOr(Schema.Number),
	avgMemoryLimitUtilization: Schema.NullOr(Schema.Number),
})
export type ServiceWorkload = typeof ServiceWorkload.Type
export const ServiceWorkloads = Schema.Array(ServiceWorkload)

export const Model = Schema.Struct({
	/** The overview's distinct service names, sorted. */
	names: KeyedSchema(Schema.Array(Schema.String), LoadFailure),
	workloads: KeyedSchema(ServiceWorkloads, LoadFailure),
})
export type Model = typeof Model.Type

export const init = (): Model => ({ names: Keyed.idle(), workloads: Keyed.idle() })

export const Message = defineMessageUnion({
	CompletedFetchNames: { key: Schema.String, result: Schema.Result(Schema.Array(Schema.String), LoadFailure) },
	CompletedFetchWorkloads: { key: Schema.String, result: Schema.Result(ServiceWorkloads, LoadFailure) },
})
export type Message = typeof Message.Type

export const NamesInput = Schema.Struct({
	startTime: Schema.String,
	endTime: Schema.String,
	namespaces: Schema.optionalKey(Schema.Array(Schema.String)),
})
export type NamesInput = typeof NamesInput.Type

/** `getServiceOverviewResultAtom` is `globalNamespace: "top"`: the pin goes into the payload and key. */
export const namesInput = (window: TimeWindow, pinnedNamespace: string | null): NamesInput =>
	pinnedNamespace === null
		? { startTime: window.startTime, endTime: window.endTime }
		: { startTime: window.startTime, endTime: window.endTime, namespaces: [pinnedNamespace] }

export const FetchNames = Command.define("FetchLensServiceNames", {
	args: { key: Schema.String, input: NamesInput },
	messages: [Message.CompletedFetchNames],
	execute: ({ key, input }) =>
		getServiceOverview({
			data:
				input.namespaces === undefined
					? { startTime: input.startTime, endTime: input.endTime }
					: { startTime: input.startTime, endTime: input.endTime, namespaces: [...input.namespaces] },
		}).pipe(
			Effect.map((response) => [...new Set(response.data.map((row) => row.serviceName))].sort()),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchNames({ key, result })),
		),
})

export const WorkloadsInput = Schema.Struct({
	services: Schema.Array(Schema.String),
	startTime: Schema.String,
	endTime: Schema.String,
})
export type WorkloadsInput = typeof WorkloadsInput.Type

/** `getServiceWorkloadsResultAtom`: an empty list answers locally, sending nothing. */
export const fetchServiceWorkloads = (input: WorkloadsInput) =>
	getServiceWorkloads({ data: { ...input, services: [...input.services] } }).pipe(
		Effect.map((response) => response.workloads),
		Effect.mapError(toLoadFailure),
		Effect.result,
	)

export const FetchWorkloads = Command.define("FetchLensServiceWorkloads", {
	args: { key: Schema.String, input: WorkloadsInput },
	messages: [Message.CompletedFetchWorkloads],
	execute: ({ key, input }) =>
		Effect.map(fetchServiceWorkloads(input), (result) => Message.CompletedFetchWorkloads({ key, result })),
})

export type Return = Readonly<{ model: Model; commands: ReadonlyArray<Command.Command<Message, never, Resources>> }>

const workloadsStep = (model: Model, context: PageContext, window: TimeWindow, mode: Keyed.RequestMode) => {
	const input = { services: AsyncData.getOrElse(model.names.data, () => []), ...window }
	return keyed<Model, Message, ReadonlyArray<ServiceWorkload>, LoadFailure>(
		model.workloads,
		requestKey(context.orgId, "getServiceWorkloads", { data: input }),
		mode,
		(workloads) => ({ workloads }),
		(key) => FetchWorkloads({ key, input }),
	)
}

/** The names for the window, and the join over whatever names are known (empty until they land). */
export const request = (model: Model, context: PageContext, window: TimeWindow, mode: Keyed.RequestMode): Return => {
	const input = namesInput(window, context.pinnedNamespace)
	return applySteps<Model, Message>(model, [
		keyed(
			model.names,
			requestKey(context.orgId, "getServiceOverview", { data: input }),
			mode,
			(names) => ({ names }),
			(key) => FetchNames({ key, input }),
		),
		workloadsStep(model, context, window, mode),
	])
}

export const update = (model: Model, message: Message, context: PageContext, window: TimeWindow | null): Return =>
	Message.match<Return>(message, {
		CompletedFetchNames: ({ key, result }) => {
			const next = { ...model, names: Keyed.accept(model.names, key, result) }
			return window === null ? { model: next, commands: [] } : applySteps<Model, Message>(next, [workloadsStep(next, context, window, "Load")])
		},
		CompletedFetchWorkloads: ({ key, result }) => ({
			model: { ...model, workloads: Keyed.accept(model.workloads, key, result) },
			commands: [],
		}),
	})
