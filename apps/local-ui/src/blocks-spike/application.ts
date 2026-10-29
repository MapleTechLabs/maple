import { Array, Schema } from "effect"
import { Block, Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { DialogBlock } from "@foldkit/ui"
import { ServerProbeBlock } from "./probe"

// Spike root: binds the probe Block and a @foldkit/ui Dialog Block, folds the probe's
// reachability OutMessage into an event log the dialog shows.

export const Flags = Schema.Struct({ apiBase: Schema.String })
export type Flags = typeof Flags.Type

const ReachabilityEvent = Schema.Struct({ isReachable: Schema.Boolean, atMs: Schema.Number })
type ReachabilityEvent = typeof ReachabilityEvent.Type

const Model = Schema.Struct({
	probe: ServerProbeBlock.Model,
	eventsDialog: DialogBlock.Model,
	events: Schema.Array(ReachabilityEvent),
})
type Model = typeof Model.Type

const Message = defineMessageUnion({
	ClickedShowEvents: {},
	ClickedClearEvents: {},
})
type Message = typeof Message.Type

const ApplicationDefinition = Block.makeDefinition("Application", {
	Model,
	Message,
	ChildInitContext: Flags,
})

const { makeFieldsStep, makeNoopStep } = ApplicationDefinition

const ProbeBinding = ApplicationDefinition.makeBinding(ServerProbeBlock, {
	field: "probe",
	init: { contextToArgs: ({ apiBase }) => [apiBase] },
}).withOutMessagePolicy({
	fold: ApplicationDefinition.makeOutMessageFold(ServerProbeBlock, {
		ChangedReachability: (event) =>
			makeFieldsStep(() => ({
				events: Array.prepend(ReachabilityEvent.make(event)),
			})),
	}),
})

const EventsDialogBinding = ApplicationDefinition.makeBinding(DialogBlock, {
	field: "eventsDialog",
	init: { contextToArgs: () => [{ id: "spike-events-dialog" }] },
}).withOutMessagePolicy({
	fold: ApplicationDefinition.makeOutMessageFold(DialogBlock, {
		Opened: makeNoopStep,
		Closed: makeNoopStep,
		CompletedClose: makeNoopStep,
	}),
})

const ApplicationComposition = ApplicationDefinition.makeComposition({
	bindings: [ProbeBinding, EventsDialogBinding],
})
type ApplicationViewBuilder = Block.ViewBuilderFor<typeof ApplicationComposition>

const init = ApplicationComposition.makeInit((flags: Flags) => ({
	childInitContext: flags,
	model: { events: [] },
}))

const update = ApplicationComposition.makeUpdate({
	ClickedShowEvents: (model) => Update.combineSteps(model, [EventsDialogBinding.requestOpen()]),
	ClickedClearEvents: makeFieldsStep(() => ({ events: () => [] })),
})

const eventRow = (event: ReachabilityEvent, h: ApplicationViewBuilder) =>
	h.keyed("li")(
		String(event.atMs),
		[h.Class("flex justify-between gap-6 text-sm tabular-nums")],
		[
			h.span([], [event.isReachable ? "Came up" : "Went down"]),
			h.span([h.Class("text-muted-foreground")], [new Date(event.atMs).toLocaleTimeString()]),
		],
	)

const eventsDialogView = (model: Model, h: ApplicationViewBuilder) =>
	h.block(
		EventsDialogBinding.embedView({
			slotId: model.eventsDialog.id,
			model: model.eventsDialog,
			viewInputs: {
				hasDescription: false,
				toView: ({ dialog, backdrop, panel, closeButton, title, isVisible }) =>
					h.dialog(
						[...dialog, h.Class("bg-transparent p-0 open:flex items-center justify-center")],
						isVisible
							? [
									h.div([...backdrop, h.Class("fixed inset-0 bg-black/60")]),
									h.div(
										[
											...panel,
											h.Class(
												"relative w-80 rounded-lg border border-border bg-card p-5",
											),
										],
										[
											h.h2(
												[...title, h.Class("mb-3 text-sm font-semibold")],
												["Reachability events"],
											),
											model.events.length === 0
												? h.p(
														[h.Class("text-sm text-muted-foreground")],
														["No changes yet."],
													)
												: h.ul(
														[h.Class("flex flex-col gap-1")],
														model.events.map((event) => eventRow(event, h)),
													),
											h.div(
												[h.Class("mt-4 flex justify-end gap-2")],
												[
													h.button(
														[
															h.Class(
																"rounded border border-border px-2 py-1 text-xs",
															),
															h.OnClick(Message.ClickedClearEvents()),
														],
														["Clear"],
													),
													h.button(
														[
															...closeButton,
															h.Class(
																"rounded bg-primary px-2 py-1 text-xs text-primary-foreground",
															),
														],
														["Close"],
													),
												],
											),
										],
									),
								]
							: [],
					),
			},
		}),
	)

const view = ApplicationComposition.makeView((model, h) => ({
	title: "Maple Local · Blocks spike",
	body: h.main(
		[h.Class("mx-auto flex max-w-xl flex-col gap-4 p-10")],
		[
			h.h1([h.Class("text-lg font-semibold")], ["Blocks spike"]),
			h.block(ProbeBinding.embedView({ slotId: "probe", model: model.probe })),
			h.button(
				[
					h.Class("self-start rounded border border-border px-3 py-1.5 text-sm"),
					h.OnClick(Message.ClickedShowEvents()),
				],
				[`Events (${model.events.length})`],
			),
			eventsDialogView(model, h),
		],
	),
}))

const prepare = () => ApplicationComposition.prepareBlock({ init, update, view })
export const ApplicationBlock: Block.FromAssemblyWithView<typeof Model, typeof prepare> =
	Block.assemble(prepare)
