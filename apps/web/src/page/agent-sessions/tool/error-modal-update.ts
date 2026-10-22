import { AsyncData, Command } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { Option, Schema } from "effect"
import * as Keyed from "../../../data/keyed"
import { requestKey } from "../../../data/request-key"
import type { Resources } from "../../../platform/resources"
import * as Dialog from "../../../ui/dialog"
import type { Selection } from "../tools-kit/reads"
import {
	CopyErrorArguments,
	CopyErrorLink,
	FetchErrorDetail,
	FetchErrorSamples,
	ScrollSampleIntoView,
} from "./error-modal-command"
import { init, Message, type Model, type SamplesPage } from "./error-modal-model"

/** What the modal asks of the page: a new `?error=`, `?session=` or `?variant=`. */
export const OutMessage = defineMessageUnion({
	RequestedSearch: {
		error: Schema.UndefinedOr(Schema.String),
		session: Schema.UndefinedOr(Schema.String),
		variant: Schema.UndefinedOr(Schema.String),
	},
})
export type OutMessage = typeof OutMessage.Type

export type Return = Readonly<{
	model: Model
	commands?: ReadonlyArray<Command.Command<Message, never, Resources>>
	outMessage?: OutMessage
}>

/** The page facts the modal reads: the org, the window's selection, the URL, the table's groups. */
export type ModalContext = Readonly<{
	orgId: string
	/** `Refresh` on the Reload's window: the group's facts revalidate under an unchanged key. */
	detailMode: Keyed.RequestMode
	selection: Selection | null
	error: string | undefined
	session: string | undefined
	variant: string | undefined
	/** The Errors read's groups in its own order, which ↑/↓ steps through. */
	fingerprints: ReadonlyArray<string>
}>

const samplesInputOf = (context: ModalContext, selection: Selection, fingerprint: string) => ({
	...selection,
	fingerprint,
	session: context.session,
	variant: context.variant,
})

type Cursor = NonNullable<SamplesPage["nextCursor"]>

/** The page fetched after `before`; the first page has none. */
const fetchPage = (
	context: ModalContext,
	selection: Selection,
	fingerprint: string,
	before: Cursor | undefined,
) => {
	const input = samplesInputOf(context, selection, fingerprint)
	const key = requestKey(context.orgId, "getAiToolErrorSamples", { data: { ...input, before } })
	return {
		slot: { key, data: AsyncData.Loading() } satisfies Model["pages"][number],
		command: FetchErrorSamples({
			key,
			selection,
			fingerprint,
			session: context.session,
			variant: context.variant,
			before,
		}),
	}
}

const liftDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, dialog: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotDialogMessage({ message })),
})

const merge = (first: Return, second: Return): Return => ({
	model: second.model,
	commands: [...(first.commands ?? []), ...(second.commands ?? [])],
	outMessage: second.outMessage ?? first.outMessage,
})

/**
 * Opens on the row the URL names once the Errors table holds it (a stale `?error=` issues no read),
 * and closes when it no longer does. The group's facts and first page of samples are read once.
 */
export const follow = (model: Model, context: ModalContext): Return => {
	const fingerprint = context.error
	const selection = context.selection
	if (fingerprint === undefined || selection === null || !context.fingerprints.includes(fingerprint)) {
		const shut = model.dialog.isOpen ? liftDialog(model, Dialog.close(model.dialog)) : { model }
		return { ...shut, model: { ...shut.model, fingerprint: null } }
	}
	const base: Model =
		model.fingerprint === fingerprint ? model : { ...init(), dialog: model.dialog, fingerprint }
	const opened = base.dialog.isOpen ? { model: base } : liftDialog(base, Dialog.open(base.dialog))
	const detailKey = requestKey(context.orgId, "getAiToolErrorDetail", {
		data: { ...selection, fingerprint },
	})
	const detail: Return = Option.match(Keyed.request(opened.model.detail, detailKey, context.detailMode), {
		onNone: () => ({ model: opened.model }),
		onSome: (slot) => ({
			model: { ...opened.model, detail: slot },
			commands: [FetchErrorDetail({ key: detailKey, selection, fingerprint })],
		}),
	})
	const samplesKey = JSON.stringify(samplesInputOf(context, selection, fingerprint))
	if (detail.model.samplesKey === samplesKey && detail.model.pages.length > 0) return merge(opened, detail)
	const first = fetchPage(context, selection, fingerprint, undefined)
	return merge(opened, {
		model: { ...freshSamples(detail.model, samplesKey), pages: [first.slot] },
		commands: [...(detail.commands ?? []), first.command],
	})
}

/** Every loaded sample, page after page. */
export const occurrencesOf = (model: Model) =>
	model.pages.flatMap((page) =>
		Option.match(AsyncData.getData(page.data), {
			onNone: () => [],
			onSome: (value) => value.occurrences,
		}),
	)

export type Paging = "more" | "loading" | "failed" | "end"

/** The list footer's offer: more to load, a page in flight, a failed page, or the end. */
export const pagingOf = (model: Model): Paging => {
	const last = model.pages.at(-1)
	if (last === undefined) return "end"
	if (model.pages.length > 1 && AsyncData.isFailure(last.data)) return "failed"
	if (model.pages.length > 1 && !AsyncData.hasData(last.data)) return "loading"
	return Option.match(AsyncData.getData(last.data), {
		onNone: () => "end",
		onSome: (page) => (page.nextCursor === undefined ? "end" : "more"),
	})
}

