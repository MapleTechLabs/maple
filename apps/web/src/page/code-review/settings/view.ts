import { isUnexpectedError } from "@maple/web-data/lib/error-messages"
import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { linkButton } from "../../../ui/button"
import * as DialogView from "../../../ui/dialog-view"
import { emptyMessage } from "../../../ui/empty"
import { errorState } from "../../../ui/error-state"
import { icon } from "../../../ui/icon"
import { panel } from "../../../ui/panel"
import type * as Select from "../../../ui/select"
import { view as selectView } from "../../../ui/select-view"
import { settingRow } from "../../../ui/setting-row"
import { skeleton } from "../../../ui/skeleton"
import type { PageViewInputs } from "../../contract"
import { codeReviewLayout } from "../kit/layout"
import type * as RulesForm from "../rules-form/form"
import * as RulesFormView from "../rules-form/view"
import { Message, type Model } from "./model"
import { repositoryList } from "./repositories"
import {
	activeRepositories,
	isRepoEnabled,
	DEFAULT_MODEL,
	DEFAULT_MODEL_LABEL,
	MODEL_OPTIONS,
} from "./update"

// `CodeReviewSettingsView`: the code review settings page.

type H = HtmlBuilder<Message>

/** `SettingsSection`: heading and description, then the content, framed in a padded Panel or not. */
const settingsSection = (
	h: H,
	options: Readonly<{ id: string; title: string; description: string; isFramed: boolean }>,
	children: ReadonlyArray<Html>,
): Html =>
	h.section(
		[h.AriaLabelledBy(options.id), h.Class("flex scroll-mt-6 flex-col gap-3 w-full max-w-3xl")],
		[
			h.div(
				[h.Class("space-y-1")],
				[
					h.div(
						[h.Class("flex items-baseline gap-2.5")],
						[
							h.h2(
								[h.Class("text-sm font-medium text-foreground"), h.Id(options.id)],
								[options.title],
							),
						],
					),
					h.p([h.Class("text-sm text-muted-foreground")], [options.description]),
				],
			),
			...(options.isFramed ? [panel(h, { padded: true }, children)] : children),
		],
	)

const MODEL_ENTRIES = [
	{ _tag: "Item" as const, item: { value: DEFAULT_MODEL, label: DEFAULT_MODEL_LABEL } },
	...MODEL_OPTIONS.map((model) => ({
		_tag: "Item" as const,
		item: { value: model.id, label: model.label },
	})),
]

const modelSetting = (h: H, model: Model): Html =>
	settingRow(h, {
		ids: {
			control: "code-review-model-control",
			label: "code-review-model-label",
			description: "code-review-model-description",
		},
		framed: true,
		filled: true,
		className: "bg-card px-5 py-4",
		label: "Review model",
		description: "Runs pull request reviews and replies.",
		control: [
			h.submodel({
				slotId: model.modelSelect.id,
				model: model.modelSelect,
				view: selectView,
				toParentMessage: (message: Select.Message) => Message.GotModelSelectMessage({ message }),
				viewInputs: {
					entries: MODEL_ENTRIES,
					size: "sm",
					ariaLabel: "Review model",
					className: "w-56",
					isDisabled: !model.isAdmin || model.isSavingModel,
					toView: (parts) =>
						h.div(
							[
								h.Class("contents"),
								...(model.isAdmin
									? []
									: [h.Title("Only admins can change the review model")]),
							],
							parts,
						),
				},
			}),
		],
	})

const formView = (h: H, form: RulesForm.Model, isAdmin: boolean, wrap: (m: RulesForm.Message) => Message) =>
	h.submodel({
		slotId: `${form.id}-form`,
		model: form,
		view: RulesFormView.view,
		viewInputs: { isAdmin },
		toParentMessage: wrap,
	})

const notConnected = (h: H, isConnected: boolean): Html =>
	emptyMessage(h, { dashed: true, className: "flex flex-col items-start gap-3 px-5 py-6 text-left" }, [
		h.div(
			[h.Class("flex items-center gap-2 text-sm font-medium text-foreground")],
			[
				icon(h, "GithubIcon", { size: 16 }),
				isConnected ? "No repositories yet" : "Connect GitHub to review pull requests",
			],
		),
		h.p(
			[h.Class("text-sm text-muted-foreground")],
			[
				isConnected
					? "Grant the Maple GitHub App access to a repository, and it appears here."
					: "Maple reviews pull requests through its GitHub App. Install it on the repositories you want reviewed.",
			],
		),
		linkButton(
			h,
			{
				variant: "outline",
				size: "sm",
				href: hrefOf(AppRoute.SourcesNew({ search: { integration: "github" } })),
			},
			[isConnected ? "Manage GitHub access" : "Connect GitHub"],
		),
	])

