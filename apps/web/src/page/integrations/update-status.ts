import { Option, Array as Arr } from "effect"
import * as Keyed from "@maple/views/data/keyed"
import type { LoadFailure } from "@maple/views/data/load-failure"
import type { PageContext, PageReturn } from "../contract"
import { integrationStatusKey } from "../kit/integration-status-keys"
import { STATUS_READS } from "./command"
import type { Message } from "./message"
import type { Model, Statuses } from "./model"

type Return = PageReturn<Model, Message>

export const statusKey = (context: PageContext, name: keyof Statuses) =>
	integrationStatusKey(context.orgId, name)

/** `Keyed.requestFor`, keeping the slot's own type: the slot to store and the key to fetch with. */
const requestSlot = <S extends Keyed.Keyed<unknown, LoadFailure>>(
	slot: S,
	key: string,
	mode: Keyed.ReadMode,
): Option.Option<Readonly<{ slot: S; key: string }>> =>
	Option.map(Keyed.requestFor<unknown, LoadFailure>(slot, key, mode), (requested) => ({
		slot: { ...slot, ...requested },
		key: requested.key,
	}))

/** Requests one status read; a write's `reactivityKeys` re-read it with `Supersede`, a timer with `Refresh`. */
export const requestStatus = <K extends keyof Statuses>(
	model: Model,
	context: PageContext,
	name: K,
	mode: Keyed.ReadMode,
): Return =>
	Option.match(requestSlot(model.statuses[name], statusKey(context, name), mode), {
		onNone: () => ({ model }),
		onSome: (requested) => ({
			model: { ...model, statuses: { ...model.statuses, [name]: requested.slot } },
			commands: [STATUS_READS[name]({ key: requested.key, refresh: mode !== "Load" })],
		}),
	})

/** Runs steps in order, threading the Model and collecting their Commands and last OutMessage. */
export const chain = (model: Model, steps: ReadonlyArray<(model: Model) => Return>): Return =>
	Arr.reduce<(typeof steps)[number], Return>(steps, { model }, (acc, next) => {
		const result = next(acc.model)
		return {
			model: result.model,
			commands: [...(acc.commands ?? []), ...(result.commands ?? [])],
			outMessage: result.outMessage ?? acc.outMessage,
		}
	})

/** The reads the page makes for this viewer: data sources only behind their flag. */
export const statusNamesOf = (model: Pick<Model, "hasDataSources">): ReadonlyArray<keyof Statuses> =>
	model.hasDataSources ? [...STATUS_NAMES, "dataSources"] : STATUS_NAMES

/** Every always-on status read; `dataSources` waits on its flag (`statusNamesOf`). */
export const STATUS_NAMES: ReadonlyArray<keyof Statuses> = [
	"cloudflare",
	"railway",
	"planetscale",
	"planetscaleDatabases",
	"gcp",
	"aws",
	"supabase",
	"linear",
	"github",
	"searchConsole",
	"chat",
	"scrapeTargets",
]
