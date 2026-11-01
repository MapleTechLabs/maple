import { Effect, Schema } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { crashView } from "../../crash/view"
import { button } from "../../ui/button"
import { defineLab } from "../define"

// `/lab/crash`: crashes a real Foldkit program, so the crash page renders through the runtime's own path.

const ElapsedPreviewDebounce = Schema.TaggedStruct("ElapsedPreviewDebounce", {})
const StatusPageNew = Schema.TaggedStruct("StatusPageNew", { message: ElapsedPreviewDebounce })
const Message = Schema.TaggedStruct("GotPageMessage", { message: StatusPageNew })
type Message = typeof Message.Type

class CrashLabDefect extends Schema.TaggedError<CrashLabDefect>()("@maple/web/lab/CrashLabDefect", {
	message: Schema.String,
}) {}

const Model = Schema.Struct({})
type Model = typeof Model.Type

const view = (_model: Model, h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Class("mx-auto flex max-w-3xl flex-col items-start gap-3 p-8")],
		[
			h.h1([h.Class("font-semibold text-lg")], ["Crash page"]),
			h.p(
				[h.Class("text-muted-foreground text-sm")],
				["The button dispatches a nested Message whose update dies, like a page bug would."],
			),
			button(
				h,
				{
					variant: "destructive",
					attributes: [
						h.OnClick(
							Message.make({
								message: StatusPageNew.make({ message: ElapsedPreviewDebounce.make({}) }),
							}),
						),
					],
				},
				["Crash the app"],
			),
		],
	)

export const lab = defineLab("Crash page", {
	Model,
	init: () => ({ model: {} }),
	update: (_model: Model, _message: Message) =>
		// oxlint-disable-next-line maple/no-effect-die -- the defect is the point: an unrecoverable update, as the runtime sees one.
		Effect.runSync(Effect.die(new CrashLabDefect({ message: "Crash lab: deliberate defect" }))),
	view,
	crash: { view: (context, h) => crashView(context, h).body },
})
