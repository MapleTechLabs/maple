import type { GithubIntegrationStatus } from "@maple/domain/http"
import { countLabel } from "@maple/ui/lib/format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { heading } from "@maple/views/ui/heading"
import { AppRoute, hrefOf } from "../../route"
import { button, linkButton } from "@maple/views/ui/button"
import { icon } from "@maple/views/ui/icon"
import { item, itemActions, itemContent, itemDescription, itemMedia } from "@maple/views/ui/item"
import { panel } from "@maple/views/ui/panel"
import { refreshButton } from "@maple/views/ui/refresh-button"
import { skeleton, skeletonBlock } from "@maple/views/ui/skeleton"
import { statusDot } from "@maple/views/ui/status-dot"
import { INTEGRATION_FEATURES } from "@maple/domain/integration-features"
import { featureList } from "../kit/feature-list"
import { integrationIconPlate } from "../kit/integration-empty"
import { integrationNotice } from "./kit/notice"
import { Message } from "./message"
import { integrationStatusCard } from "./view-integration-card"
import type { Model } from "./model"
import { ciTracesShown, githubStatusOf } from "./update-github"
import { disconnectDialog } from "./view-disconnect"
import { repositoriesPanels, repoDialogs } from "./view-github-repos"
import { typography } from "@maple/views/ui/typography"
import { hstack, vstack } from "@maple/views/ui/stack"
import { Array as Arr } from "effect"
import { textLink } from "@maple/views/ui/text-link"
import { providerBrand } from "../kit/providers"

const ACCOUNT_TYPE = { organization: "Organization", user: "Personal account" } as const

/** Starts GitHub authorization again, which finds installations made outside Maple too. */
export const githubReconnectButton = (h: H, model: Model, label = "Reconnect GitHub"): Html =>
	button(
		h,
		{
			variant: "outline",
			className: "w-fit",
			isDisabled: model.connect.isStarting || model.githubCard.selectingInstallation !== null,
			isLoading: model.connect.isStarting,
			attributes: [h.OnClick(Message.ClickedConnect())],
		},
		[label],
	)

const needsApprovalNote = (h: H, login: string): Html =>
	typography(h, { size: "sm", tone: "muted", as: "p" }, [
		`Maple could not confirm you are an owner of ${login}: GitHub did not share organization roles with the Maple app. An owner of ${login} can approve the app's pending permission request (organization Settings > GitHub Apps > Review request), then connect again.`,
	])

export const githubInstallationPicker = (h: H, model: Model): ReadonlyArray<Html> => {
	const selection = model.githubCard.selection
	if (selection === null) return []
	const status = githubStatusOf(model)
	const current = status?.accountLogin ?? null
	const replacesCurrent =
		current !== null && Arr.some(selection.installations, (choice) => choice.accountLogin !== current)
	return [
		typography(h, { size: "sm", tone: "muted", as: "p" }, [
			selection.installations.length > 0
				? "Choose the GitHub account to connect to this Maple organization."
				: "No GitHub account is ready to connect yet.",
		]),
		...(replacesCurrent
			? [
					typography(h, { size: "sm", tone: "muted", as: "p" }, [
						status?.connected === true
							? `This Maple organization is connected to ${current}. Choosing a different account replaces it and removes ${current}'s synced repositories and commit history from Maple.`
							: `This Maple organization was connected to ${current} before it lost access. Choosing a different account replaces it and removes ${current}'s synced repositories and commit history from Maple.`,
					]),
				]
			: []),
		vstack(
			h,
			{ gap: "2" },
			Arr.map(selection.installations, (choice) =>
				hstack(
					h,
					{
						gap: "3",
						align: "center",
						justify: "between",
						wrap: true,
						className: "rounded-md border border-border p-3",
					},
					[
						vstack(h, { gap: "1", shrink: true }, [
							typography(h, { size: "sm", weight: "medium", truncate: true }, [
								choice.accountLogin,
							]),
							typography(h, { size: "xs", tone: "muted" }, [
								ACCOUNT_TYPE[choice.accountType],
								" · ",
								choice.repositorySelection === "selected"
									? "Selected repositories"
									: "All repositories",
							]),
						]),
						button(
							h,
							{
								isDisabled: model.githubCard.selectingInstallation !== null,
								isLoading: model.githubCard.selectingInstallation === choice.id,
								attributes: [
									h.AriaLabel(`Connect ${choice.accountLogin}`),
									h.OnClick(
										Message.ClickedSelectGithubInstallation({
											installationId: choice.id,
										}),
									),
								],
							},
							["Connect"],
						),
					],
				),
			),
		),
		...Arr.map(selection.needsApproval, (login) => needsApprovalNote(h, login)),
		...(selection.unavailable > 0
			? [
					typography(h, { size: "sm", tone: "muted", as: "p" }, [
						`${countLabel(selection.unavailable, "installation", "installations")} of the Maple app can't be connected here: another Maple organization already has it, you aren't an admin of its GitHub account, or GitHub didn't answer. Ask an admin of that account, or connect again later.`,
					]),
				]
			: []),
		button(
			h,
			{
				variant: "outline",
				className: "w-fit",
				isDisabled: model.connect.isStarting || model.githubCard.selectingInstallation !== null,
				attributes: [h.OnClick(Message.ClickedOpenGithubInstallPage())],
			},
			[icon(h, "GithubIcon"), "Install on another GitHub account"],
		),
	]
}

