import { formatWarehouseDateTime } from "@maple/query-engine"
import { getServiceDeploys } from "@maple/web-data/warehouse/service-deploys"
import { getServiceOperations } from "@maple/web-data/warehouse/service-operations"
import { Effect, Option, Schema, Array as Arr } from "effect"
import { Command, type Update } from "foldkit"
import * as Keyed from "@maple/views/data/keyed"
import { settleTo } from "@maple/views/data/load-failure"
import { requestKey } from "@maple/views/data/request-key"
import * as Dialog from "@maple/views/ui/dialog"
import type { TimeWindow } from "../../../../data/time-range"
import type { Resources } from "../../../../platform/resources"
import type { PageContext } from "../../../contract"
import type { DeployCheck } from "../derive-deploys"
import { Message, OutMessage, type Side } from "./message"
import type { Model } from "./model"

export type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage, Resources>

/** What the drawer's reads are scoped by besides the deploy. */
export type DeployScope = Readonly<{
	context: PageContext
	serviceName: string
	/** The page's window: where the commit's other deploys are looked for. */
	window: TimeWindow | null
	/** Where the page's read stops, so the after side never reaches past it. */
	dataEndMs: number
}>

export const OPERATIONS_LIMIT = 50

export const OperationsInput = Schema.Struct({
	serviceName: Schema.String,
	startTime: Schema.String,
	endTime: Schema.String,
	environments: Schema.optional(Schema.Array(Schema.String)),
	bucketSeconds: Schema.Number,
	limit: Schema.Number,
})
export type OperationsInput = typeof OperationsInput.Type

export const FetchDeployOperations = Command.define("FetchServiceDeployOperations", {
	args: { side: Schema.Literals(["before", "after"]), key: Schema.String, input: OperationsInput },
	messages: [Message.CompletedFetchOperations],
	execute: ({ side, key, input }) =>
		getServiceOperations({ data: input }).pipe(
			Effect.map((response) => response.operations),
			settleTo((result) => Message.CompletedFetchOperations({ side, key, result })),
		),
})

export const ShippedInput = Schema.Struct({
	commitSha: Schema.String,
	startTime: Schema.String,
	endTime: Schema.String,
})
export type ShippedInput = typeof ShippedInput.Type

export const FetchShipped = Command.define("FetchServiceDeployShipped", {
	args: { key: Schema.String, input: ShippedInput },
	messages: [Message.CompletedFetchShipped],
	execute: ({ key, input }) =>
		getServiceDeploys({ data: input }).pipe(
			Effect.map((response) => ({ ...response, readUntil: input.endTime })),
			settleTo((result) => Message.CompletedFetchShipped({ key, result })),
		),
})

const MINUTE_MS = 60_000

/**
 * Seconds of traffic the after side holds: from the deploy's minute to where the read stops, at
 * most the window. A deploy 90 seconds in holds 90, not one floored minute; a few seconds at least.
 */
export const afterSeconds = (
	check: Pick<DeployCheck, "firstSeenMs" | "windowMinutes">,
	dataEndMs: number,
): number => {
	const deployMs = Math.floor(check.firstSeenMs / MINUTE_MS) * MINUTE_MS
	const covered = Math.min(dataEndMs, deployMs + check.windowMinutes * MINUTE_MS) - deployMs
	return Math.max(MIN_AFTER_SECONDS, covered / 1000)
}

const MIN_AFTER_SECONDS = 5

/** The minutes either side of the deploy, cut at the minute the warehouse placed it in. */
export const sidesOf = (check: Pick<DeployCheck, "firstSeenMs" | "windowMinutes">, dataEndMs: number) => {
	const deployMs = Math.floor(check.firstSeenMs / MINUTE_MS) * MINUTE_MS
	const windowMs = check.windowMinutes * MINUTE_MS
	return {
		before: { startMs: deployMs - windowMs, endMs: deployMs },
		after: {
			startMs: deployMs,
			endMs: Math.max(deployMs + MINUTE_MS, Math.min(deployMs + windowMs, dataEndMs)),
		},
	}
}

