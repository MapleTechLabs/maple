import { Clock, Duration, Effect, Layer, Schema, Stream } from "effect"
import { HttpClient } from "effect/http"
import { Block } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import { probeServer } from "../server/probe"
import { ProbeOutcome } from "../server/state"

// Spike: the server probe as a completed Block. Its Command and Subscription handlers
// are Layers; the parent hears about reachability changes through an OutMessage.

const POLL_INTERVAL = Duration.seconds(10)

const Status = Schema.Literals(["Checking", "Reachable", "Unreachable"])
type Status = typeof Status.Type

const Model = Schema.Struct({
	apiBase: Schema.String,
	status: Status,
	lastIngestAtMs: Schema.NullOr(Schema.Number),
	checkedAtMs: Schema.NullOr(Schema.Number),
})
type Model = typeof Model.Type

const Message = defineMessageUnion({
	ClickedProbe: {},
	Ticked: {},
	CompletedProbe: { outcome: ProbeOutcome, checkedAtMs: Schema.Number },
})
type Message = typeof Message.Type

const OutMessage = defineMessageUnion({
	ChangedReachability: { isReachable: Schema.Boolean, atMs: Schema.Number },
})
type OutMessage = typeof OutMessage.Type

const ServerProbeDefinition = Block.makeDefinition("ServerProbe", { Model, Message, OutMessage })

const { makeCommandsStep } = ServerProbeDefinition

const ServerProbeComposition = ServerProbeDefinition.makeComposition()

const Probe = ServerProbeDefinition.makeCommand("Probe", {
	args: { apiBase: Schema.String },
	messages: [Message.CompletedProbe],
	handler: function* () {
		const client = yield* HttpClient.HttpClient

		return ({ apiBase }) =>
			Effect.gen(function* () {
				const outcome = yield* probeServer(apiBase)
				const checkedAtMs = yield* Clock.currentTimeMillis
				return Message.CompletedProbe({ outcome, checkedAtMs })
			}).pipe(Effect.provideService(HttpClient.HttpClient, client))
	},
})

const subscriptions = ServerProbeDefinition.makeSubscriptions((entry) => ({
	poll: entry("PollServer", {
		messages: [Message.Ticked],
		handler: function* () {
			return () => Stream.tick(POLL_INTERVAL).pipe(Stream.drop(1), Stream.map(Message.Ticked))
		},
	}),
}))

const statusOf = (outcome: ProbeOutcome): Status =>
	outcome._tag === "Ok" || outcome._tag === "Legacy" || outcome._tag === "Busy"
		? "Reachable"
		: "Unreachable"

const lastIngestOf = (outcome: ProbeOutcome): number | null =>
	outcome._tag === "Ok" ? outcome.lastIngestAtMs : null

const probeStep = makeCommandsStep((model) => [Probe({ apiBase: model.apiBase })])

const init = ServerProbeComposition.makeInit((apiBase: string) => ({
	model: Model.make({ apiBase, status: "Checking", lastIngestAtMs: null, checkedAtMs: null }),
	commands: [Probe({ apiBase })],
}))

const update = ServerProbeComposition.makeUpdate({
	ClickedProbe: probeStep,
	Ticked: probeStep,
	CompletedProbe: (model, { outcome, checkedAtMs }) => {
		const status = statusOf(outcome)
		const nextModel = modifyFields(model, {
			status: () => status,
			lastIngestAtMs: () => lastIngestOf(outcome),
			checkedAtMs: () => checkedAtMs,
		})
		return status === model.status
			? { model: nextModel }
			: {
					model: nextModel,
					outMessage: OutMessage.ChangedReachability({
						isReachable: status === "Reachable",
						atMs: checkedAtMs,
					}),
				}
	},
})

const STATUS_LABEL: Record<Status, string> = {
	Checking: "Checking…",
	Reachable: "Reachable",
	Unreachable: "Unreachable",
}

const view = ServerProbeComposition.makeView((model, h) =>
	h.div(
		[h.Class("flex items-center gap-3 rounded-md border border-border px-4 py-3")],
		[
			h.span(
				[
					h.Class(
						model.status === "Reachable"
							? "size-2 rounded-full bg-success"
							: "size-2 rounded-full bg-destructive",
					),
				],
				[],
			),
			h.span([h.Class("text-sm font-medium")], [STATUS_LABEL[model.status]]),
			h.span(
				[h.Class("text-xs text-muted-foreground tabular-nums")],
				[
					model.lastIngestAtMs === null
						? "no ingest yet"
						: `last ingest ${new Date(model.lastIngestAtMs).toLocaleTimeString()}`,
				],
			),
			h.button(
				[
					h.Class("ml-auto rounded border border-border px-2 py-1 text-xs"),
					h.OnClick(Message.ClickedProbe()),
				],
				["Probe now"],
			),
		],
	),
)

const prepare = () =>
	ServerProbeComposition.prepareBlock({
		init,
		update,
		view,
		subscriptions,
		EffectsLayer: Layer.mergeAll(Probe.layer, subscriptions.layer),
	})
export const ServerProbeBlock: Block.FromAssemblyWithViewAndOutMessage<typeof Model, typeof prepare> =
	Block.assemble(prepare)
