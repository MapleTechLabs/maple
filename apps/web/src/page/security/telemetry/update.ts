import * as Keyed from "../../../data/keyed"
import { requestKey } from "../../../data/request-key"
import type { AppRoute } from "../../../route"
import type { PageContext, PageReturn } from "../../contract"
import { chain, slotStep } from "../../kit/keyed-step"
import { FetchExposure, FetchRuntimes, ReadSecurityTelemetryClock } from "./command"
import { Message, type Model, type Tab } from "./model"

type Return = PageReturn<Model, Message>

export type SecurityTelemetryRoute = Extract<
	AppRoute,
	{ readonly _tag: "SecurityExposure" | "SecurityRuntimes" }
>

const tabOfRoute = (route: SecurityTelemetryRoute): Tab =>
	route._tag === "SecurityExposure" ? "exposure" : "runtimes"

const keyOf = (context: PageContext, operation: string) =>
	requestKey(context.orgId, `securityTelemetry.${operation}`, {})

const readExposure = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return =>
	slotStep(
		model,
		model.exposure,
		(exposure) => ({ exposure }),
		keyOf(context, "exposure"),
		mode,
		(key) => FetchExposure({ key, timeZone: context.timeZone }),
	)

const readRuntimes = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return =>
	slotStep(
		model,
		model.runtimes,
		(runtimes) => ({ runtimes }),
		keyOf(context, "runtimes"),
		mode,
		(key) => FetchRuntimes({ key, timeZone: context.timeZone }),
	)

/** The shown tab's own read; the other tab's waits until it is opened. */
const readTab = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return =>
	model.tab === "exposure" ? readExposure(model, context, mode) : readRuntimes(model, context, mode)

export const init = (route: SecurityTelemetryRoute, context: PageContext): Return => {
	const model: Model = {
		tab: tabOfRoute(route),
		nowMs: 0,
		exposure: Keyed.idle(),
		runtimes: Keyed.idle(),
	}
	return chain({ model, commands: [ReadSecurityTelemetryClock()] }, (next) =>
		readTab(next, context, "Load"),
	)
}

/** Same instance, other tab: a slot already read is kept, a first visit reads. */
export const routeChanged = (model: Model, route: SecurityTelemetryRoute, context: PageContext): Return =>
	readTab({ ...model, tab: tabOfRoute(route) }, context, "Load")

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match(message, {
		ReadClock: ({ nowMs }) => ({ model: { ...model, nowMs } }),
		CompletedFetchExposure: ({ key, result }) => ({
			model: { ...model, exposure: Keyed.accept(model.exposure, key, result) },
		}),
		CompletedFetchRuntimes: ({ key, result }) => ({
			model: { ...model, runtimes: Keyed.accept(model.runtimes, key, result) },
		}),
		ClickedRetry: () =>
			chain({ model, commands: [ReadSecurityTelemetryClock()] }, (next) =>
				readTab(next, context, "Refresh"),
			),
	})
