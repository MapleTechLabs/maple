import { V2IngestRule, V2IngestRuleStats } from "@maple/domain/http/v2"
import { collectV2Pages } from "@maple/web-data/lib/v2-pagination"
import { Array, DateTime, Effect, Option, Result, Schema } from "effect"
import { AsyncData, Command } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure, toLoadFailure } from "../../../data/load-failure"
import { MapleApiV2Client } from "../../../platform/api-clients"
import * as Dialog from "../../../ui/dialog"
import * as Menu from "../../../ui/menu"
import { PageOutMessage, type PageReturn } from "../../contract"
import { ruleHref } from "../ingest-rule/hrefs"

// The "Ingest rules" section of the ingestion tab: list, toggle, reorder and delete.

const RuleId = V2IngestRule.fields.id
export const RulesData = AsyncData.Schema(Schema.Array(V2IngestRule), LoadFailure)
export const StatsData = AsyncData.Schema(V2IngestRuleStats, LoadFailure)

export const Model = Schema.Struct({
	rules: RulesData.schema,
	/** Hits over the last 24 hours; a failure only blanks the column. */
	stats: StatsData.schema,
	/** Rows with a toggle in flight. */
	pending: Schema.Array(Schema.String),
	isMoving: Schema.Boolean,
	menus: Schema.Record(Schema.String, Menu.Model),
	deleteDialog: Dialog.Model,
	deleting: Schema.NullOr(V2IngestRule),
	isDeleting: Schema.Boolean,
})
export type Model = typeof Model.Type

const PositionChange = Schema.Struct({ id: RuleId, position: Schema.Number })

export const Message = defineMessageUnion({
	CompletedFetch: { result: Schema.Result(Schema.Array(V2IngestRule), LoadFailure) },
	CompletedFetchStats: { result: Schema.Result(V2IngestRuleStats, LoadFailure) },
	ClickedRetry: {},
	Toggled: { id: RuleId },
	CompletedToggle: { id: RuleId, result: Schema.Result(Schema.Void, LoadFailure) },
	GotRowMenuMessage: { menuId: Schema.String, message: Menu.Message },
	CompletedMove: { result: Schema.Result(Schema.Void, LoadFailure) },
	GotDeleteDialogMessage: { message: Dialog.Message },
	ClickedConfirmDelete: {},
	CompletedDelete: { result: Schema.Result(Schema.Void, LoadFailure) },
})
export type Message = typeof Message.Type

type Return = PageReturn<Model, Message>

const PAGE_LIMIT = 100

export const FetchIngestRules = Command.define("FetchIngestRules", {
	messages: [Message.CompletedFetch],
	execute: Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		return yield* collectV2Pages((cursor) =>
			client.ingestRules.list({
				query: cursor === undefined ? { limit: PAGE_LIMIT } : { limit: PAGE_LIMIT, cursor },
			}),
		)
	}).pipe(
		Effect.mapError(toLoadFailure),
		Effect.result,
		Effect.map((result) => Message.CompletedFetch({ result })),
	),
})

/** The stats endpoint's default window: the last 24 hours. */
export const FetchIngestRuleStats = Command.define("FetchIngestRuleStats", {
	messages: [Message.CompletedFetchStats],
	execute: Effect.flatMap(MapleApiV2Client, (client) => client.ingestRules.stats({ query: {} })).pipe(
		Effect.mapError(toLoadFailure),
		Effect.result,
		Effect.map((result) => Message.CompletedFetchStats({ result })),
	),
})

const ToggleIngestRule = Command.define("ToggleIngestRule", {
	args: { id: RuleId, isEnabled: Schema.Boolean },
	messages: [Message.CompletedToggle],
	execute: ({ id, isEnabled }) =>
		Effect.flatMap(MapleApiV2Client, (client) =>
			client.ingestRules.update({ params: { id }, payload: { enabled: isEnabled } }),
		).pipe(
			Effect.asVoid,
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedToggle({ id, result })),
		),
})

/** Writes the new order as positions 0..n-1, one PATCH per rule whose position changed. */
const MoveIngestRules = Command.define("MoveIngestRules", {
	args: { changes: Schema.Array(PositionChange) },
	messages: [Message.CompletedMove],
	execute: ({ changes }) =>
		Effect.flatMap(MapleApiV2Client, (client) =>
			Effect.forEach(
				changes,
				({ id, position }) => client.ingestRules.update({ params: { id }, payload: { position } }),
				{
					discard: true,
				},
			),
		).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedMove({ result })),
		),
})

const DeleteIngestRule = Command.define("DeleteIngestRule", {
	args: { id: RuleId },
	messages: [Message.CompletedDelete],
	execute: ({ id }) =>
		Effect.flatMap(MapleApiV2Client, (client) => client.ingestRules.delete({ params: { id } })).pipe(
			Effect.asVoid,
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedDelete({ result })),
		),
})

export const init = (): Model => ({
	rules: AsyncData.Loading(),
	stats: AsyncData.Loading(),
	pending: [],
	isMoving: false,
	menus: {},
	deleteDialog: Dialog.init("ingest-rule-delete", "alert-dialog"),
	deleting: null,
	isDeleting: false,
})

export const menuIdOf = (id: string) => `ingest-rule-row-${id}`

const toast = (type: "success" | "error", title: string, description = "") =>
	PageOutMessage.RequestedToast({ type, title, description })

const refreshed = (model: Model): Return => ({
	model: { ...model, rules: Option.getOrElse(AsyncData.revalidate(model.rules), () => model.rules) },
	commands: [FetchIngestRules()],
})

const liftDeleteDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, deleteDialog: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) =>
		Message.GotDeleteDialogMessage({ message }),
	),
})