const repositoriesSection = (h: H, model: Model): Html =>
	AsyncData.matchData(model.githubStatus.data, {
		onEmpty: () => skeleton(h, "h-40 w-full rounded-md"),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Failed to load repositories",
				onRetry: Message.ClickedRetryStatus(),
			}),
		onData: (status) => {
			const repositories = activeRepositories(model)
			if (!status.connected || repositories.length === 0) return notConnected(h, status.connected)
			return repositoryList(h, {
				repositories,
				state: model.repoList,
				isAdmin: model.isAdmin,
				busy: model.busy,
				isEnabled: (repo) => isRepoEnabled(model, repo),
				onSearch: (value) => Message.ChangedRepoSearch({ value }),
				onFilter: (filter) => Message.PickedRepoFilter({ filter }),
				onShowAll: Message.ClickedShowAllRepos(),
				onToggle: (repo) =>
					Message.ToggledRepo({
						repositoryId: repo.id,
						fullName: repo.fullName,
						isEnabled: !isRepoEnabled(model, repo),
					}),
				onConfigure: (repo) => Message.ClickedConfigure({ repositoryId: repo.id }),
			})
		},
	})

/** `RepositoryConfig` in its dialog: skeleton, the error line, or the repository's rules form. */
const repoConfigBody = (h: H, model: Model): Html =>
	AsyncData.matchData(model.repoConfig.data, {
		onEmpty: () =>
			h.div(
				[h.Class("space-y-3")],
				[skeleton(h, "h-20 w-full"), skeleton(h, "h-16 w-full"), skeleton(h, "h-8 w-1/2")],
			),
		onFailure: (failure) =>
			h.p(
				[h.Class("text-xs text-severity-error"), h.Role("alert")],
				[isUnexpectedError(failure) ? "Failed to load the repository's rules." : failure.message],
			),
		onData: () =>
			model.repoForm === null
				? h.empty
				: formView(h, model.repoForm, model.isAdmin, (message) =>
						Message.GotRepoFormMessage({ message }),
					),
	})

const repoDialog = (h: H, model: Model): Html => {
	const repo = activeRepositories(model).find((candidate) => candidate.id === model.configuring)
	const id = model.dialog.id
	return h.submodel({
		slotId: `${id}-view`,
		model: model.dialog,
		view: DialogView.view,
		toParentMessage: (message) => Message.GotDialogMessage({ message }),
		viewInputs: {
			className: "sm:max-w-2xl",
			hasTrigger: false,
			toView: ({ portal }) => portal ?? h.empty,
			toContent: () => [
				DialogView.dialogHeader(h, "dialog", [
					DialogView.dialogTitle(h, "dialog", id, "Repository rules"),
					DialogView.dialogDescription(
						h,
						"dialog",
						id,
						`${repo?.fullName ?? ""}. Anything left on the organization default follows the default review rules.`,
					),
				]),
				DialogView.dialogPanel(h, "dialog", id, [repoConfigBody(h, model)]),
			],
		},
	})
}

const content = (h: H, model: Model): Html =>
	AsyncData.matchData(model.settings.data, {
		onEmpty: () =>
			h.div(
				[h.Class("flex flex-col gap-6")],
				[skeleton(h, "h-20 w-full rounded-md"), skeleton(h, "h-[520px] w-full rounded-md")],
			),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Failed to load review settings",
				onRetry: Message.ClickedRetrySettings(),
			}),
		onData: () =>
			h.div(
				[h.Class("flex flex-col gap-10 w-full max-w-3xl")],
				[
					settingsSection(
						h,
						{
							id: "code-review-settings-reviewer",
							title: "Reviewer",
							description: "The model every review and reply in this organization runs on.",
							isFramed: false,
						},
						[modelSetting(h, model)],
					),
					settingsSection(
						h,
						{
							id: "code-review-settings-defaults",
							title: "Default review rules",
							description:
								"Every repository starts from these. A repository can override any of them.",
							isFramed: true,
						},
						Option.match(Option.fromNullishOr(model.defaultsForm), {
							onNone: () => [],
							onSome: (form) => [
								formView(h, form, model.isAdmin, (message) =>
									Message.GotDefaultsFormMessage({ message }),
								),
							],
						}),
					),
					settingsSection(
						h,
						{
							id: "code-review-settings-repositories",
							title: "Repositories",
							description:
								"Pick which repositories get reviews, and tune any of them on its own.",
							isFramed: false,
						},
						[repositoriesSection(h, model)],
					),
				],
			),
	})

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, _inputs, h) =>
	codeReviewLayout(
		{
			h,
			active: "settings",
			search: {},
			overlay: repoDialog(h, model),
		},
		[content(h, model)],
	),
)
