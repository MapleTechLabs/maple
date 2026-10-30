import type { GithubIntegrationStatus } from "@maple/domain/http"
import { countLabel } from "@maple/ui/lib/format"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../route"
import { button, linkButton } from "../../ui/button"
import { errorState } from "../../ui/error-state"
import { icon } from "../../ui/icon"
import { item, itemActions, itemContent, itemDescription, itemMedia } from "../../ui/item"
import { panel } from "../../ui/panel"
import { refreshButton } from "../../ui/refresh-button"
import { settingRow } from "../../ui/setting-row"
import { skeleton } from "../../ui/skeleton"
import { statusDot } from "../../ui/status-dot"
import { switchControl } from "../../ui/switch"
import { integrationIconPlate } from "../infra-integrations/kit/integration-empty"
import { GITHUB_ACCENT } from "./catalog"
import { integrationNotice } from "./kit/notice"
import { Message } from "./message"
import type { Model } from "./model"
import { ciTracesShown } from "./update-github"
import { disconnectDialog } from "./view-disconnect"
import { repositoriesPanels, repoDialogs } from "./view-github-repos"

// `GithubIntegrationCard`.

const ACCOUNT_TYPE = new Map([
	["organization", "Organization"],
	["user", "Personal account"],
])

const ciTracesRow = (h: H, model: Model): Html => {
	const isChecked = ciTracesShown(model)
	return settingRow(h, {
		ids: {
			control: "github-ci-traces-input",
			label: "github-ci-traces-label",
			description: "github-ci-traces-description",
		},
		framed: true,
		className: "bg-card px-4 py-3",
		label: "CI traces and logs",
		description: [
			"Each finished GitHub Actions run becomes a trace under the",
			" ",
			h.span([h.Class("font-mono text-foreground")], ["github-actions"]),
			" service, with a span per job and step. Each job's log lines become logs on the step that wrote them, up to 5 MB per job. Counts toward your usage.",
		],
		filled: isChecked,
		control: switchControl(h, {
			id: "github-ci-traces",
			inputId: "github-ci-traces-input",
			isChecked,
			isFilled: isChecked,
			labelledBy: "github-ci-traces-label",
			describedBy: "github-ci-traces-description",
			onToggle: Message.ToggledCiTraces(),
		}),
	})
}

const connectedView = (h: H, model: Model, status: GithubIntegrationStatus, timeZone: string): Html => {
	const busy = model.connect.isStarting || model.disconnect.isPending
	const active = status.repositories.filter((repo) => repo.status === "active")
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
											h.a(
												[
													h.Href(`https://github.com/${login}`),
													h.Target("_blank"),
													h.Rel("noreferrer"),
													h.Class("font-semibold hover:underline"),
												],
												["@", login],
											),
										]
									: []),
							],
						),
						itemDescription(h, [
							ACCOUNT_TYPE.get(status.accountType ?? "") ?? "GitHub App",
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
			ciTracesRow(h, model),
			settingRow(h, {
				ids: {
					control: "github-pr-review-control",
					label: "github-pr-review-label",
					description: "github-pr-review-description",
				},
				framed: true,
				className: "bg-card px-4 py-3",
				label: "Pull request reviews",
				description: [
					String(active.filter((repo) => repo.prReviewEnabled).length),
					" of ",
					String(active.length),
					" ",
					"repositories reviewed. Rules, models and analytics live in Code Review.",
				],
				control: [
					linkButton(
						h,
						{ size: "sm", variant: "outline", href: hrefOf(AppRoute.CodeReviewSettings()) },
						["Open Code Review"],
					),
				],
			}),
			...repositoriesPanels(h, model, status, timeZone),
		],
	)
}

export const githubCard = (h: H, model: Model, timeZone: string): ReadonlyArray<Html> => {
	const body = AsyncData.match(model.statuses.github.data, {
		onIdle: () => loadingState(h),
		onLoading: () => loadingState(h),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Couldn't load the GitHub integration",
				onRetry: Message.ClickedGithubRefresh(),
			}),
		onStale: ({ data }) => byState(h, model, data, timeZone),
		onRefreshing: (data) => byState(h, model, data, timeZone),
		onSuccess: (data) => byState(h, model, data, timeZone),
	})
	return [body, disconnectDialog(h, model, "github"), ...repoDialogs(h, model)]
}

const byState = (h: H, model: Model, status: GithubIntegrationStatus, timeZone: string): Html =>
	status.connected
		? connectedView(h, model, status, timeZone)
		: status.state === "disconnected" || status.state === "suspended"
			? githubDeactivated(h, model, status)
			: githubReconnect(h)
// TODO(clerk): `useIsOrgAdmin` gates the CI traces switch; self-hosted is the root admin.

type H = HtmlBuilder<Message>

const BRAND = { icon: "GithubIcon", accent: GITHUB_ACCENT, iconClassName: "text-foreground" } as const

const loadingState = (h: H): Html =>
	h.div(
		[h.Class("space-y-4")],
		[
			skeleton(h, "h-16 w-full rounded-md"),
			panel(h, { className: "overflow-hidden" }, [
				skeleton(h, "h-11 w-full rounded-none"),
				h.div(
					[h.Class("divide-y")],
					[0, 1, 2].map(() => skeleton(h, "m-3 h-9 rounded-md")),
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
			? [" ", "for ", h.span([h.Class("font-medium text-foreground")], [`@${status.accountLogin}`])]
			: []
	const repoCount = status.repositories.length
	return h.div(
		[
			h.Class(
				"flex flex-col items-center gap-5 rounded-lg border border-severity-warn/40 bg-severity-warn/5 px-6 py-10 text-center",
			),
		],
		[
			integrationIconPlate(h, BRAND, {
				size: 26,
				plateClassName: "size-14 rounded-xl",
				overlay: h.span(
					[
						h.Class(
							"absolute -bottom-1.5 -right-1.5 inline-flex items-center justify-center rounded-full bg-card",
						),
					],
					[icon(h, "CircleWarningIcon", { size: 18, className: "text-severity-warn" })],
				),
			}),
			h.div(
				[h.Class("flex max-w-md flex-col gap-1.5")],
				[
					h.h3(
						[h.Class("text-base font-semibold")],
						[suspended ? "GitHub integration suspended" : "GitHub integration deactivated"],
					),
					h.p(
						[h.Class("text-sm text-muted-foreground")],
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
				],
			),
			...(repoCount > 0
				? [
						h.p(
							[h.Class("text-xs text-muted-foreground")],
							[
								countLabel(repoCount, "repository", "repositories"),
								" and their commit history are preserved.",
							],
						),
					]
				: []),
			h.div(
				[h.Class("flex flex-col items-center gap-2")],
				[
					button(
						h,
						{
							isLoading: model.connect.isStarting,
							attributes: [h.OnClick(Message.ClickedConnect())],
						},
						[icon(h, "ArrowRotateClockwiseIcon"), "Reconnect GitHub"],
					),
					h.p(
						[h.Class("text-xs text-muted-foreground")],
						["You'll be sent to GitHub to reinstall the Maple app."],
					),
				],
			),
		],
	)
}