/** CI traces switch here; PR review is per repository, so its row counts them and links there. */
export const githubFeatures = (h: H, model: Model, status: GithubIntegrationStatus): Html => {
	const [ciTraces, prReview] = INTEGRATION_FEATURES.github
	const active = Arr.filter(status.repositories, (repo) => repo.status === "active")
	const reviewed = Arr.filter(active, (repo) => repo.prReviewEnabled).length
	return featureList(h, {
		idPrefix: "github",
		className: "bg-card",
		rows: [
			{
				spec: ciTraces,
				isChecked: ciTracesShown(model),
				isDisabled: model.githubCard.isSavingCiTraces,
				onToggle: Message.ToggledCiTraces(),
			},
			{
				spec: prReview,
				link: { href: hrefOf(AppRoute.CodeReviewSettings()), label: "Choose repositories" },
				note: {
					_tag: "Info",
					text: `${reviewed} of ${countLabel(active.length, "repository", "repositories")}`,
				},
			},
		],
	})
}

const connectedView = (h: H, model: Model, status: GithubIntegrationStatus, timeZone: string): Html => {
	const busy = model.connect.isStarting || model.disconnect.isPending
	const login = status.accountLogin
	return h.div(
		[h.Class("space-y-4")],
		[
			item(h, { variant: "card", size: "lg", className: "justify-between" }, [
				itemMedia(h, {}, [statusDot(h, { tone: "ok", size: "lg" })]),
				itemContent(
					h,
					[
						h.div(
							[h.Class("text-sm font-medium [overflow-wrap:anywhere]")],
							[
								"Connected",
								...(login !== null && login !== ""
									? [
											" ",
											"as",
											" ",
											textLink(
												h,
												{
													href: `https://github.com/${login}`,
													tone: "inherit",
													className: "inline font-semibold",
													attributes: [h.Target("_blank"), h.Rel("noreferrer")],
												},
												["@", login],
											),
										]
									: []),
							],
						),
						itemDescription(h, [
							status.accountType === null ? "GitHub App" : ACCOUNT_TYPE[status.accountType],
							" ",
							"· ",
							status.repositorySelection === "selected"
								? "Selected repositories"
								: "All repositories",
						]),
					],
					"leading-tight",
				),
				itemActions(
					h,
					[
						refreshButton(h, {
							onRefresh: Message.ClickedGithubRefresh(),
							isPending: model.githubCard.isRefreshing,
						}),
						button(
							h,
							{
								size: "sm",
								variant: "outline",
								isDisabled: busy,
								isLoading: model.connect.isStarting,
								attributes: [h.OnClick(Message.ClickedConnect())],
							},
							["Edit data"],
						),
						button(
							h,
							{
								size: "sm",
								variant: "outline",
								isDisabled: busy,
								isLoading: model.disconnect.isPending,
								attributes: [h.OnClick(Message.ClickedDisconnect())],
							},
							["Disconnect"],
						),
					],
					"gap-1.5",
				),
			]),
			githubFeatures(h, model, status),
			...repositoriesPanels(h, model, status, timeZone),
		],
	)
}

export const githubCard = (h: H, model: Model, timeZone: string): ReadonlyArray<Html> => {
	const body = integrationStatusCard(h, model.statuses.github, {
		name: "github",
		failureTitle: "Couldn't load the GitHub integration",
		render: (data) => byState(h, model, data, timeZone),
		loading: () => loadingState(h),
		onRetry: Message.ClickedGithubRefresh(),
	})
	return [body, disconnectDialog(h, model, "github"), ...repoDialogs(h, model)]
}

