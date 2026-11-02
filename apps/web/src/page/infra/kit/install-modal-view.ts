import { docsUrl } from "../../../lib/docs"
import { AsyncData, Submodel } from "foldkit"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { button, linkButton } from "../../../ui/button"
import * as CopyButton from "../../../ui/copy-button"
import * as DialogView from "../../../ui/dialog-view"
import { icon } from "../../../ui/icon"
import { inputGroup, inputGroupAddon, inputGroupButton } from "../../../ui/input-group"
import { skeleton } from "../../../ui/skeleton"
import * as TabsView from "../../../ui/tabs-view"
import { textarea } from "../../../ui/textarea"
import { Message, type Model, MountInstallModal, type Snippet } from "./install-modal"
import {
	dockerCommand,
	helmCommand,
	HOST_CONFIG,
	hostCommand,
	isCustomEndpoint,
	maskToken,
} from "./install-snippets"

// `InstallHostModal`'s dialog. Rendered only while open or closing.

type H = HtmlBuilder<Message>

type SnippetPanel = Readonly<{
	snippet: Snippet
	isLoading: boolean
	value: string
	display: string
	rows: number
	hasReveal: boolean
	copyLabel?: string
}>

const snippetPanel = (h: H, model: Model, panel: SnippetPanel): Html =>
	panel.isLoading
		? skeleton(h, "h-36 w-full")
		: inputGroup(h, {}, [
				textarea(h, {
					id: `${model.id}-${panel.snippet}`,
					isUnstyled: true,
					controlClassName: "font-mono text-xs tracking-wide select-all leading-relaxed",
					defaultValue: panel.display,
					attributes: [h.Readonly(true), h.Attribute("wrap", "off"), h.Rows(panel.rows)],
				}),
				inputGroupAddon(h, { align: "block-end" }, [
					...(panel.hasReveal
						? [
								inputGroupButton(
									h,
									{
										attributes: [
											h.AriaLabel(model.isRevealed ? "Hide key" : "Reveal key"),
											h.Title(model.isRevealed ? "Hide key" : "Reveal key"),
											h.OnClick(Message.ClickedToggleReveal()),
										],
									},
									[
										icon(h, "EyeIcon", { size: 14 }),
										model.isRevealed ? "Hide key" : "Reveal key",
									],
								),
							]
						: []),
					CopyButton.view(h, {
						model: model.copies[panel.snippet],
						toParentMessage: (message) =>
							Message.GotCopyMessage({ snippet: panel.snippet, message }),
						value: panel.value,
						label: panel.copyLabel ?? "Install command",
						// `render={<InputGroupButton />}`: CopyButton's own size and slot win the merge.
						idleLabel: "Copy",
						className: "ml-auto",
					}),
				]),
			])

const note = (h: H, children: ReadonlyArray<Html | string>): Html =>
	h.p([h.Class("text-muted-foreground text-xs")], children)

const code = (h: H, text: string): Html => h.code([h.Class("font-mono")], [text])

/** `snippet` is what Copy writes; `display` masks the key unless revealed. */
const keyed = (model: Model, build: (token: string) => string) => {
	const token = AsyncData.getOrElse(model.ingestKey, () => "")
	const value = token === "" ? "" : build(token)
	return {
		isLoading: AsyncData.isLoading(model.ingestKey) || AsyncData.isIdle(model.ingestKey),
		value,
		display: model.isRevealed || token === "" ? value : build(maskToken(token)),
	}
}

