import { AsyncData } from "foldkit"
import * as Keyed from "@maple/views/data/keyed"
import { requestKey } from "@maple/views/data/request-key"
import { SignalPresenceData } from "@maple/views/data/signal-presence"
import { resolveWindow, type TimeWindow } from "../../../data/time-range"
import type { PageContext, PageReturn } from "../../contract"
import { keyed as keyedStep, runSteps, type Step as KitStep } from "../../kit/keyed-step"
import {
	CompleteReloadSpin,
	FetchMonitors,
	FetchSlos,
	FetchTopErrors,
	LoadSignalPresence,
	ReadClock,
	ResolveClock,
} from "./command"
import { Message, type RetryTarget } from "./message"
import { IncidentsData, type Model, RuleCountData } from "./model"

export type Return = PageReturn<Model, Message>
type Step = KitStep<Model, Message>

/** The window the top errors are counted over. */
export const ERRORS_WINDOW = "24h"

/** Nothing read yet: every section shows its skeleton. */
export const EMPTY: Model = {
	isEntered: false,
	nowMs: null,
	window: null,
	incidents: IncidentsData.Loading(),
	ruleCount: RuleCountData.Loading(),
	monitors: Keyed.idle(),
	slos: Keyed.idle(),
	errors: Keyed.idle(),
	presence: SignalPresenceData.Loading(),
	refreshVersion: 0,
	isReloading: false,
}

/** The last 24 hours, snapped to the cache grid until a Reload. */
const windowAt = (model: Model, context: PageContext, nowMs: number): TimeWindow =>
	resolveWindow(
		{ preset: ERRORS_WINDOW, snap: model.refreshVersion === 0, timeZone: context.timeZone },
		nowMs,
	)

/** Each read on its own slot, so one failing leaves the others on screen; a failure waits for a retry. */
const sync = (model: Model, context: PageContext, mode: Keyed.RequestMode): Return => {
	const { window } = model
	const steps: ReadonlyArray<(current: Model) => Step> = [
		(current) =>
			keyedStep(
				current.monitors,
				requestKey(context.orgId, "uptimeMonitors.list", {}),
				mode,
				(monitors) => ({ monitors }),
				(key) => FetchMonitors({ key }),
				{ keepFailure: true },
			),
		(current) =>
			keyedStep(
				current.slos,
				requestKey(context.orgId, "slos.listRows", {}),
				mode,
				(slos) => ({ slos }),
				(key) => FetchSlos({ key }),
				{ keepFailure: true },
			),
		...(window === null
			? []
			: [
					(current: Model): Step =>
						keyedStep(
							current.errors,
							requestKey(context.orgId, "analystHome.topErrors", window),
							mode,
							(errors) => ({ errors }),
							(key) => FetchTopErrors({ key, window }),
							{ keepFailure: true },
						),
				]),
	]
	return runSteps(model, steps)
}

/** Starts the reads once: `init` for a known analyst, else the page's Mount. */
export const enter = (model: Model, context: PageContext): Return => {
	if (model.isEntered) return { model }
	const synced = sync({ ...model, isEntered: true }, context, "Load")
	return {
		model: synced.model,
		commands: [ReadClock(), LoadSignalPresence({ orgId: context.orgId }), ...(synced.commands ?? [])],
	}
}

export const init = (context: PageContext): Return => enter(EMPTY, context)

/** Back after leaving: the last answers stay on screen while every read is asked again. */
export const revive = (model: Model, context: PageContext): Return =>
	model.isEntered
		? {
				model: {
					...model,
					refreshVersion: 0,
					isReloading: false,
					monitors: Keyed.forgetFailure(model.monitors),
					slos: Keyed.forgetFailure(model.slos),
					errors: Keyed.forgetFailure(model.errors),
				},
				commands: [ResolveClock()],
			}
		: enter(model, context)

const RETRY_SLOT = {
	Monitors: "monitors",
	Slos: "slos",
	Errors: "errors",
} as const satisfies Record<RetryTarget, keyof Model>

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		Entered: () => enter(model, context),
		CompletedReadClock: ({ nowMs }) =>
			sync({ ...model, nowMs, window: windowAt(model, context, nowMs) }, context, "Load"),
		CompletedResolveClock: ({ nowMs }) =>
			sync({ ...model, nowMs, window: windowAt(model, context, nowMs) }, context, "Refresh"),
		UpdatedIncidents: ({ orgId, rows }) =>
			orgId === context.orgId
				? { model: { ...model, incidents: IncidentsData.Success({ data: rows }) } }
				: { model },
		FailedLoadIncidents: ({ orgId }) =>
			orgId === context.orgId && AsyncData.isLoading(model.incidents)
				? { model: { ...model, incidents: IncidentsData.Failure({ error: "Unavailable" }) } }
				: { model },
		UpdatedRules: ({ orgId, count }) =>
			orgId === context.orgId
				? { model: { ...model, ruleCount: RuleCountData.Success({ data: count }) } }
				: { model },
		FailedLoadRules: ({ orgId }) =>
			orgId === context.orgId && AsyncData.isLoading(model.ruleCount)
				? { model: { ...model, ruleCount: RuleCountData.Failure({ error: "Unavailable" }) } }
				: { model },
		CompletedFetchMonitors: ({ key, result }) => ({
			model: { ...model, monitors: Keyed.accept(model.monitors, key, result) },
		}),
		CompletedFetchSlos: ({ key, result }) => ({
			model: { ...model, slos: Keyed.accept(model.slos, key, result) },
		}),
		CompletedFetchErrors: ({ key, result }) => ({
			model: { ...model, errors: Keyed.accept(model.errors, key, result) },
		}),
		CompletedLoadSignalPresence: ({ result }) => ({
			model: { ...model, presence: AsyncData.settle(model.presence, result) },
		}),
		ClickedReload: () => {
			const reloaded = { ...model, refreshVersion: model.refreshVersion + 1, isReloading: true }
			return {
				model: reloaded,
				commands: [ResolveClock(), CompleteReloadSpin({ version: reloaded.refreshVersion })],
			}
		},
		CompletedReloadSpin: ({ version }) =>
			version === model.refreshVersion ? { model: { ...model, isReloading: false } } : { model },
		// A failed slot keeps its failure under `Load`: forget it, so the next sync asks again.
		ClickedRetry: ({ target }) => sync({ ...model, [RETRY_SLOT[target]]: Keyed.idle() }, context, "Load"),
	})
