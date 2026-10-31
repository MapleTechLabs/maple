import { Schema } from "effect"
import { Command, type Update } from "foldkit"
import * as CalendarDates from "foldkit/calendar"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import * as Calendar from "../../../ui/calendar"
import * as CalendarView from "../../../ui/calendar-view"
import * as CopyButton from "../../../ui/copy-button"
import { defineLab } from "../../define"
import { contentSections } from "../../kit/content-sections"
import { kitPage } from "../../kit/kit-layout"

// `/lab/kit/content`: text, identity, conversation
// and layout primitives. The calendar and the trace id copy button are live Submodels.

// MODEL

const Model = Schema.Struct({ calendar: Calendar.Model, traceIdCopy: CopyButton.Model })
type Model = typeof Model.Type

// `MONTH`, `SELECTED` and `TODAY`: fixed dates, not the clock.
const init = (): Update.Return<Model, Message> => ({
	model: {
		calendar: Calendar.init({
			month: CalendarDates.make(2026, 10, 1),
			selected: CalendarDates.make(2026, 10, 14),
			today: CalendarDates.make(2026, 10, 17),
		}),
		traceIdCopy: CopyButton.init(),
	},
})

// MESSAGE

const Message = defineMessageUnion({
	GotCalendarMessage: { message: Calendar.Message },
	GotCopyMessage: { message: CopyButton.Message },
})
type Message = typeof Message.Type

// UPDATE

const update = (model: Model, message: Message): Update.Return<Model, Message> =>
	Message.match<Update.Return<Model, Message>>(message, {
		GotCalendarMessage: ({ message }) => {
			const next = Calendar.update(model.calendar, message)
			return {
				model: { ...model, calendar: next.model },
				commands: Command.mapMessages(next.commands ?? [], (child) =>
					Message.GotCalendarMessage({ message: child }),
				),
			}
		},
		GotCopyMessage: ({ message }) => {
			const next = CopyButton.update(model.traceIdCopy, message)
			return {
				model: { ...model, traceIdCopy: next.model },
				commands: Command.mapMessages(next.commands ?? [], (child) =>
					Message.GotCopyMessage({ message: child }),
				),
			}
		},
	})

// VIEW

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	kitPage(
		h,
		{
			title: "Kit: content",
			description: "Text, identity, conversation and layout primitives from @maple/ui.",
		},
		[
			...contentSections(h, {
				copyStatus: model.traceIdCopy.status,
				onCopy: (value) =>
					Message.GotCopyMessage({ message: CopyButton.Message.ClickedCopy({ text: value }) }),
				codeCopy: model.traceIdCopy,
				toCodeCopy: (message) => Message.GotCopyMessage({ message }),
				calendar: h.submodel({
					slotId: "kit-content-calendar",
					model: model.calendar,
					toParentMessage: (message: Calendar.Message) => Message.GotCalendarMessage({ message }),
					view: CalendarView.view,
					viewInputs: { className: "w-fit rounded-md border" },
				}),
			}),
		],
	)

export const lab = defineLab<Model, Message>("Kit: content", { Model, init, update, view })
