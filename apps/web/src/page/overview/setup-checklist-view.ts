import { ingestUrl } from "../../lib/services/common/ingest-url"
import { getOnboardingSetupHint } from "../../lib/onboarding-intent"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { LoadFailure } from "../../data/load-failure"
import { AppRoute, hrefOf } from "../../route"
import { button } from "../../ui/button"
import { card, cardPanel } from "../../ui/card"
import { copyableField } from "../../ui/copyable-field"
import { eyebrow } from "../../ui/eyebrow"
import { icon } from "../../ui/icon"
import { iconButton } from "../../ui/icon-button"
import { listRow } from "../../ui/list-row"
import { skeleton } from "../../ui/skeleton"
import * as GuidedSetup from "../kit/guided-setup"
import { Message, type Model } from "./setup-checklist"
import { frameworkOf, isMounted, realServices } from "./setup-checklist-update"

type H = HtmlBuilder<Message>

/** `IngestKeysUnavailableNote`: members cannot read the org's ingest keys. */
const keysUnavailable = (h: H): Html =>
	h.p(
		[h.Class("rounded-md border border-dashed bg-muted/40 px-3 py-2 font-prose text-xs text-muted-foreground")],
		[
			"Ask an org admin for your ingest keys, or open ",
			h.a(
				[
					h.Href(hrefOf(AppRoute.Settings({ search: { tab: "ingestion" } }))),
					h.Class("font-medium text-foreground underline underline-offset-2 hover:no-underline"),
				],
				["Settings → Ingestion"],
			),
			".",
		],
	)

/** `ConnectInstructions showCredentials`: the endpoint and the private key beside the tabs. */
const credentials = (h: H, model: Model): Html =>
	h.div(
		[h.Class("space-y-3")],
		[
			eyebrow(h, { variant: "label" }, ["Credentials"]),
			copyableField(h, {
				id: "setup-ingest-endpoint",
				label: "Ingest endpoint",
				value: ingestUrl,
				copy: model.copies.endpoint,
				toCopyMessage: (message) => Message.GotCopyMessage({ field: "endpoint", message }),
			}),
			model.keys._tag === "Failed"
				? keysUnavailable(h)
				: model.keys._tag === "Pending" || model.keys.privateKey === ""
					? h.div(
							[h.Class("space-y-1")],
							[h.span([h.Class("text-xs text-muted-foreground")], ["Private ingest key"]), skeleton(h, "h-8 w-full")],
						)
					: copyableField(h, {
							id: "setup-private-key",
							label: "Private ingest key",
							value: model.keys.privateKey,
							copy: model.copies.privateKey,
							toCopyMessage: (message) => Message.GotCopyMessage({ field: "privateKey", message }),
							masked: { isVisible: model.isPrivateKeyVisible, onToggle: Message.ClickedRevealPrivateKey() },
						}),
		],
	)

/** `GuidedSetup showCredentials`: the stack picker, then credentials beside the boxed tabs. */
const guidedSetup = (h: H, model: Model, framework: string): Html =>
	h.div(
		[h.Class("space-y-4")],
		[
			GuidedSetup.frameworkPicker(h, {
				selected: framework,
				compact: false,
				onSelect: (selected) => Message.ClickedFramework({ framework: selected }),
			}),
			h.div(
				[h.Class("grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-5")],
				[
					credentials(h, model),
					GuidedSetup.connectInstructions(h, {
						slot: "overview-setup",
						framework,
						apiKey: model.keys._tag === "Ready" ? model.keys.privateKey : "",
						setupTabs: model.setupTabs,
						packageTabs: model.packageTabs,
						snippetCopies: model.snippetCopies,
						toSetupTabs: (message) => Message.GotSetupTabsMessage({ message }),
						toPackageTabs: (message) => Message.GotPackageTabsMessage({ message }),
						toSnippetCopy: (snippet, message) => Message.GotSnippetCopyMessage({ snippet, message }),
						variant: "boxed",
					}),
				],
			),
		],
	)

/** "Watching for your first trace…" while the card waits for data. */
const watchingStrip = (h: H): Html =>
	h.div(
		[h.Class("flex items-center gap-2.5 rounded-lg border border-dashed border-primary/30 bg-primary/5 px-4 py-3")],
		[
			icon(h, "PulseIcon", { size: 14, className: "text-primary" }),
			h.span([h.Class("font-prose text-xs text-muted-foreground")], ["Watching for your first trace…"]),
		],
	)