const operationsInput = (
	scope: DeployScope,
	check: DeployCheck,
	side: Readonly<{ startMs: number; endMs: number }>,
): OperationsInput => ({
	serviceName: scope.serviceName,
	startTime: formatWarehouseDateTime(side.startMs),
	endTime: formatWarehouseDateTime(side.endMs),
	environments: check.environment === "" ? undefined : [check.environment],
	bucketSeconds: side.endMs - side.startMs >= MINUTE_MS ? (side.endMs - side.startMs) / 1000 : 60,
	limit: OPERATIONS_LIMIT,
})

const requestSide = (
	model: Model,
	scope: DeployScope,
	check: DeployCheck,
	side: Side,
	mode: Keyed.RequestMode,
): Return => {
	const input = operationsInput(scope, check, sidesOf(check, scope.dataEndMs)[side])
	const key = requestKey(scope.context.orgId, "getServiceOperations", { data: input })
	return Option.match(Keyed.request(model[side], key, mode), {
		onNone: () => ({ model }),
		onSome: (next) => ({
			model: { ...model, [side]: next },
			commands: [FetchDeployOperations({ side, key: next.key, input })],
		}),
	})
}

const requestShipped = (
	model: Model,
	scope: DeployScope,
	check: DeployCheck,
	mode: Keyed.RequestMode,
): Return => {
	if (scope.window === null) return { model }
	const input = { commitSha: check.sha, startTime: scope.window.startTime, endTime: scope.window.endTime }
	const key = requestKey(scope.context.orgId, "getServiceDeploys", { data: input })
	return Option.match(Keyed.request(model.shipped, key, mode), {
		onNone: () => ({ model }),
		onSome: (next) => ({
			model: { ...model, shipped: next },
			commands: [FetchShipped({ key: next.key, input })],
		}),
	})
}

const chain = (start: Return, steps: ReadonlyArray<(model: Model) => Return>): Return =>
	Arr.reduce(steps, start, (acc: Return, step) => {
		const next = step(acc.model)
		return { model: next.model, commands: [...(acc.commands ?? []), ...(next.commands ?? [])] }
	})

const request = (model: Model, scope: DeployScope, check: DeployCheck, mode: Keyed.RequestMode): Return =>
	chain({ model }, [
		(current) => requestSide(current, scope, check, "before", mode),
		(current) => requestSide(current, scope, check, "after", mode),
		(current) => requestShipped(current, scope, check, mode),
	])

const liftDialog = (model: Model, result: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, dialog: result.model },
	commands: Command.mapMessages(result.commands ?? [], (message) => Message.GotDialogMessage({ message })),
})

/** Follows the URL: opens on a deploy (reading its sides), closes when `deploy` leaves it. */
export const sync = (
	model: Model,
	scope: DeployScope,
	check: DeployCheck | null,
	mode: Keyed.RequestMode,
): Return => {
	if (check === null) return model.dialog.isOpen ? liftDialog(model, Dialog.close(model.dialog)) : { model }
	const opened = model.dialog.isOpen ? { model } : liftDialog(model, Dialog.open(model.dialog))
	const requested = request(opened.model, scope, check, mode)
	return { model: requested.model, commands: [...(opened.commands ?? []), ...(requested.commands ?? [])] }
}

export const update = (
	model: Model,
	message: Message,
	scope: DeployScope,
	check: DeployCheck | null,
): Return =>
	Message.match<Return>(message, {
		CompletedFetchOperations: ({ side, key, result }) => ({
			model: { ...model, [side]: Keyed.accept(model[side], key, result) },
		}),
		CompletedFetchShipped: ({ key, result }) => ({
			model: { ...model, shipped: Keyed.accept(model.shipped, key, result) },
		}),
		ClickedRetry: () => (check === null ? { model } : request(model, scope, check, "Refresh")),
		GotDialogMessage: ({ message: inner }) => {
			const result = Dialog.update(model.dialog, inner)
			const lifted = liftDialog(model, result)
			return result.outMessage?._tag === "Closed"
				? { ...lifted, outMessage: OutMessage.Closed() }
				: lifted
		},
	})