const loadMore = (model: Model, context: ModalContext): Return => {
	const paging = pagingOf(model)
	const last = model.pages.at(-1)
	if (model.fingerprint === null || context.selection === null || last === undefined) return { model }
	const previous = model.pages.at(-2)
	if (paging === "failed") {
		const before = Option.getOrUndefined(
			Option.flatMap(Option.fromUndefinedOr(previous), (page) =>
				Option.flatMap(AsyncData.getData(page.data), (value) =>
					Option.fromUndefinedOr(value.nextCursor),
				),
			),
		)
		const retry = fetchPage(context, context.selection, model.fingerprint, before)
		return {
			model: { ...model, pages: [...model.pages.slice(0, -1), retry.slot] },
			commands: [retry.command],
		}
	}
	if (paging !== "more") return { model }
	const cursor = Option.getOrUndefined(
		Option.flatMap(AsyncData.getData(last.data), (value) => Option.fromUndefinedOr(value.nextCursor)),
	)
	if (cursor === undefined) return { model }
	const next = fetchPage(context, context.selection, model.fingerprint, cursor)
	return { model: { ...model, pages: [...model.pages, next.slot] }, commands: [next.command] }
}

/** `select`: past the end loads the next page; a new sample opens and is scrolled to. */
const select = (model: Model, context: ModalContext, index: number): Return => {
	if (index < 0) return { model }
	if (index >= occurrencesOf(model).length)
		return pagingOf(model) === "more" ? loadMore(model, context) : { model }
	return {
		model: {
			...model,
			selected: index,
			isSampleClosed: false,
			isFullArguments: index === model.selected ? model.isFullArguments : false,
			argumentsCopy: index === model.selected ? model.argumentsCopy : "idle",
		},
		commands: [ScrollSampleIntoView({ index })],
	}
}

/** The sample `SamplesPane` has open: the selection clamped to what is loaded. */
export const currentOf = (model: Model): number =>
	Math.min(model.selected, Math.max(occurrencesOf(model).length - 1, 0))

const step = (model: Model, context: ModalContext, offset: -1 | 1): Return => {
	const index = context.fingerprints.indexOf(model.fingerprint ?? "")
	const next = context.fingerprints[index + offset]
	return next === undefined || index === -1
		? { model }
		: {
				model,
				outMessage: OutMessage.RequestedSearch({
					error: next,
					session: undefined,
					variant: undefined,
				}),
			}
}

const search = (
	model: Model,
	context: ModalContext,
	patch: Partial<Omit<ModalContext, "orgId">>,
): Return => ({
	model,
	outMessage: OutMessage.RequestedSearch({
		error: "error" in patch ? patch.error : context.error,
		session: "session" in patch ? patch.session : context.session,
		variant: "variant" in patch ? patch.variant : context.variant,
	}),
})

/** Closing drops the group and its narrowing from the URL; `follow` then closes the dialog. */
const closed = OutMessage.RequestedSearch({ error: undefined, session: undefined, variant: undefined })

export const update = (model: Model, message: Message, context: ModalContext): Return =>
	Message.match<Return>(message, {
		GotDialogMessage: ({ message: inner }) => {
			const step = Dialog.update(model.dialog, inner)
			const lifted = liftDialog(model, step)
			return step.outMessage?._tag === "Closed" ? { ...lifted, outMessage: closed } : lifted
		},
		CompletedFetchDetail: ({ key, result }) => ({
			model: { ...model, detail: Keyed.accept(model.detail, key, result) },
		}),
		CompletedFetchSamples: ({ key, result }) => ({
			model: { ...model, pages: model.pages.map((page) => Keyed.accept(page, key, result)) },
		}),
		ClickedLoadMore: () => loadMore(model, context),
		ClickedSample: ({ index }) =>
			index === currentOf(model)
				? { model: { ...model, isSampleClosed: !model.isSampleClosed } }
				: select(model, context, index),
		PressedModalKey: ({ key }) => {
			switch (key) {
				case "StepUp":
					return step(model, context, -1)
				case "StepDown":
					return step(model, context, 1)
				case "OlderSample":
					return select(model, context, currentOf(model) + 1)
				case "NewerSample":
					return select(model, context, currentOf(model) - 1)
			}
		},
		ClickedStep: ({ offset }) => step(model, context, offset),
		ClickedVariant: ({ variant }) => search(model, context, { variant }),
		ClickedSession: ({ session }) => search(model, context, { session }),
		ClickedClose: () => ({ model, outMessage: closed }),
		ClickedCopyLink: () => ({ model, commands: [CopyErrorLink()] }),
		CompletedCopyLink: ({ isCopied }) => ({
			model: { ...model, linkCopy: isCopied ? "copied" : "failed" },
		}),
		ClickedCopyArguments: ({ text }) => ({ model, commands: [CopyErrorArguments({ text })] }),
		CompletedCopyArguments: ({ isCopied }) => ({
			model: { ...model, argumentsCopy: isCopied ? "copied" : "failed" },
		}),
		ToggledFullArguments: () => ({ model: { ...model, isFullArguments: !model.isFullArguments } }),
		CompletedScrollSample: () => ({ model }),
	})

/** A new group or narrowing starts from its first sample, open. */
const freshSamples = (model: Model, samplesKey: string): Model => ({
	...model,
	samplesKey,
	pages: [],
	selected: 0,
	isSampleClosed: false,
	isFullArguments: false,
	argumentsCopy: "idle",
})