const panelFor = (h: H, model: Model, value: string): ReadonlyArray<Html> => {
	if (value === "kubernetes")
		return [
			note(h, [
				"The Maple Helm chart deploys a DaemonSet for per-node host + kubelet metrics and a single-replica deployment for cluster-wide signals. Run the command against your cluster. For production, prefer an existing Secret over an inline value. See the docs.",
			]),
			snippetPanel(h, model, {
				snippet: "helm",
				...keyed(model, helmCommand),
				rows: isCustomEndpoint ? 6 : 5,
				hasReveal: true,
			}),
		]
	if (value === "docker")
		return [
			note(h, [
				"The Maple Docker agent runs as a single container with read-only access to the Docker socket and streams per-container CPU, memory, network, and block I/O, plus container logs via the mounted log directory (drop that mount to skip logs). It also accepts app OTLP on 4317/4318.",
			]),
			snippetPanel(h, model, {
				snippet: "docker",
				...keyed(model, dockerCommand),
				rows: isCustomEndpoint ? 10 : 9,
				hasReveal: true,
			}),
		]
	return [
		note(h, [
			"For any Linux, macOS or Windows machine outside Kubernetes. Install the OpenTelemetry Collector Contrib distribution (",
			code(h, "otelcol-contrib"),
			"), save this as",
			" ",
			code(h, "config.yaml"),
			", then start it with the command below. On Kubernetes, the Helm chart already reports every node.",
		]),
		snippetPanel(h, model, {
			snippet: "hostConfig",
			isLoading: false,
			value: HOST_CONFIG,
			display: HOST_CONFIG,
			rows: 12,
			hasReveal: false,
			copyLabel: "Collector config",
		}),
		snippetPanel(h, model, { snippet: "host", ...keyed(model, hostCommand), rows: 1, hasReveal: true }),
	]
}

const content = (h: H, model: Model, close: ReadonlyArray<ChildAttribute>): ReadonlyArray<Html> => [
	DialogView.dialogHeader(h, "dialog", [
		DialogView.dialogTitle(h, "dialog", model.dialog.id, "Install a collector"),
		DialogView.dialogDescription(
			h,
			"dialog",
			model.dialog.id,
			"Pick where your workloads run. Each path uses your org's ingest key and starts reporting within about a minute.",
		),
	]),
	DialogView.dialogPanel(h, "dialog", model.dialog.id, [
		h.div(
			[h.Class("space-y-4 min-w-0")],
			[
				h.submodel({
					slotId: "install-tabs",
					model: model.tabs,
					view: TabsView.view,
					toParentMessage: (message) => Message.GotTabsMessage({ message }),
					viewInputs: {
						labels: ["Kubernetes", "Docker", "Host"],
						panelClassName: "space-y-4 pt-3",
						panel: (value) => panelFor(h, model, value),
					},
				}),
				note(h, [
					"The command embeds your org's",
					" ",
					h.strong([h.Class("text-foreground")], ["private ingest key"]),
					". Rotate it from Settings → Ingestion if it leaks.",
				]),
			],
		),
	]),
	DialogView.dialogFooter(h, "dialog", [
		button(h, { variant: "outline", attributes: [...close] }, ["Close"]),
		linkButton(
			h,
			{
				variant: "outline",
				href: docsUrl(
					model.tabs.selected === "docker"
						? "docker"
						: model.tabs.selected === "hosts"
							? "hosts"
							: "kubernetes",
				),
				attributes: [h.Target("_blank"), h.Rel("noopener noreferrer"), h.AriaLabel("View docs")],
			},
			["View docs"],
		),
	]),
]

/** The modal's portal while open or closing. */
export const view = Submodel.defineView<Model, Message>((model, h) =>
	h.submodel({
		slotId: `${model.id}-dialog`,
		model: model.dialog,
		view: DialogView.view,
		viewInputs: {
			className: "max-w-2xl overflow-hidden",
			hasTrigger: false,
			toView: ({ portal }) => portal,
			toContent: (close) => content(h, model, close),
		},
		toParentMessage: (message) => Message.GotDialogMessage({ message }),
	}),
)

/**
 * The modal as `InfraSetupEmpty` mounts it: a hidden holder whose Mount fetches the key when the
 * empty state appears (the portal moves itself to `<body>`, so the holder adds no layout).
 */
export const mountedView = Submodel.defineView<Model, Message>((model, h) =>
	h.span(
		[h.Hidden(true), h.OnMount(MountInstallModal())],
		[
			h.submodel({
				slotId: `${model.id}-dialog`,
				model: model.dialog,
				view: DialogView.view,
				viewInputs: {
					className: "max-w-2xl overflow-hidden",
					hasTrigger: false,
					toView: ({ portal }) => portal,
					toContent: (close) => content(h, model, close),
				},
				toParentMessage: (message) => Message.GotDialogMessage({ message }),
			}),
		],
	),
)
