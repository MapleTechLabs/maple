import { parsePullRequestUrl, type PullRequestSummary } from "@maple/domain/http"
import { TONE_SOFT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { Option, Array as Arr, String as Str } from "effect"
import { AsyncData, Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import * as Combobox from "@maple/views/ui/combobox"
import * as ComboboxView from "@maple/views/ui/combobox-view"
import * as SelectView from "@maple/views/ui/select-view"
import * as Dialog from "@maple/views/ui/dialog"
import { badge } from "@maple/views/ui/display"
import { field, fieldLabel } from "@maple/views/ui/field"
import { formDialog } from "@maple/views/ui/form-dialog"
import { input } from "@maple/views/ui/input"
import { PageOutMessage, type PageReturn } from "../../contract"
import { docsLink } from "../../kit/signal-empty-state"
import { LinkPullRequest } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { hstack, vstack } from "@maple/views/ui/stack"
import { textLink } from "@maple/views/ui/text-link"

// The attach pull request dialog: pick a pull request
// of the connected repository (a Select picks it when the org has several), or paste a link.

type Return = PageReturn<Model, Message>
type H = HtmlBuilder<Message>

const IN_FLIGHT_SOFT = "bg-severity-debug-a2 text-severity-debug"
const PULL_REQUEST_STATE_TONE = {
	open: IN_FLIGHT_SOFT,
	merged: TONE_SOFT.done,
	closed: TONE_SOFT.neutral,
} satisfies Record<PullRequestSummary["state"], string>

/** The connection and the picker's repository: the suggestion while the org has it, else the first. */
export const githubOf = (model: Model) => {
	const status = Option.getOrNull(AsyncData.getData(model.githubStatus.data))
	const repositories = Arr.filter(status?.repositories ?? [], (repo) => repo.status === "active")
	const suggested =
		Option.getOrNull(AsyncData.getData(model.pullRequests.data))?.suggestedRepository ?? null
	const repository =
		model.attachRepository ??
		(suggested !== null && Arr.some(repositories, (repo) => repo.fullName === suggested)
			? suggested
			: (repositories[0]?.fullName ?? null))
	return { isConnected: status?.state === "connected", repository, repositories }
}

/** `resolveTypedReference`: `#123`, `123` (with a repository) or a full PR URL. */
export const typedPullRequestUrl = (draft: string, repository: string | null): string | null => {
	const trimmed = Str.trim(draft)
	if (trimmed.length === 0) return null
	const parsed = parsePullRequestUrl(trimmed)
	if (parsed !== null) return parsed.url
	const bare = /^#?(\d+)$/.exec(trimmed)
	if (bare === null || repository === null) return null
	const number = Number.parseInt(bare[1] ?? "", 10)
	return Number.isSafeInteger(number) && number > 0
		? `https://github.com/${repository}/pull/${number}`
		: null
}

const typedOf = (model: Model) => typedPullRequestUrl(model.attachDraft, githubOf(model).repository)

const matchesFilter = (pr: PullRequestSummary, filter: string): boolean => {
	const needle = Str.toLowerCase(Str.trim(filter))
	return (
		needle.length === 0 ||
		Str.includes(needle)(Str.toLowerCase(pr.title)) ||
		Str.includes(Str.replace("#", "")(needle))(String(pr.number)) ||
		Str.includes(needle)(Str.toLowerCase(pr.headRef)) ||
		Str.includes(needle)(Str.toLowerCase(pr.authorLogin ?? ""))
	)
}

const pullRequestsOf = (model: Model): ReadonlyArray<PullRequestSummary> =>
	Option.getOrNull(AsyncData.getData(model.vcsPullRequests.data))?.pullRequests ?? []

const liftDialog = (
	model: Model,
	step: Update.ReturnWithOutMessage<Dialog.Model, Dialog.Message, Dialog.OutMessage>,
): Return => ({
	model: { ...model, attachDialog: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) =>
		Message.GotAttachDialogMessage({ message }),
	),
})

export const openAttach = (model: Model): Return => liftDialog(model, Dialog.open(model.attachDialog))

export const clearedAttach = (model: Model): Model => ({
	...model,
	attachDraft: "",
	attachRepository: null,
	attachCombobox: Combobox.init(model.attachCombobox.id, "single"),
})

/** `close`: what was typed and the picked repository are cleared whichever way the dialog closes. */
export const attachDialogStep = (model: Model, message: Dialog.Message): Return => {
	const step = Dialog.update(model.attachDialog, message)
	const lifted = liftDialog(model, step)
	return step.outMessage?._tag === "Closed" ? { ...lifted, model: clearedAttach(lifted.model) } : lifted
}

const attach = (model: Model, url: string | null): Return =>
	url === null || model.isAttaching
		? { model }
		: {
				model: { ...model, isAttaching: true },
				commands: [LinkPullRequest({ issueId: model.issueId, url })],
			}

export const submittedAttach = (model: Model): Return => attach(model, typedOf(model))

/** The picker: typing filters, Enter on a typed reference attaches it, a picked row attaches its URL. */
export const attachComboboxStep = (model: Model, message: Combobox.Message): Return => {
	if (message._tag === "PressedInputKey" && message.key === "Enter" && typedOf(model) !== null)
		return submittedAttach(model)
	const step = Combobox.update(model.attachCombobox, message)
	const next: Model = { ...model, attachCombobox: step.model, attachDraft: step.model.inputValue }
	const commands = Command.mapMessages(step.commands ?? [], (inner) =>
		Message.GotAttachComboboxMessage({ message: inner }),
	)
	if (step.outMessage?._tag !== "ChangedValue") return { model: next, commands }
	// `value={null}`: the pick attaches, the input keeps what was typed.
	const picked = attach({ ...next, attachDraft: model.attachDraft }, step.outMessage.value)
	return { ...picked, commands: [...commands, ...(picked.commands ?? [])] }
}

/** A failure keeps the dialog open with the reference still in it; success closes it and toasts. */
export const completedAttach = (
	model: Model,
	isOk: boolean,
	failure: { readonly title: string; readonly message: string } | null,
): Return => {
	const settled = { ...model, isAttaching: false }
	if (!isOk)
		return {
			model: settled,
			outMessage: PageOutMessage.RequestedToast({
				type: "error",
				title: failure?.title ?? "",
				description: failure?.message ?? "",
			}),
		}
	const closed = liftDialog(clearedAttach(settled), Dialog.close(settled.attachDialog))
	return {
		...closed,
		outMessage: PageOutMessage.RequestedToast({
			type: "success",
			title: "Pull request attached",
			description: "",
		}),
	}
}

const pasteField = (h: H, model: Model): Html =>
	h.div(
		[h.Class("space-y-2")],
		[
			input(h, {
				id: "issue-attach-pr-url",
				attributes: [
					h.Value(model.attachDraft),
					h.Placeholder("https://github.com/owner/repo/pull/123"),
					h.OnInput((value) => Message.ChangedAttachDraft({ value })),
				],
			}),
			typography(h, { size: "xs", tone: "muted", as: "p" }, [
				textLink(
					h,
					{
						href: hrefOf(AppRoute.SourcesNew({ search: { integration: "github" } })),
						tone: "inherit",
						className: "inline underline hover:no-underline active:no-underline",
					},
					["Connect GitHub"],
				),
				" ",
				"to pick from your repositories instead of pasting a link.",
			]),
			docsLink(h, "github", "GitHub integration docs"),
		],
	)

const pullRequestItem = (h: H, pr: PullRequestSummary): ReadonlyArray<Html> => [
	vstack(h, { gap: "0.5", shrink: true }, [
		hstack(h, { gap: "2" }, [
			typography(h, { size: "xs", weight: "medium", truncate: true }, [
				"#",
				String(pr.number),
				" ",
				pr.title,
			]),
			badge(
				h,
				{
					variant: "outline",
					className: cn("shrink-0 capitalize", PULL_REQUEST_STATE_TONE[pr.state]),
				},
				[pr.isDraft && pr.state === "open" ? "draft" : pr.state],
			),
		]),
		typography(h, { size: "2xs", tone: "muted", truncate: true }, [
			pr.headRef,
			...(pr.authorLogin ? [` · ${pr.authorLogin}`] : []),
		]),
	]),
]

const FIELD_IDS = {
	control: "issue-attach-pr-input",
	label: "issue-attach-pr-label",
	error: "issue-attach-pr-error",
}

const pickerField = (h: H, model: Model): Html => {
	const state = {
		isInvalid: false,
		isDirty: false,
		isFilled: model.attachDraft !== "",
		isFocused: model.attachDialog.isOpen,
		isTouched: false,
	}
	const pullRequests = pullRequestsOf(model)
	const visible = Arr.filter(pullRequests, (pr) => matchesFilter(pr, model.attachDraft))
	const emptyText =
		typedOf(model) !== null
			? "Press Enter to attach the pull request you typed."
			: pullRequests.length === 0
				? "No pull requests in this repository yet."
				: "Nothing matches that search."
	return field(h, { className: "items-stretch gap-1.5", state }, [
		fieldLabel(
			h,
			{ ids: FIELD_IDS, className: typographyClass({ size: "xs", tone: "muted" }), state },
			"Pull request",
		),
		h.submodel({
			slotId: model.attachCombobox.id,
			model: model.attachCombobox,
			view: ComboboxView.view,
			toParentMessage: (message) => Message.GotAttachComboboxMessage({ message }),
			viewInputs: {
				items: Arr.map(visible, (pr) => pr.url),
				placeholder: "Search by title, number, branch, or paste a link…",
				emptyText,
				isUnfiltered: true,
				className: "w-full text-xs",
				renderItem: (url) => {
					return Option.match(
						Arr.findFirst(visible, (candidate) => candidate.url === url),
						{ onNone: () => [url], onSome: (pr) => pullRequestItem(h, pr) },
					)
				},
				toView: ({ field: group, rest }) => h.div([h.Class("contents")], [group, ...rest]),
			},
		}),
	])
}

const REPOSITORY_IDS = {
	control: "issue-attach-repository-trigger",
	label: "issue-attach-repository-label",
	error: "issue-attach-repository-error",
}

/** The repository `Select`, shown when the org has more than one. */
const repositoryField = (
	h: H,
	model: Model,
	repositories: ReadonlyArray<string>,
	value: string | null,
): Html => {
	const state = {
		isInvalid: false,
		isDirty: false,
		isFilled: value !== null,
		isFocused: false,
		isTouched: false,
	}
	return field(h, { className: "items-stretch gap-1.5", state }, [
		fieldLabel(
			h,
			{ ids: REPOSITORY_IDS, className: typographyClass({ size: "xs", tone: "muted" }), state },
			"Repository",
		),
		h.submodel({
			slotId: model.repositorySelect.id,
			model: { ...model.repositorySelect, value: value ?? "" },
			view: SelectView.view,
			viewInputs: {
				entries: Arr.map(repositories, (name) => ({
					_tag: "Item" as const,
					item: { value: name, label: name },
				})),
				labelledBy: REPOSITORY_IDS.label,
				size: "sm",
				className: "w-full text-xs",
				renderValue: (picked) => [picked === "" ? "Pick a repository" : picked],
				toView: (parts) => h.div([h.Class("contents")], parts),
			},
			toParentMessage: (message) => Message.GotRepositorySelectMessage({ message }),
		}),
	])
}

export const attachDialog = (h: H, model: Model): Html => {
	const { isConnected, repositories, repository } = githubOf(model)
	const names = Arr.map(repositories, (repo) => repo.fullName)
	return formDialog(h, {
		slotId: "issue-attach-pr",
		model: model.attachDialog,
		toParentMessage: (message) => Message.GotAttachDialogMessage({ message }),
		title: "Attach a pull request",
		description:
			"Once it merges, Maple checks whether this error actually stopped before closing the issue.",
		onSubmit: Message.SubmittedAttach(),
		submitLabel: "Attach",
		isPending: model.isAttaching,
		isSubmitDisabled: typedOf(model) === null,
		// The attach dialog closes without handing focus back to the Attach button.
		isReturningFocus: false,
		panelClassName: "space-y-3",
		fields: isConnected
			? [
					...(names.length > 1 ? [repositoryField(h, model, names, repository)] : []),
					pickerField(h, model),
				]
			: [pasteField(h, model)],
	})
}
