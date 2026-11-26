import { docsUrl } from "../../kit/docs"
import * as Recipe from "../../kit/install-recipe"
import { TOOL_MARKS } from "../../kit/tool-marks"
import { Schema } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { button, linkButton } from "@maple/views/ui/button"
import * as DialogView from "@maple/views/ui/dialog-view"
import { icon } from "@maple/views/ui/icon"
import * as TabsView from "@maple/views/ui/tabs-view"
import { typography } from "@maple/views/ui/typography"
import { InstallTab, Message, type Model, MountInstallModal } from "./install-modal"
import { DOCKER_RECIPES, HOST_RECIPES, KUBERNETES_RECIPES } from "./install-snippets"

// The install modal's dialog, rendered only while open or closing.

type H = HtmlBuilder<Message>

const keyNote = (h: H): ReadonlyArray<Html | string> => [
	"This command carries your org's ",
	typography(h, { weight: "medium", tone: "foreground" }, ["private ingest key"]),
	". Rotate it in Settings → Ingestion if it leaks.",
]

const TABS = {
	kubernetes: {
		tool: "kubernetes",
		recipes: KUBERNETES_RECIPES,
		intro: "Maple's Helm chart runs a DaemonSet for node and kubelet metrics, and one deployment for cluster-wide signals.",
	},
	docker: {
		tool: "docker",
		recipes: DOCKER_RECIPES,
		intro: "One container with read-only access to the Docker socket. It reports CPU, memory, network and block I/O for every container, and accepts app OTLP on 4317 and 4318.",
	},
	hosts: {
		tool: "host",
		recipes: HOST_RECIPES,
		intro: "For any Linux, macOS or Windows machine outside Kubernetes. On Kubernetes, the Helm chart already reports every node.",
	},
} as const

const keyOf = (model: Model): Recipe.RecipeKey => {
	const key = AsyncData.getOrElse(model.ingestKey, () => "")
	return {
		isLoading: AsyncData.isLoading(model.ingestKey) || AsyncData.isIdle(model.ingestKey),
		value: key,
		masked: key === "" ? undefined : Recipe.maskSecret(key),
	}
}

const panelFor = (h: H, model: Model, tab: InstallTab): ReadonlyArray<Html> => [
	typography(h, { size: "sm", tone: "muted", as: "p" }, [TABS[tab].intro]),
	...Recipe.view(h, {
		model: model.recipe,
		toParentMessage: (message) => Message.GotRecipeMessage({ message }),
		recipes: TABS[tab].recipes,
		key: keyOf(model),
		keyNote: keyNote(h),
	}),
]

const isInstallTab = Schema.is(InstallTab)

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
			[h.Class("min-w-0")],
			[
				h.submodel({
					slotId: "install-tabs",
					model: model.tabs,
					view: TabsView.view,
					toParentMessage: (message) => Message.GotTabsMessage({ message }),
					viewInputs: {
						labels: ["Kubernetes", "Docker", "Host"],
						tabContent: (value: string, label: string) =>
							isInstallTab(value)
								? [icon(h, TOOL_MARKS[TABS[value].tool].icon, { size: 14 }), label]
								: [label],
						variant: "underline",
						ariaLabel: "Where the collector runs",
						wrapList: (list: Html) => h.div([h.Class("border-b border-border")], [list]),
						panelClassName: "space-y-5 pt-3",
						panel: (value) => (isInstallTab(value) ? panelFor(h, model, value) : []),
					},
				}),
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
			className: "max-w-3xl overflow-hidden",
			hasTrigger: false,
			toView: ({ portal }) => portal,
			toContent: (close) => content(h, model, close),
		},
		toParentMessage: (message) => Message.GotDialogMessage({ message }),
	}),
)

/**
 * The modal as the setup empty state mounts it: a hidden holder whose Mount fetches the key when the
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
					className: "max-w-3xl overflow-hidden",
					hasTrigger: false,
					toView: ({ portal }) => portal,
					toContent: (close) => content(h, model, close),
				},
				toParentMessage: (message) => Message.GotDialogMessage({ message }),
			}),
		],
	),
)