const rulesOf = (model: Model) => AsyncData.getOrElse(model.rules, () => [])

/** The list in its current order, with one rule moved one step; `[]` when it cannot move. */
export const moved = (rules: ReadonlyArray<V2IngestRule>, id: string, step: -1 | 1) => {
	const index = rules.findIndex((rule) => rule.id === id)
	const target = index + step
	if (index === -1 || target < 0 || target >= rules.length) return []
	const order = rules.map((rule, position) =>
		position === index ? rules[target] : position === target ? rules[index] : rule,
	)
	return order.flatMap((rule, position) =>
		rule === undefined || rule.position === position ? [] : [{ id: rule.id, position }],
	)
}

const picked = (model: Model, menuId: string, value: string): Return =>
	Option.match(
		Array.findFirst(rulesOf(model), (rule) => menuIdOf(rule.id) === menuId),
		{
			onNone: () => ({ model }),
			onSome: (rule): Return => {
				if (value === "edit")
					return {
						model,
						outMessage: PageOutMessage.RequestedNavigation({
							url: ruleHref(rule.id),
							isReplace: false,
						}),
					}
				if (value === "delete")
					return liftDeleteDialog({ ...model, deleting: rule }, Dialog.open(model.deleteDialog))
				const changes = model.isMoving ? [] : moved(rulesOf(model), rule.id, value === "up" ? -1 : 1)
				return changes.length === 0
					? { model }
					: { model: { ...model, isMoving: true }, commands: [MoveIngestRules({ changes })] }
			},
		},
	)

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		CompletedFetch: ({ result }) => ({
			model: { ...model, rules: AsyncData.settle(model.rules, result) },
		}),
		CompletedFetchStats: ({ result }) => ({
			model: { ...model, stats: AsyncData.settle(model.stats, result) },
		}),
		ClickedRetry: () => ({
			model: { ...model, rules: AsyncData.Loading(), stats: AsyncData.Loading() },
			commands: [FetchIngestRules(), FetchIngestRuleStats()],
		}),
		Toggled: ({ id }) =>
			Option.match(
				Array.findFirst(rulesOf(model), (rule) => rule.id === id),
				{
					onNone: () => ({ model }),
					onSome: (rule): Return =>
						model.pending.includes(id)
							? { model }
							: {
									model: { ...model, pending: [...model.pending, id] },
									commands: [ToggleIngestRule({ id, isEnabled: !rule.enabled })],
								},
				},
			),
		CompletedToggle: ({ id, result }) => {
			const settled = { ...model, pending: model.pending.filter((entry) => entry !== id) }
			return Result.match(result, {
				onSuccess: () => refreshed(settled),
				onFailure: (error): Return => ({
					model: settled,
					outMessage: toast("error", "Failed to update ingest rule", error.message),
				}),
			})
		},
		GotRowMenuMessage: ({ menuId, message: child }) => {
			const step = Menu.update(model.menus[menuId] ?? Menu.init(menuId), child)
			const next = { ...model, menus: { ...model.menus, [menuId]: step.model } }
			const commands = Command.mapMessages(step.commands ?? [], (inner) =>
				Message.GotRowMenuMessage({ menuId, message: inner }),
			)
			if (step.outMessage?._tag !== "SelectedItem") return { model: next, commands }
			const after = picked(next, menuId, step.outMessage.value)
			return { ...after, commands: [...commands, ...(after.commands ?? [])] }
		},
		CompletedMove: ({ result }) => {
			const after = refreshed({ ...model, isMoving: false })
			return Result.isFailure(result)
				? {
						...after,
						outMessage: toast("error", "Failed to reorder ingest rules", result.failure.message),
					}
				: after
		},
		GotDeleteDialogMessage: ({ message: child }) =>
			model.isDeleting ? { model } : liftDeleteDialog(model, Dialog.update(model.deleteDialog, child)),
		ClickedConfirmDelete: () =>
			model.deleting === null || model.isDeleting
				? { model }
				: {
						model: { ...model, isDeleting: true },
						commands: [DeleteIngestRule({ id: model.deleting.id })],
					},
		CompletedDelete: ({ result }) =>
			Result.match(result, {
				onSuccess: (): Return => {
					const closed = liftDeleteDialog(
						{ ...model, isDeleting: false },
						Dialog.close(model.deleteDialog),
					)
					const after = refreshed(closed.model)
					return {
						...after,
						commands: [...(closed.commands ?? []), ...(after.commands ?? [])],
						outMessage: toast("success", "Ingest rule deleted"),
					}
				},
				onFailure: (error): Return => ({
					model: { ...model, isDeleting: false },
					outMessage: toast("error", "Failed to delete ingest rule", error.message),
				}),
			}),
	})

const HOUR_MS = 3_600_000

/** The UTC hour of a wire timestamp (ISO-8601 UTC, validated by the schema); `NaN` if unreadable. */
const hourOf = (timestamp: string): number =>
	Option.match(DateTime.make(timestamp), {
		onNone: () => Number.NaN,
		onSome: (time) => Math.floor(DateTime.toEpochMillis(time) / HOUR_MS),
	})

/** One rule's matches per UTC hour over the last 24 hours of the window, oldest first. */
export const hourlyMatches = (stats: V2IngestRuleStats, id: string): ReadonlyArray<number> => {
	const lastHour = hourOf(stats.end_time)
	const byHour = new Map(
		stats.hourly.filter((entry) => entry.id === id).map((entry) => [hourOf(entry.bucket), entry.matched]),
	)
	return Array.makeBy(24, (index) => byHour.get(lastHour - 23 + index) ?? 0)
}