const byState = (h: H, model: Model, status: GithubIntegrationStatus, timeZone: string): Html =>
	model.githubCard.selection !== null
		? vstack(h, { gap: "3" }, githubInstallationPicker(h, model))
		: !status.connected && status.repositoryDiscovery?._tag === "Pending"
			? integrationNotice(h, { message: "Discovering repositories…" })
			: !status.connected && status.repositoryDiscovery?._tag === "Failed"
				? integrationNotice(h, {
						message: status.repositoryDiscovery.message,
						action: githubReconnectButton(h, model),
					})
				: status.connected
					? connectedView(h, model, status, timeZone)
					: status.state === "disconnected" || status.state === "suspended"
						? githubDeactivated(h, model, status)
						: githubReconnect(h)
// TODO(clerk): gate the CI traces switch on org admin; self-hosted is the root admin.

type H = HtmlBuilder<Message>

const BRAND = providerBrand("github")

const loadingState = (h: H): Html =>
	h.div(
		[h.Class("space-y-4")],
		[
			skeletonBlock(h, { height: "16" }),
			panel(h, { className: "overflow-hidden" }, [
				skeleton(h, "h-11 w-full rounded-none"),
				h.div(
					[h.Class("divide-y")],
					Arr.map([0, 1, 2], () => skeleton(h, "m-3 h-9 rounded-md")),
				),
			]),
		],
	)

/** A source page whose installation was removed: the way back is the connect flow. */
const githubReconnect = (h: H): Html =>
	integrationNotice(h, {
		message: "GitHub is not connected.",
		action: linkButton(
			h,
			{ size: "sm", href: hrefOf(AppRoute.SourcesNew({ search: { integration: "github" } })) },
			["Reconnect"],
		),
	})

export const githubDeactivated = (h: H, model: Model, status: GithubIntegrationStatus): Html => {
	const suspended = status.state === "suspended"
	const account =
		status.accountLogin !== null && status.accountLogin !== ""
			? [
					" ",
					"for ",
					typography(h, { tone: "foreground", weight: "medium" }, [`@${status.accountLogin}`]),
				]
			: []
	const repoCount = status.repositories.length
	return vstack(
		h,
		{
			gap: "5",
			align: "center",
			className: "rounded-md border border-severity-warn-a4 bg-severity-warn-a1 px-6 py-10 text-center",
		},
		[
			integrationIconPlate(h, BRAND, {
				size: 26,
				plateClassName: "size-14 rounded-xl",
				overlay: hstack(
					h,
					{
						align: "center",
						justify: "center",
						inline: true,
						as: "span",
						className: "absolute -bottom-1.5 -right-1.5 rounded-full bg-card",
					},
					[icon(h, "CircleWarningIcon", { size: 18, className: "text-severity-warn" })],
				),
			}),
			vstack(h, { gap: "1.5", className: "max-w-md" }, [
				heading(h, { level: 3, variant: "section" }, [
					suspended ? "GitHub integration suspended" : "GitHub integration deactivated",
				]),
				typography(
					h,
					{ size: "sm", tone: "muted", as: "p" },
					suspended
						? [
								"GitHub suspended the Maple GitHub App",
								...account,
								", so syncing is paused. Reactivate it in GitHub, then reconnect to resume.",
							]
						: [
								"The Maple GitHub App was uninstalled (or its access was revoked) on GitHub",
								...account,
								", so syncing is paused. Reconnect to resume; nothing was deleted.",
							],
				),
			]),
			...(repoCount > 0
				? [
						typography(h, { size: "xs", tone: "muted", as: "p" }, [
							countLabel(repoCount, "repository", "repositories"),
							" and their commit history are preserved.",
						]),
					]
				: []),
			vstack(h, { gap: "2", align: "center" }, [
				button(
					h,
					{
						isLoading: model.connect.isStarting,
						attributes: [h.OnClick(Message.ClickedConnect())],
					},
					[icon(h, "ArrowRotateClockwiseIcon"), "Reconnect GitHub"],
				),
				typography(h, { size: "xs", tone: "muted", as: "p" }, [
					"GitHub opens in a new window to reconnect the Maple app.",
				]),
			]),
		],
	)
}
