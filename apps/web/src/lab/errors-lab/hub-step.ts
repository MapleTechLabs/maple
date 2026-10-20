import { buildErrorsLabFixture } from "../errors-fixture"
import type { ErrorSignal } from "../../lib/models/error-signal"
import { OrgId } from "@maple/domain"
import { Option, Schema } from "effect"
import type { Command } from "foldkit"
import { fromString as urlFromString } from "foldkit/url"
import type { PageContext } from "../../page/contract"
import { severityOf, sortOf, sortSignals, viewCovers, viewOf } from "../../page/errors/hub/derive"
import type { Message as HubMessage } from "../../page/errors/hub/message"
import type { Model as HubModel } from "../../page/errors/hub/model"
import * as HubUpdate from "../../page/errors/hub/update"
import type { Resources } from "../../platform/resources"
import { urlToAppRoute } from "../../route"
import type { LabState } from "./model"

/** The hub runs against a fixture org; its window stays unresolved, so it never fetches the list. */
export const LAB_CONTEXT: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_lab_errors"),
	pinnedNamespace: null,
	timeZone: "UTC",
}

export const initHub = (nowMs: number): HubModel => ({
	...HubUpdate.init({ search: {} }, LAB_CONTEXT).model,
	nowMs,
})

/** The fixture through the lab state, then the view, severity and search filters, sorted. */
export const labSignals = (hub: HubModel, state: LabState): ReadonlyArray<ErrorSignal> => {
	if (state === "empty") return []
	const view = viewOf(hub.search)
	const severity = severityOf(hub.search)
	const term = (hub.search.q ?? "").toLowerCase()
	const signals = buildErrorsLabFixture(hub.nowMs).signals.filter(
		(signal) =>
			viewCovers(view, signal.issue.workflowState) &&
			(severity === "all" ||
				(severity === "unset" ? signal.severity === null : signal.severity === severity)) &&
			// Mirrors the server's ILIKE over type, message, label and service.
			(term === "" ||
				[
					signal.issue.exceptionType,
					signal.issue.exceptionMessage,
					signal.issue.errorLabel,
					signal.issue.serviceName,
				].some((field) => field.toLowerCase().includes(term))),
	)
	return sortSignals(signals, sortOf(hub.search))
}

export type HubStep = Readonly<{
	hub: HubModel
	commands: ReadonlyArray<Command.Command<HubMessage, never, Resources>>
}>

/** A navigation the hub asked for, applied to its own `search` the way a route change would. */
const followNavigation = (hub: HubModel, url: string): HubModel =>
	Option.match(urlFromString(new URL(url, "http://localhost").href), {
		onNone: () => hub,
		onSome: (parsed) => {
			const route = urlToAppRoute(parsed)
			return route._tag === "Errors" ? HubUpdate.routeChanged(hub, route, LAB_CONTEXT).model : hub
		},
	})

/** The hub's own update, its URL writes kept in the lab; the header checkbox reads the lab's rows. */
export const hubStep = (hub: HubModel, message: HubMessage, signals: ReadonlyArray<ErrorSignal>): HubStep => {
	if (message._tag === "ToggledAllRows") {
		const ids = signals.map((signal) => signal.id)
		const isAll = ids.length > 0 && ids.every((id) => hub.selectedIds.includes(id))
		const selectedIds = isAll ? [] : [...new Set([...hub.selectedIds, ...ids])]
		return { hub: { ...hub, selectedIds, selectionAnchor: null }, commands: [] }
	}
	const next = HubUpdate.update(hub, message, LAB_CONTEXT)
	const out = next.outMessage
	return {
		hub:
			out !== undefined && out._tag === "RequestedNavigation"
				? followNavigation(next.model, out.url)
				: next.model,
		commands: next.commands ?? [],
	}
}
