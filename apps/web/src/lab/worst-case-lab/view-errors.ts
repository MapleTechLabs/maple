import { buildErrorsLabFixture } from "../errors-fixture"
import { errorSignal, sampleTraces } from "../worst-case-docs"
import type { ErrorSignal } from "../../lib/models/error-signal"
import { Submodel } from "foldkit"
import type { Html } from "foldkit/html"
import type { Message as SignalMessage } from "../../page/errors/hub/message"
import { type RowState, signalRow } from "../../page/errors/hub/view-row"
import { identityAvatar } from "../../page/errors/kit/actor"
import { occurrencesTable } from "../../page/errors/kit/occurrences-table"
import { actorIdentities } from "./fixture"
import { Message, type Model } from "./model"
import { type H, narrow, wcSection } from "./view-parts"

// `ErrorsSection`: occurrences, a signal row, avatars.

/** `ErrorSignalRow` speaks the errors hub's Messages; the lab hosts it in that universe. */
const signalRowView = Submodel.defineView<ErrorSignal, SignalMessage, RowState>((signal, state, h) =>
	signalRow(h, signal, state),
)

export const errorsSection = (h: H, model: Model): Html => {
	const fixture = buildErrorsLabFixture(model.nowMs)
	const base = fixture.signals[0]
	return wcSection(h, "wc-errors", "Errors: occurrences, signal row, avatars", [
		h.div(
			[h.Class("max-w-4xl rounded-md border")],
			[occurrencesTable(h, sampleTraces(model.mode), { nowMs: model.nowMs, timeZone: model.timeZone })],
		),
		h.div(
			[h.Class("@container/page max-w-5xl rounded-md border")],
			[
				h.div(
					[h.Role("list")],
					base === undefined
						? []
						: [
								h.div(
									[h.Role("listitem")],
									[
										h.submodel({
											slotId: "wc-signal-row",
											model: errorSignal(model.mode, base),
											view: signalRowView,
											viewInputs: {
												isSelected: false,
												isSelecting: false,
												isFocused: false,
												timeZone: model.timeZone,
												nowMs: model.nowMs,
												sparkWindow: fixture.sparkWindow,
												picker: null,
												rowMenu: null,
											},
											toParentMessage: (message: SignalMessage) =>
												Message.GotSignalRowMessage({ message }),
										}),
									],
								),
							],
				),
			],
		),
		narrow(h, [
			h.div(
				[h.Class("space-y-2")],
				actorIdentities(model.mode).map((identity) =>
					h.div(
						[h.Key(identity.seed), h.Class("flex items-center gap-2 text-xs")],
						[
							identityAvatar(h, identity),
							identityAvatar(h, identity, "md"),
							h.span([h.Class("truncate")], [identity.name]),
						],
					),
				),
			),
		]),
	])
}