/** `FirstTraceCelebration`: shown once non-demo telemetry is observed. */
const celebration = (h: H, serviceName: string | undefined): Html =>
	card(
		h,
		[
			cardPanel(
				h,
				[
					h.div(
						[h.Class("flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary")],
						[icon(h, "CircleCheckIcon", { size: 20 })],
					),
					h.div(
						[h.Class("min-w-0 flex-1 basis-40")],
						[
							h.p([h.Class("text-sm font-semibold tracking-tight")], ["First trace received — you're live"]),
							h.p(
								[h.Class("mt-0.5 font-prose text-xs text-muted-foreground")],
								[
									serviceName === undefined
										? "We're seeing your telemetry. Jump in to explore."
										: `We're seeing telemetry from ${serviceName}. Open it to explore.`,
								],
							),
						],
					),
					button(
						h,
						{
							size: "sm",
							className: "gap-2 shrink-0 max-sm:order-last max-sm:w-full",
							attributes: [h.OnClick(Message.ClickedExploreTraces())],
						},
						["Explore your traces", icon(h, "RocketIcon", {})],
					),
					button(
						h,
						{
							variant: "ghost",
							size: "sm",
							className: "size-8 p-0 shrink-0",
							attributes: [h.AriaLabel("Dismiss"), h.OnClick(Message.ClickedDismissCelebration())],
						},
						[icon(h, "XmarkIcon", {})],
					),
				],
				"flex flex-wrap items-center gap-4 p-5",
			),
		],
		"mb-4 shrink-0 border-primary/40 bg-primary/[0.04] overflow-hidden",
	)

/** `SetupChecklistCard` while waiting: the collapsible "Connect your app" card. */
const waitingCard = (h: H, model: Model, isExpanded: boolean, framework: string, intents: Parameters<typeof getOnboardingSetupHint>[0]): Html =>
	card(
		h,
		[
			h.div(
				[h.Class("flex items-center justify-between gap-4 pr-3")],
				[
					listRow(h, {
						onClick: Message.ClickedToggleExpanded(),
						className: "flex-1 px-5 py-4 hover:bg-muted/30",
						leading: h.span(
							[h.Class("flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary")],
							[icon(h, "CodeIcon", { size: 16 })],
						),
						title: "Connect your app to see real data",
						meta: h.span([h.Class("font-prose")], [getOnboardingSetupHint(intents)]),
					}),
					h.div(
						[h.Class("flex items-center gap-1 shrink-0")],
						[
							iconButton(
								h,
								{
									size: "icon",
									label: isExpanded ? "Collapse" : "Expand",
									attributes: [h.OnClick(Message.ClickedToggleExpanded())],
								},
								[icon(h, isExpanded ? "ChevronUpIcon" : "ChevronDownIcon", {})],
							),
							iconButton(
								h,
								{
									size: "icon",
									label: "Dismiss setup checklist",
									attributes: [h.OnClick(Message.ClickedDismiss())],
								},
								[icon(h, "XmarkIcon", {})],
							),
						],
					),
				],
			),
			h.div(
				[
					h.Class("grid transition-[grid-template-rows] duration-200 ease-out"),
					h.Style({ "grid-template-rows": isExpanded ? "1fr" : "0fr" }),
				],
				[
					h.div(
						[h.Class("overflow-hidden")],
						[
							cardPanel(
								h,
								[guidedSetup(h, model, framework), watchingStrip(h)],
								"border-t border-primary/20 p-5 space-y-5",
							),
						],
					),
				],
			),
		],
		"mb-4 shrink-0 border-primary/30 bg-primary/[0.02] overflow-hidden",
	)

/** The first read's failure while the card is mounted; the page's error strip shows it. */
export const setupFailure = (model: Model): LoadFailure | undefined =>
	isMounted(model) && AsyncData.isFailure(model.services) ? model.services.error : undefined

/**
 * `SetupChecklist`: nothing once dismissed, until the first read says whether data arrived, or
 * when it failed (the page's strip says so), the celebration once connected, else the card.
 */
const setupChecklist = (h: H, model: Model): Html => {
	const state = model.state
	if (state === null || !isMounted(model)) return h.empty
	if (!AsyncData.hasData(model.services)) return h.empty
	const first = realServices(model)[0]
	if (first !== undefined) return celebration(h, first.serviceName)
	return waitingCard(h, model, state.checklistExpanded, frameworkOf(state), state.qualifyAnswers.intents)
}

export const view = Submodel.defineView<Model, Message>((model, h) => setupChecklist(h, model))
