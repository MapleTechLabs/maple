import { AiToolErrorSampleCursor } from "@maple/domain/http"
import { getAiToolErrorDetail, getAiToolErrorSamples } from "@maple/web-data/warehouse/ai-session-tools"
import { Effect, Option, Schema, Stream } from "effect"
import { Command, Dom } from "foldkit"
import { toLoadFailure } from "../../../data/load-failure"
import { Selection, toInput } from "../tools-kit/reads"
import { Message, type ModalKey } from "./error-modal-model"

/** `aiToolErrorDetailResultAtom({ ...selection, fingerprint })`. */
export const FetchErrorDetail = Command.define("FetchAgentToolErrorDetail", {
	args: { key: Schema.String, selection: Selection, fingerprint: Schema.String },
	messages: [Message.CompletedFetchDetail],
	execute: ({ key, selection, fingerprint }) =>
		getAiToolErrorDetail({ data: { ...toInput(selection), tool: selection.tool ?? "", fingerprint } }).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchDetail({ key, result })),
		),
})

/** One page of `aiToolErrorSamplesResultAtom`: the narrowing and the cursor that fetched it. */
export const FetchErrorSamples = Command.define("FetchAgentToolErrorSamples", {
	args: {
		key: Schema.String,
		selection: Selection,
		fingerprint: Schema.String,
		session: Schema.UndefinedOr(Schema.String),
		variant: Schema.UndefinedOr(Schema.String),
		before: Schema.UndefinedOr(AiToolErrorSampleCursor),
	},
	messages: [Message.CompletedFetchSamples],
	execute: ({ key, selection, fingerprint, session, variant, before }) =>
		getAiToolErrorSamples({
			data: { ...toInput(selection), tool: selection.tool ?? "", fingerprint, session, variant, before },
		}).pipe(
			Effect.map((page) => ({ occurrences: page.occurrences, nextCursor: page.nextCursor })),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchSamples({ key, result })),
		),
})

/** "Copy link": the page's own URL, which holds the group and its narrowing. */
export const CopyErrorLink = Command.define("CopyAgentToolErrorLink", {
	messages: [Message.CompletedCopyLink],
	execute: Effect.tryPromise(() => navigator.clipboard.writeText(window.location.href)).pipe(
			Effect.as(Message.CompletedCopyLink({ isCopied: true })),
			Effect.orElseSucceed(() => Message.CompletedCopyLink({ isCopied: false })),
		),
})

export const CopyErrorArguments = Command.define("CopyAgentToolErrorArguments", {
	args: { text: Schema.String },
	messages: [Message.CompletedCopyArguments],
	execute: ({ text }) =>
		Effect.tryPromise(() => navigator.clipboard.writeText(text)).pipe(
			Effect.as(Message.CompletedCopyArguments({ isCopied: true })),
			Effect.orElseSucceed(() => Message.CompletedCopyArguments({ isCopied: false })),
		),
})

/** `rowRefs.current.get(index)?.scrollIntoView({ block: "nearest" })`. */
export const ScrollSampleIntoView = Command.define("ScrollAgentToolErrorSample", {
	args: { index: Schema.Number },
	messages: [Message.CompletedScrollSample],
	execute: ({ index }) =>
		Effect.sync(() => {
			document
				.querySelectorAll('[data-slot="tool-error-sample"]')
				.item(index)
				?.scrollIntoView({ block: "nearest" })
			return Message.CompletedScrollSample()
		}),
})

/** A key press the modal's shortcuts leave alone: a modifier held, or typing in a field. */
const isTyping = (event: KeyboardEvent): boolean =>
	event.metaKey ||
	event.ctrlKey ||
	event.altKey ||
	(event.target instanceof HTMLElement && event.target.closest("input, textarea, [contenteditable='true']") !== null)

/** Where the open group sits in the Errors read: ↑/↓ step (and claim the key) only inside it. */
export type GroupPosition = Readonly<{ index: number; total: number }>

/** ↑/↓: the group step a press makes, none past either end (the scroll area keeps the key then). */
export const arrowStepOf = (key: string, position: GroupPosition): Option.Option<ModalKey> => {
	if (key === "ArrowUp" && position.index > 0) return Option.some("StepUp")
	if (key === "ArrowDown" && position.index >= 0 && position.index < position.total - 1)
		return Option.some("StepDown")
	return Option.none()
}

const SAMPLE_KEYS = new Map<string, ModalKey>([
	["j", "OlderSample"],
	["k", "NewerSample"],
])

/** `useWindowKeydown`: ↑/↓ read the next group (default prevented), j/k the next sample. */
export const modalKeys = (position: GroupPosition): Stream.Stream<Message> =>
	Stream.merge(
		Dom.streamFromEventFilterMapPreventDefault({
			target: () => window,
			type: "keydown",
			filterMapEvent: (event) =>
				isTyping(event)
					? Option.none()
					: Option.map(arrowStepOf(event.key, position), (key) => Message.PressedModalKey({ key })),
		}),
		Dom.streamFromEventFilterMap({
			target: () => window,
			type: "keydown",
			filterMapEvent: (event) => {
				const key = SAMPLE_KEYS.get(event.key)
				return key === undefined || isTyping(event) ? Option.none() : Option.some(Message.PressedModalKey({ key }))
			},
		}),
	)
