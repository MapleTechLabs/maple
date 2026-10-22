import { parsePullRequestUrl, type PullRequestSummary } from "@maple/domain/http"
import { TONE_SOFT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import { AsyncData, Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import * as Combobox from "../../../ui/combobox"
import * as ComboboxView from "../../../ui/combobox-view"
import * as SelectView from "../../../ui/select-view"
import * as Dialog from "../../../ui/dialog"
import { badge } from "../../../ui/display"
import { field, fieldLabel } from "../../../ui/field"
import { formDialog } from "../../../ui/form-dialog"
import { input } from "../../../ui/input"
import { PageOutMessage, type PageReturn } from "../../contract"
import { docsLink } from "../../kit/signal-empty-state"
import { LinkPullRequest } from "./command"
import { Message } from "./message"
import type { Model } from "./model"

// The attach pull request dialog: pick a pull request
// of the connected repository (a Select picks it when the org has several), or paste a link.

type Return = PageReturn<Model, Message>
type H = HtmlBuilder<Message>

const IN_FLIGHT_SOFT = "bg-severity-debug/12 text-severity-debug"
const PULL_REQUEST_STATE_TONE = {
	open: IN_FLIGHT_SOFT,
	merged: TONE_SOFT.done,
	closed: TONE_SOFT.neutral,
} satisfies Record<PullRequestSummary["state"], string>

/** The connection and the picker's repository: the suggestion while the org has it, else the first. */
export const githubOf = (model: Model) => {
	const status = Option.getOrNull(AsyncData.getData(model.githubStatus.data))
	const repositories = (status?.repositories ?? []).filter((repo) => repo.status === "active")
	const suggested =
		Option.getOrNull(AsyncData.getData(model.pullRequests.data))?.suggestedRepository ?? null
	const repository =
		model.attachRepository ??
		(suggested !== null && repositories.some((repo) => repo.fullName === suggested)
			? suggested
			: (repositories[0]?.fullName ?? null))
	return { isConnected: status?.state === "connected", repository, repositories }
}

/** `resolveTypedReference`: `#123`, `123` (with a repository) or a full PR URL. */
export const typedPullRequestUrl = (draft: string, repository: string | null): string | null => {
	const trimmed = draft.trim()
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
	const needle = filter.trim().toLowerCase()
	return (
		needle.length === 0 ||
		pr.title.toLowerCase().includes(needle) ||
		String(pr.number).includes(needle.replace("#", "")) ||
		pr.headRef.toLowerCase().includes(needle) ||
		(pr.authorLogin ?? "").toLowerCase().includes(needle)
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
			h.p(
				[h.Class("text-xs text-muted-foreground")],
				[
					h.a(
						[
							h.Class("underline hover:no-underline"),
							h.Href(hrefOf(AppRoute.SourcesNew({ search: { integration: "github" } }))),
						],
						["Connect GitHub"],
					),
					" ",
					"to pick from your repositories instead of pasting a link.",
				],
			),
			docsLink(h, "github", "GitHub integration docs"),
		],
	)

const pullRequestItem = (h: H, pr: PullRequestSummary): ReadonlyArray<Html> => [
	h.div(
		[h.Class("flex min-w-0 flex-col gap-0.5")],
		[
			h.div(
				[h.Class("flex items-center gap-2")],
				[
					h.span(
						[h.Class("truncate text-xs font-medium")],
						["#", String(pr.number), " ", pr.title],
					),
					badge(
						h,
						{
							variant: "outline",
							className: cn("shrink-0 capitalize", PULL_REQUEST_STATE_TONE[pr.state]),
						},
						[pr.isDraft && pr.state === "open" ? "draft" : pr.state],
					),
				],
			),
			h.span(
				[h.Class("truncate text-2xs text-muted-foreground")],
				[pr.headRef, ...(pr.authorLogin ? [` · ${pr.authorLogin}`] : [])],
			),
		],
	),
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
	const visible = pullRequests.filter((pr) => matchesFilter(pr, model.attachDraft))
	const emptyText =
		typedOf(model) !== null
			? "Press Enter to attach the pull request you typed."
			: pullRequests.length === 0
				? "No pull requests in this repository yet."
				: "Nothing matches that search."
	return field(h, { className: "items-stretch gap-1.5", state }, [
		fieldLabel(h, { ids: FIELD_IDS, className: "text-xs text-muted-foreground", state }, "Pull request"),
		h.submodel({
			slotId: model.attachCombobox.id,
			model: model.attachCombobox,
			view: ComboboxView.view,
			toParentMessage: (message) => Message.GotAttachComboboxMessage({ message }),
			viewInputs: {
				items: visible.map((pr) => pr.url),
				placeholder: "Search by title, number, branch, or paste a link",
				emptyText,
				isUnfiltered: true,
				className: "w-full text-xs",
				renderItem: (url) => {
					const pr = visible.find((candidate) => candidate.url === url)
					return pr === undefined ? [url] : pullRequestItem(h, pr)
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
			{ ids: REPOSITORY_IDS, className: "text-xs text-muted-foreground", state },
			"Repository",
		),
		h.submodel({
			slotId: model.repositorySelect.id,
			model: { ...model.repositorySelect, value: value ?? "" },
			view: SelectView.view,
			viewInputs: {
				entries: repositories.map((name) => ({
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
	const names = repositories.map((repo) => repo.fullName)
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
