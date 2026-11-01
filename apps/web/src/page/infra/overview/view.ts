import { countLabel } from "@maple/ui/lib/format"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { button, linkButton } from "../../../ui/button"
import { emptyMessage } from "../../../ui/empty"
import { icon } from "../../../ui/icon"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import * as Frame from "../kit/frame"
import * as InstallModal from "../kit/install-modal"
import * as InstallModalView from "../kit/install-modal-view"
import { pickTimeSearch } from "../kit/view-tabs"
import { Message } from "./message"
import { type Model, SOURCE_IDS, type SourceId } from "./model"
import { sourceMark, SOURCE_TITLE } from "./source-mark"
import { presentSources, sourceState, surfacesOf } from "./state"
import { DEFAULT_PRESET } from "./update"
import { needsAttention, sharedFailure } from "./view-findings"
import { sourcesTable } from "./view-sources"

// `InfraOverviewPage`.

type H = HtmlBuilder<Message>

const toFrame = (message: Frame.Message) => Message.GotFrameMessage({ message })
const openInstall = Message.GotInstallMessage({ message: InstallModal.Message.ClickedOpen() })

const missingMark = (h: H, id: SourceId, isLast: boolean): ReadonlyArray<Html | string> => [
	h.span(
		[h.Class("whitespace-nowrap")],
		[sourceMark(h, id, 12, "inline align-[-2px]"), " ", SOURCE_TITLE[id], isLast ? "." : ","],
	),
	" ",
]

const addSource = (h: H, missing: ReadonlyArray<SourceId>): Html =>
	emptyMessage(h, { dashed: true, className: "@container px-4 py-4 text-left" }, [
		h.div(
			[h.Class("flex flex-col gap-3 @2xl:flex-row @2xl:items-center @2xl:gap-4")],
			[
				h.div(
					[h.Class("flex min-w-0 flex-1 flex-col gap-0.5")],
					[
						h.span([h.Class("text-sm text-foreground")], ["Add a source"]),
						h.span(
							[h.Class("text-xs text-muted-foreground")],
							[
								"Not reporting yet:",
								" ",
								...missing.flatMap((id, index) =>
									missingMark(h, id, index === missing.length - 1),
								),
							],
						),
					],
				),
				h.div(
					[h.Class("grid gap-2 @sm:flex @sm:shrink-0")],
					[
						button(h, { size: "sm", variant: "outline", attributes: [h.OnClick(openInstall)] }, [
							icon(h, "SquareTerminalIcon"),
							"Install a collector",
						]),
						linkButton(h, { size: "sm", href: hrefOf(AppRoute.SourcesNew({ search: {} })) }, [
							"Connect a provider",
							icon(h, "ArrowRightIcon"),
						]),
					],
				),
			],
		),
	])

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const sources = presentSources(surfacesOf(model, inputs.context))
	const missing = sources === null ? [] : SOURCE_IDS.filter((id) => !sources.includes(id))
	const states = sources === null ? null : sources.map((id) => ({ id, state: sourceState(model, id) }))
	const time = pickTimeSearch(model.search)
	// "Needs attention" states a failure every source shares once, so the rows need not repeat it.
	const isFailureExplained = states !== null && sharedFailure(states) !== undefined
	// "connected", not "reporting": presence says a source exists, not that its read just succeeded.
	const description =
		sources === null
			? "Checking which sources report. What needs a look comes first."
			: sources.length > 0
				? isFailureExplained
					? `${countLabel(sources.length, "source")} configured. Status unavailable right now.`
					: `${countLabel(sources.length, "source")} connected. What needs a look comes first.`
				: "Nothing is reporting yet. Install a collector or connect a provider to get started."
	return h.div(
		[h.Class("contents")],
		[
			dashboardPage(
				h,
				{
					title: "Infrastructure",
					description,
					actions: Frame.controls(
						h,
						model.frame,
						{ search: model.search, defaultPreset: DEFAULT_PRESET },
						toFrame,
					),
				},
				[
					h.div(
						[h.Class("space-y-10")],
						[
							...(sources === null || sources.length > 0
								? [
										needsAttention(h, states, time, Message.ClickedRetry()),
										sourcesTable(h, states, time, isFailureExplained),
									]
								: []),
							...(missing.length > 0 ? [addSource(h, missing)] : []),
						],
					),
					h.submodel({
						slotId: "install-modal",
						model: model.install,
						view: InstallModalView.view,
						toParentMessage: (message) => Message.GotInstallMessage({ message }),
					}),
				],
			),
		],
	)
})
