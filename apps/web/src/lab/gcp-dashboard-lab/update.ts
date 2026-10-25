import { OrgId } from "@maple/domain"
import { DashboardVariableSchema } from "@maple/domain/http"
import { Option, Result, Schema } from "effect"
import { fromString as urlFromString } from "foldkit/url"
import type { PageContext, PageOutMessage, PageReturn } from "../../page/contract"
import { Message } from "../../page/dashboards/view/message"
import type { Model } from "../../page/dashboards/view/model"
import { init as pageInit, routeChanged, update as pageUpdate } from "../../page/dashboards/view/update"
import { urlToAppRoute } from "../../route"
import { DASHBOARD, DASHBOARD_ID, OPTIONS } from "./fixture"

// The dashboards view over the template with no API: option lists answer from the fixture, a
// variables save rewrites the board here, and search changes (tabs, values) stay in the Model.

export const CONTEXT: PageContext = { orgId: OrgId.make("lab"), pinnedNamespace: null, timeZone: "UTC" }

type Commands = NonNullable<PageReturn<Model, Message>["commands"]>
type Step = Readonly<{ model: Model; commands: Commands }>

const OptionsArgs = Schema.Struct({ name: Schema.String, key: Schema.String })
const SaveArgs = Schema.Struct({ variables: Schema.Array(DashboardVariableSchema) })
const decodeOptionsArgs = Schema.decodeUnknownOption(OptionsArgs)
const decodeSaveArgs = Schema.decodeUnknownOption(SaveArgs)

/** The API reads and writes the board would make; the lab answers or drops them. */
const DROPPED = new Set(["FetchDashboardWidget", "FetchDashboardShares"])

const then = (acc: Step, next: Step): Step => ({ model: next.model, commands: [...acc.commands, ...next.commands] })

const answer = (model: Model, commands: Commands): Step =>
	commands.reduce<Step>((acc, command) => {
		if (command.name === "FetchDashboardVariableOptions")
			return Option.match(decodeOptionsArgs(command.args), {
				onNone: () => acc,
				onSome: ({ name, key }) =>
					then(acc, step(acc.model, Message.CompletedFetchVariableOptions({ name, key, result: Result.succeed(OPTIONS.get(name) ?? []) }))),
			})
		if (command.name === "SaveDashboardVariables")
			return Option.match(Option.all([decodeSaveArgs(command.args), Option.fromNullishOr(acc.model.document)]), {
				onNone: () => acc,
				onSome: ([{ variables }, document]) =>
					then(acc, step(acc.model, Message.UpdatedDashboard({ orgId: CONTEXT.orgId, maybeDocument: Option.some({ ...document, variables }) }))),
			})
		return DROPPED.has(command.name) ? acc : { ...acc, commands: [...acc.commands, command] }
	}, { model, commands: [] })

/** A navigation the page asks for re-enters its own route. */
const navigated = (model: Model, outMessage: PageOutMessage | undefined): PageReturn<Model, Message> => {
	if (outMessage?._tag !== "RequestedNavigation") return { model }
	return Option.match(urlFromString(new URL(outMessage.url, "http://localhost").href), {
		onNone: () => ({ model }),
		onSome: (parsed) => {
			const route = urlToAppRoute(parsed)
			return route._tag === "Dashboard"
				? routeChanged(model, { dashboardId: DASHBOARD_ID, search: route.search }, CONTEXT)
				: { model }
		},
	})
}

const step = (model: Model, message: Message): Step => {
	const next = pageUpdate(model, message, CONTEXT)
	const routed = navigated(next.model, next.outMessage)
	return answer(routed.model, [...(next.commands ?? []), ...(routed.commands ?? [])])
}

export const update = (model: Model, message: Message): Step => step(model, message)

export const init = (): Step => {
	const started = pageInit({ dashboardId: DASHBOARD_ID, search: {} }, CONTEXT)
	const loaded = step(started.model, Message.UpdatedDashboard({ orgId: CONTEXT.orgId, maybeDocument: Option.some(DASHBOARD) }))
	return { model: loaded.model, commands: [...(started.commands ?? []), ...loaded.commands] }
}
