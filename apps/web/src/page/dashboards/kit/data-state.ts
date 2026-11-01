import type { DashboardDocument } from "@maple/domain/http"
import { AsyncData } from "foldkit"
import type { Keyed } from "../../../data/keyed"
import {
	dataSourceTransform,
	isEmptyEnvelope,
	type ReadyData,
	toReadyData,
	type WidgetFailure,
	type WidgetGate,
} from "./widget-data"

// `WidgetDataState`, as `widget-data.ts` derives it.

type Widget = DashboardDocument["widgets"][number]

export type WidgetError = Readonly<{
	title: string | null
	message: string | null
	kind: "decode" | "runtime" | "range" | "empty" | "config" | null
}>

export type WidgetDataState =
	| { readonly _tag: "Loading" }
	| { readonly _tag: "Ready"; readonly data: ReadyData | null }
	| ({ readonly _tag: "Error" } & WidgetError)

const LOADING: WidgetDataState = { _tag: "Loading" }
const NO_DATA = "No data in this window"

export type RequestSlots = Readonly<Record<string, Keyed<unknown, WidgetFailure>>>

export const dataStateOf = (
	requests: RequestSlots,
	widget: Widget,
	gate: WidgetGate | null,
): WidgetDataState => {
	if (gate === null) return LOADING
	switch (gate._tag) {
		case "Static":
			return { _tag: "Ready", data: null }
		case "WaitingOnVariables":
			return LOADING
		case "Config":
			return { _tag: "Error", title: gate.title, message: gate.message, kind: "config" }
		case "Range":
			return { _tag: "Error", title: gate.title, message: gate.message, kind: "range" }
		case "Disabled":
			return { _tag: "Error", title: null, message: gate.message, kind: null }
		case "Request": {
			const request = requests[gate.request.key]
			if (request === undefined) return LOADING
			return AsyncData.match(request.data, {
				onIdle: () => LOADING,
				onLoading: () => LOADING,
				onFailure: (failure) => ({
					_tag: "Error",
					title: failure.title,
					message: failure.message,
					kind: failure.kind,
				}),
				onSuccess: (raw) => ready(raw, widget),
				onRefreshing: (raw) => ready(raw, widget),
				onStale: ({ data }) => ready(data, widget),
			})
		}
	}
}

const ready = (raw: unknown, widget: Widget): WidgetDataState =>
	isEmptyEnvelope(raw)
		? { _tag: "Error", title: null, message: NO_DATA, kind: "empty" }
		: { _tag: "Ready", data: toReadyData(raw, dataSourceTransform(widget.dataSource)) }

/** `dataState.status === "error"` drawn as the muted empty frame. */
export const isEmptyError = (state: WidgetDataState): boolean =>
	state._tag === "Error" && (state.kind === "empty" || state.message === NO_DATA)
