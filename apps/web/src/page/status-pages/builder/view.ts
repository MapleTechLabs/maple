import {
	StatusPageComponentId,
	StatusPageComponentStatus,
	StatusPageId,
	UptimeMonitorId,
} from "@maple/domain"
import {
	DEFAULT_STATUS_PAGE_THEME,
	deriveComponentStatus,
	STATUS_PAGE_PRESET_DEFAULTS,
	StatusPageSlug,
} from "@maple/domain/status-page"
import { previewSnapshot } from "@maple/status-page"
import { Option, Schema, Array as Arr, String as Str } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { failureMessage } from "@maple/views/data/load-failure"
import { alert, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { actionBar } from "@maple/views/ui/action-bar"
import { button, linkButton } from "@maple/views/ui/button"
import { errorState } from "@maple/views/ui/error-state"
import { icon } from "@maple/views/ui/icon"
import { segmentedSelect } from "@maple/views/ui/segmented-select"
import { sidePanelSheet } from "@maple/views/ui/sheet"
import { skeleton } from "@maple/views/ui/skeleton"
import { heading } from "@maple/views/ui/heading"
import { textLink } from "@maple/views/ui/text-link"
import { agentPromptButton } from "../../kit/guided-setup"
import { codeBlock } from "../../kit/code-block"
import { claudeCodeCommand, cursorInstallUrl, vscodeInstallUrl } from "../../kit/mcp-client-config"
import { docsUrl } from "../../kit/docs"
import { mcpUrl } from "../../../platform/mcp-url"
import { AppRoute, hrefOf } from "../../../route"
import { statusPageAgentPrompt } from "./agent-prompt"
import { methodChoice } from "./setup-choice"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { resourceNotFound } from "../../kit/resource-not-found"
import { settingsSection } from "../../kit/settings-section"
import {
	newStatusPageHref,
	publicAddressOf,
	publicUrlOf,
	STATUS_PAGE_BASE_URL,
	statusPagesHref,
} from "../shared/commands"
import { textField } from "../shared/fields"
import { APPEARANCES, presetCards } from "../shared/look"
import { monitorStatusOf } from "../shared/derive"
import { orNull } from "../shared/form"
import { componentFields, componentList, removeButton, sourceLine } from "../shared/component-list"
import { groupPickerField, groupsOf } from "../shared/group-picker"
import { checkedRows, hasRowIssues } from "../shared/picker"
import { pickerView } from "../shared/picker-view"
import { daysOf, previewDocument, previewFrame, previewTheme } from "../shared/preview"
import { FocusNewRow } from "./command"
import { Message } from "./message"
import { canManage, type DraftRow, type Model } from "./model"
import {
	ADD_PICKER_ID,
	canSubmit,
	customDomainError,
	DOMAIN_ID,
	FIELDS_ID,
	gripIdOf,
	groupGripIdOf,
	monitorsOf,
	NAME_ID,
	nameIssue,
	orderedRows,
	rowIdOf,
	SLUG_ID,
	slugError,
} from "./update"
import { typography } from "@maple/views/ui/typography"
import { hstack, vstack, vstackClass } from "@maple/views/ui/stack"

// `/status-pages/new`: the form on the left, the page as visitors get it on the right, and the
// publish bar under both. Below 1000px the preview stacks under the form.

type H = HtmlBuilder<Message>

const isSlug = Schema.is(StatusPageSlug)
const decodeMonitorId = Schema.decodeUnknownOption(UptimeMonitorId)
const decodeStatus = Schema.decodeUnknownOption(StatusPageComponentStatus)
const DRAFT_PAGE_ID = Schema.decodeSync(StatusPageId)("00000000-0000-4000-8000-000000000000")
const draftComponentId = (index: number) =>
	Schema.decodeSync(StatusPageComponentId)(
		`00000000-0000-4000-8000-${Str.padStart(12, "0")(String(index + 1))}`,
	)

const pageSection = (h: H, model: Model): Html =>
	settingsSection(h, { id: "status-page-builder-page", title: "Page" }, [
		vstack(h, { gap: "4" }, [
			textField(h, {
				id: NAME_ID,
				label: "Name",
				value: model.name,
				placeholder: "Acme Status",
				error: nameIssue(model),
				onInput: (value) => Message.ChangedName({ value }),
				onBlur: Message.BlurredName(),
			}),
			textField(h, {
				id: SLUG_ID,
				label: "Address",
				value: model.slug,
				placeholder: "acme-status",
				isMono: true,
				hint:
					model.slug === ""
						? "Follows the name until you type one."
						: // A blank hint of the same height until the org key lands.
							Option.getOrElse(publicAddressOf(model.orgKey, model.slug), () => "\u00a0"),
				error: slugError(model),
				onInput: (value) => Message.ChangedSlug({ value }),
			}),
		]),
	])

/** A short numbered list of muted lines: how something works, in order. */
const numberedSteps = (h: H, steps: ReadonlyArray<Html | string>): Html =>
	h.ol(
		[h.Class(vstackClass({ gap: "2" }))],
		Arr.map(steps, (step, index) =>
			hstack(h, { gap: "2.5", align: "start", as: "li", attributes: [h.Key(String(index))] }, [
				typography(h, { size: "xs", tone: "muted", mono: true, className: "shrink-0" }, [
					String(index + 1),
				]),
				typography(h, { size: "xs", tone: "muted" }, [step]),
			]),
		),
	)

const DOMAIN_STEPS: ReadonlyArray<string> = [
	"Pick a subdomain you own, like status.acme.com. A bare domain (acme.com) can't point at Maple.",
	"Once the page is created, Maple shows the DNS records to add at your DNS provider: a CNAME from that subdomain to Maple, and a TXT record that proves you own it.",
	"Maple checks the record and issues the HTTPS certificate, usually within minutes. Until then visitors use the page's Maple address.",
]

const domainSection = (h: H, model: Model): Html =>
	settingsSection(
		h,
		{
			id: "status-page-builder-domain",
			title: "Custom domain",
			description: ["Optional. Serve the page on your own subdomain instead of its Maple address."],
		},
		[
			vstack(h, { gap: "4" }, [
				textField(h, {
					id: DOMAIN_ID,
					label: "Domain",
					value: model.customDomain,
					placeholder: "status.acme.com",
					isMono: true,
					isDisabled: model.submitting !== null,
					hint: "Leave it empty to add one later under Settings.",
					error: customDomainError(model),
					onInput: (value) => Message.ChangedCustomDomain({ value }),
				}),
				vstack(h, { gap: "2" }, [
					typography(h, { size: "xs", weight: "medium", tone: "muted", as: "p" }, ["How it works"]),
					numberedSteps(h, DOMAIN_STEPS),
				]),
			]),
		],
	)

const ROW_HINT_ID = "status-page-builder-reorder-hint"

/** A row's status as the page would show it today: its override, else its monitor's reading. */
const rowStatus = (model: Model, row: DraftRow): StatusPageComponentStatus =>
	deriveComponentStatus({
		monitorStatus: monitorStatusOf(
			monitorsOf(model),
			Option.getOrNull(decodeMonitorId(row.form.monitorId)),
		),
		manualStatus: Option.getOrNull(decodeStatus(row.form.manualStatus)),
		incidentStatuses: [],
	})

const rowBody = (h: H, model: Model, row: DraftRow): ReadonlyArray<Html> => [
	...componentFields(h, {
		idPrefix: FIELDS_ID,
		form: row.form,
		monitors: monitorsOf(model),
		isReadOnly: model.submitting !== null,
		onField: (field, value) => Message.ChangedRowField({ field, value }),
		onToggleUptime: Message.ToggledRowUptime(),
		group: groupPickerField(h, {
			picker: model.groupPicker,
			groups: groupsOf(Arr.map(model.rows, (entry) => orNull(entry.form.group))),
			current: row.form.group,
			isDisabled: model.submitting !== null,
			toMessage: (message) => Message.GotGroupPickerMessage({ message }),
		}),
	}),
	hstack(h, {}, [
		removeButton(h, {
			isDisabled: model.submitting !== null,
			onClick: Message.ClickedRemoveRow({ key: row.key }),
		}),
	]),
]

const componentRows = (h: H, model: Model): Html =>
	componentList(h, {
		grants: model,
		isReorderBusy: model.submitting !== null,
		hintId: ROW_HINT_ID,
		onMoveGroup: (group, offset) => Message.PressedMoveGroup({ group, offset }),
		groupGripId: groupGripIdOf,
		rows: Arr.map(orderedRows(model), (row) => {
			const isOpen = model.openKey === row.key
			const name = Str.trim(row.form.name)
			return {
				key: row.key,
				name: name === "" ? "Untitled component" : name,
				group: orNull(row.form.group),
				status: rowStatus(model, row),
				source: sourceLine(monitorsOf(model), row.form.monitorId),
				isOpen,
				rowId: rowIdOf(row.key),
				gripId: gripIdOf(row.key),
				onToggle: Message.ClickedRow({ key: row.key }),
				onMove: (offset) => Message.PressedMoveRow({ key: row.key, offset }),
				body: isOpen ? rowBody(h, model, row) : [],
			}
		}),
	})

const componentsBody = (h: H, model: Model): Html => {
	const data = model.monitors.data
	if (AsyncData.isFailure(data))
		return h.div(
			[h.Class("p-4")],
			[
				errorState(h, {
					failure: data.error,
					title: "Couldn't load your monitors",
					onRetry: Message.ClickedRetry(),
					className: "rounded-md border py-8",
				}),
			],
		)
	if (!model.isSeeded)
		return vstack(h, { gap: "2", className: "p-4", attributes: [h.AriaBusy(true)] }, [
			skeleton(h, "h-12 w-full"),
			skeleton(h, "h-12 w-full"),
			skeleton(h, "h-12 w-full"),
		])
	if (model.rows.length === 0)
		return typography(h, { size: "sm", tone: "muted", as: "p", className: "p-4" }, [
			monitorsOf(model).length === 0
				? "Nothing yet. Add a URL for Maple to check, or a component you update yourself."
				: "Nothing yet. Add your monitors, a URL for Maple to check, or a component you update yourself.",
		])
	return componentRows(h, model)
}

const componentsSection = (h: H, model: Model): Html =>
	settingsSection(
		h,
		{
			id: "status-page-builder-components",
			title: "Components",
			description: [
				"Each component is a row on the page with its status. One driven by a monitor follows its checks and shows its uptime; one without a monitor shows the status you set.",
			],
			padded: false,
			actions: button(
				h,
				{
					size: "sm",
					isDisabled: !model.isSeeded || model.submitting !== null,
					attributes: [h.OnClick(Message.ClickedAddComponents())],
				},
				[icon(h, "PlusIcon"), "Add components"],
			),
		},
		[componentsBody(h, model)],
	)

const addSheet = (h: H, model: Model): Html => {
	const count = checkedRows(model.addPicker).length
	return sidePanelSheet(h, {
		sheet: model.addSheet,
		title: "Add components",
		body: [
			pickerView(h, {
				picker: model.addPicker,
				monitors: monitorsOf(model),
				toMessage: (message) => Message.GotAddPickerMessage({ message }),
				idPrefix: ADD_PICKER_ID,
				// Locked while a URL is being monitored: its completion adds what is ticked.
				isDisabled: model.addPicker.isCreatingMonitor,
				focusOnMount: h.OnMount(FocusNewRow()),
				isOrderable: false,
			}),
		],
		footer: (close) => [
			button(h, { variant: "outline", attributes: close }, ["Cancel"]),
			button(
				h,
				{
					isDisabled:
						count === 0 || hasRowIssues(model.addPicker) || model.addPicker.isCreatingMonitor,
					attributes: [h.OnClick(Message.ClickedSubmitAdd())],
				},
				[count <= 1 ? "Add component" : `Add ${count} components`],
			),
		],
		toParentMessage: (message) => Message.GotAddSheetMessage({ message }),
	})
}

const lookSection = (h: H, model: Model): Html =>
	settingsSection(
		h,
		{
			id: "status-page-builder-look",
			title: "Look",
			description: [
				"Pick a theme to start from. Its colors, corners and font can all be changed later on the Appearance tab, along with your logo.",
			],
		},
		[
			vstack(h, { gap: "4" }, [
				presetCards(h, {
					selected: model.preset,
					isDisabled: model.submitting !== null,
					onPick: (preset) => Message.PickedPreset({ preset }),
				}),
				hstack(h, { gap: "3", wrap: true }, [
					typography(h, { size: "xs", tone: "muted" }, ["Mode"]),
					segmentedSelect(h, {
						size: "sm",
						ariaLabel: "Mode",
						value: model.appearance,
						onChange: (appearance) => Message.PickedAppearance({ appearance }),
						options: APPEARANCES,
					}),
					typography(h, { size: "xs", tone: "muted" }, [
						model.appearance === "auto"
							? "Follows each visitor's setting."
							: `Every visitor sees it ${model.appearance}.`,
					]),
				]),
			]),
		],
	)

/** The draft as the public renderer draws it, with the monitors' history from the last preview. */
const draftDocument = (model: Model): string => {
	const nowMs = model.nowMs ?? 0
	const monitors = monitorsOf(model)
	const snapshot = previewSnapshot({
		pageId: DRAFT_PAGE_ID,
		page: {
			name: Str.trim(model.name) === "" ? "Status page" : Str.trim(model.name),
			slug: isSlug(model.slug) ? model.slug : "preview",
			orgKey: Option.getOrElse(model.orgKey, () => ""),
			description: null,
			websiteUrl: null,
			logoUrl: null,
			logoDarkUrl: null,
			faviconUrl: null,
			supportUrl: null,
			privacyUrl: null,
			termsUrl: null,
			customDomain: null,
			visibility: "public",
			showPoweredBy: true,
			theme: previewTheme(
				{
					...DEFAULT_STATUS_PAGE_THEME,
					...STATUS_PAGE_PRESET_DEFAULTS[model.preset],
					preset: model.preset,
					appearance: model.appearance,
				},
				model.previewScheme,
			),
		},
		components: Arr.map(orderedRows(model), (row, index) => {
			const monitorId = Option.getOrNull(decodeMonitorId(row.form.monitorId))
			return {
				id: draftComponentId(index),
				name: Str.trim(row.form.name) === "" ? "Untitled component" : Str.trim(row.form.name),
				description: orNull(row.form.description),
				group: orNull(row.form.group),
				monitorStatus: monitorStatusOf(monitors, monitorId),
				manualStatus: Option.getOrNull(decodeStatus(row.form.manualStatus)),
				showUptime: row.form.showUptime,
				monitored: monitorId !== null,
				days: daysOf(model.previewHistory, monitorId),
			}
		}),
		incidents: [],
		nowMs,
	})
	return previewDocument({
		snapshot,
		nowMs,
		isSelectable: false,
		publicUrl: isSlug(model.slug)
			? Option.getOrNull(publicUrlOf(STATUS_PAGE_BASE_URL, model.orgKey, model.slug))
			: null,
	})
}

const previewPanel = (h: H, model: Model): Html =>
	vstack(
		h,
		{
			gap: "3",
			shrink: true,
			as: "section",
			className: "pb-16 min-[1000px]:sticky min-[1000px]:top-0",
			attributes: [h.AriaLabelledBy("status-page-builder-preview")],
		},
		[
			hstack(h, { gap: "3", justify: "between", className: "min-h-7" }, [
				hstack(h, { gap: "2" }, [
					heading(h, { level: 2, variant: "subsection", id: "status-page-builder-preview" }, [
						"Preview",
					]),
					typography(
						h,
						{ size: "xs", tone: "muted", mono: true, attributes: [h.AriaLive("polite")] },
						[model.isPreviewLoading ? "Updating" : ""],
					),
				]),
				...(model.appearance === "auto"
					? [
							segmentedSelect(h, {
								size: "xs",
								ariaLabel: "Preview mode",
								value: model.previewScheme,
								onChange: (scheme) => Message.PickedPreviewScheme({ scheme }),
								options: [
									{ value: "light", label: "Light" },
									{ value: "dark", label: "Dark" },
								],
							}),
						]
					: []),
			]),
			previewFrame(h, {
				title: "Status page preview",
				document: draftDocument(model),
				className: "h-[560px] min-[1000px]:h-[calc(100vh-20rem)] min-[1000px]:min-h-[520px]",
			}),
			model.previewFailure === null
				? typography(h, { size: "xs", tone: "muted", as: "p" }, [
						"Exactly what visitors get, with your monitors' real uptime.",
					])
				: typography(h, { size: "xs", tone: "muted", as: "p" }, [
						`Uptime history unavailable: ${failureMessage(model.previewFailure)}`,
					]),
		],
	)

const footerBar = (h: H, model: Model): Html => {
	const isReady = canSubmit(model)
	return actionBar(h, {
		label: "Publish",
		leading: [
			typography(h, { size: "xs", tone: "muted", as: "p" }, ["Nothing is public until you publish."]),
		],
		actions: [
			linkButton(h, { size: "sm", variant: "ghost", href: statusPagesHref() }, ["Cancel"]),
			button(
				h,
				{
					size: "sm",
					variant: "outline",
					isLoading: model.submitting === "draft",
					isDisabled: !isReady,
					attributes: [h.OnClick(Message.ClickedSubmit({ mode: "draft" }))],
				},
				["Save as draft"],
			),
			button(
				h,
				{
					size: "sm",
					isLoading: model.submitting === "publish",
					isDisabled: !isReady,
					attributes: [h.OnClick(Message.ClickedSubmit({ mode: "publish" }))],
				},
				["Publish page"],
			),
		],
	})
}

const builder = (h: H, model: Model): Html =>
	vstack(h, { gap: "6" }, [
		h.div(
			[h.Class("grid items-start gap-8 min-[1000px]:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]")],
			[
				vstack(h, { gap: "8", shrink: true, className: "pb-16" }, [
					pageSection(h, model),
					domainSection(h, model),
					componentsSection(h, model),
					lookSection(h, model),
					...(model.createFailure === null
						? []
						: [
								alert(h, { variant: "crit", size: "sm" }, [
									icon(h, "CircleXmarkIcon"),
									alertTitle(h, ["Couldn't create the page"]),
									alertDescription(h, [failureMessage(model.createFailure)]),
								]),
							]),
				]),
				previewPanel(h, model),
			],
		),
		footerBar(h, model),
		addSheet(h, model),
	])

const MCP_ENDPOINT = `${mcpUrl}/mcp`
const AGENT_PROMPT = statusPageAgentPrompt(MCP_ENDPOINT)

const AGENT_STEPS: ReadonlyArray<string> = [
	"Connects the Maple MCP if your agent does not have it yet.",
	"Asks whether to manage the page as code (Terraform or Alchemy, when your repo uses them) or directly through the MCP.",
	"Finds the endpoints your customers depend on and proposes an uptime monitor for each, and the components the page lists.",
	"Sets up the page, private until you approve it, and matches its colors, font and logo to your product.",
	"For a page your customers read, sets up your domain and gives you the DNS records to add.",
	"Publishes only after you approve.",
]

const agentStep = (
	h: H,
	options: Readonly<{ id: string; title: string; description: string }>,
	children: ReadonlyArray<Html>,
): Html =>
	settingsSection(h, { id: options.id, title: options.title, description: [options.description] }, [
		vstack(h, { gap: "3" }, children),
	])

const agentSetup = (h: H, model: Model): Html =>
	vstack(h, { gap: "8", className: "max-w-3xl pb-16" }, [
		agentStep(
			h,
			{
				id: "status-page-agent-mcp",
				title: "1. Connect the Maple MCP",
				description:
					"Your agent works on the page through the Maple MCP. Skip this if it is connected already; the prompt checks first.",
			},
			[
				codeBlock(h, {
					code: claudeCodeCommand(MCP_ENDPOINT),
					language: "Claude Code",
					lang: "bash",
					copy: model.mcpCommandCopy,
					toCopyMessage: (message) => Message.GotMcpCommandCopyMessage({ message }),
				}),
				hstack(h, { gap: "2", wrap: true }, [
					linkButton(h, { size: "sm", variant: "outline", href: cursorInstallUrl(MCP_ENDPOINT) }, [
						icon(h, "CursorIcon"),
						"Add to Cursor",
					]),
					linkButton(h, { size: "sm", variant: "outline", href: vscodeInstallUrl(MCP_ENDPOINT) }, [
						icon(h, "VsCodeIcon"),
						"Add to VS Code",
					]),
					typography(h, { size: "xs" }, [
						textLink(
							h,
							{ href: hrefOf(AppRoute.Settings({ search: { tab: "mcp" } })), tone: "muted" },
							["Other clients"],
						),
					]),
				]),
			],
		),
		agentStep(
			h,
			{
				id: "status-page-agent-prompt",
				title: "2. Give your agent this prompt",
				description:
					"Run it in the repository of the product the page is for, so the agent can read its endpoints and brand.",
			},
			[
				agentPromptButton(h, {
					prompt: AGENT_PROMPT,
					copy: model.promptCopy,
					toCopyMessage: (message) => Message.GotPromptCopyMessage({ message }),
				}),
				codeBlock(h, {
					code: AGENT_PROMPT,
					language: "Prompt",
					isPlain: true,
					bodyClassName: "max-h-72",
					copy: model.promptCopy,
					toCopyMessage: (message) => Message.GotPromptCopyMessage({ message }),
				}),
			],
		),
		agentStep(
			h,
			{
				id: "status-page-agent-steps",
				title: "What your agent does",
				description:
					"It asks before each choice. The page shows up under Status pages as soon as the agent creates it.",
			},
			[
				numberedSteps(h, AGENT_STEPS),
				typography(h, { size: "xs", as: "div" }, [
					hstack(h, { gap: "4", wrap: true }, [
						textLink(h, { href: docsUrl("statusPages"), tone: "muted" }, ["Status pages docs"]),
						textLink(h, { href: newStatusPageHref("manual"), tone: "muted" }, [
							"Set it up in the dashboard instead",
						]),
					]),
				]),
			],
		),
	])

const membersOnly = (h: H): Html =>
	resourceNotFound(h, {
		title: "Only org admins and engineers can create status pages",
		description: "Ask an admin to create one. You can read the existing pages.",
		back: { href: statusPagesHref(), label: "Back to status pages" },
	})

/** Back to the choice of method, once one is picked. */
const changeMethod = (h: H): Html =>
	linkButton(h, { size: "sm", variant: "ghost", href: newStatusPageHref() }, [
		icon(h, "ArrowLeftIcon"),
		"Change method",
	])

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, _inputs, h) =>
	dashboardPage(
		h,
		{
			title: model.setup === "agent" ? "Set up a status page with your agent" : "New status page",
			actions: model.setup === null || !canManage(model) ? undefined : changeMethod(h),
		},
		[
			!model.isSessionLoaded
				? vstack(h, { gap: "4", attributes: [h.AriaBusy(true)] }, [
						skeleton(h, "h-9 w-1/3"),
						skeleton(h, "h-64 w-full"),
					])
				: !canManage(model)
					? membersOnly(h)
					: model.setup === null
						? methodChoice(h)
						: model.setup === "agent"
							? agentSetup(h, model)
							: builder(h, model),
		],
	),
)
