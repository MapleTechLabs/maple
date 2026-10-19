import type { Page } from "playwright"
import { act, clickButton, opsScenarios } from "./ops-kit.ts"
import type { AreaModule } from "./types.ts"

/** `/sources/$sourceId` on Acme's sources (fixtures/areas/sources.ts), ids restated in public form. */
const detail = opsScenarios("sources-detail", "Source")
const DEFAULT = "default"

export const SOURCE_IDS = {
	default: "src_YoxMrdSXAG1kzRUaCbDaD6",
	checkout: "src_YoxMrdSXAG1kzRUaCbDaD7",
	cluster: "src_YoxMrdSXAG1kzRUaCbDaD8",
	browser: "src_YoxMrdSXAG1kzRUaCbDaD9",
	prometheus: "src_YoxMrdSXAG1kzRUaCbDaDA",
	/** Decodes, but no source has it. */
	missing: "src_YoxMrdSXAG1kzRUaCbDaFi",
} as const

const at = (id: string, tab?: "setup" | "settings") =>
	`/sources/${id}${tab === undefined ? "" : `?tab=%22${tab}%22`}`

const failing = (tag: string) => ({
	faults: {
		failures: {
			[tag]: {
				status: 500,
				body: {
					_tag: "@maple/http/errors/SourcePersistenceError",
					message: "ui-parity: injected sources failure",
				},
			},
		},
	},
})

const waitForText = (value: string | RegExp) => (page: Page) =>
	page.getByText(value).first().waitFor({ state: "visible" })
const confirmIn = (dialog: string, name: string) => (page: Page) =>
	page.getByRole("alertdialog", { name: dialog }).getByRole("button", { name }).click()

const on = (id: string, title: string, path: string, options: Parameters<typeof detail>[3] = {}) =>
	detail(id, title, path, { dataset: DEFAULT, ...options })

export const sourcesDetailArea: AreaModule = {
	area: "sources-detail",
	scenarios: [
		on("checkout", "Token source overview", at(SOURCE_IDS.checkout)),
		on("paused", "Paused cluster", at(SOURCE_IDS.cluster)),
		on("pending", "Browser source with no data", at(SOURCE_IDS.browser)),
		on("integration", "Stale Prometheus integration", at(SOURCE_IDS.prometheus)),
		on("default", "The default source", at(SOURCE_IDS.default)),
		on("invalid-id", "An id that does not decode", "/sources/nope"),
		on("missing", "A source that is not in the list", at(SOURCE_IDS.missing)),
		on("loading", "List held", at(SOURCE_IDS.checkout), {
			faults: { delays: { "sources.list": 60_000 } },
			settle: "held",
		}),
		on("error", "List failing", at(SOURCE_IDS.checkout), failing("sources.list")),
		on("usage-error", "Usage failing", at(SOURCE_IDS.checkout), failing("sources.usage")),
		on("pause-menu", "Pause menu open", at(SOURCE_IDS.checkout), { steps: act(clickButton("Pause")) }),
		on("pause", "Pause for an hour", at(SOURCE_IDS.checkout), {
			steps: act(clickButton("Pause"), (page) => page.getByRole("menuitem", { name: "For 1 hour" }).click(), waitForText(/^Source paused/)),
		}),
		on("resume", "Resume the cluster", at(SOURCE_IDS.cluster), {
			steps: act(clickButton("Resume"), waitForText(/^Source resumed/)),
		}),
		on("roll-dialog", "Roll dialog open", at(SOURCE_IDS.checkout), { steps: act(clickButton("Roll token")) }),
		on("rolled", "Token rolled", at(SOURCE_IDS.checkout), {
			steps: act(clickButton("Roll token"), confirmIn("Roll this source's token?", "Roll token"), waitForText(/^Token rolled/)),
		}),
		on("delete-dialog", "Delete dialog open", at(SOURCE_IDS.checkout), { steps: act(clickButton("Delete")) }),
		on("setup", "Setup tab, masked token", at(SOURCE_IDS.checkout, "setup")),
		on("setup-cluster", "Setup tab, Helm snippet", at(SOURCE_IDS.cluster, "setup")),
		on("setup-default", "Setup tab, default source", at(SOURCE_IDS.default, "setup")),
		on("setup-integration", "Setup tab, integration", at(SOURCE_IDS.prometheus, "setup")),
		on("settings", "Settings tab", at(SOURCE_IDS.checkout, "settings")),
		on("settings-default", "Settings tab, default source", at(SOURCE_IDS.default, "settings")),
		on("settings-save", "Save the settings", at(SOURCE_IDS.checkout, "settings"), {
			steps: act(clickButton("Save changes"), waitForText(/^Source saved/)),
		}),
		on("open-setup", "Overview, then the Setup tab", at(SOURCE_IDS.checkout), {
			steps: act((page) => page.getByRole("tab", { name: "Setup" }).click(), waitForText("OTLP endpoint")),
		}),
		on("rolled-setup", "Roll, then the Setup tab shows the token", at(SOURCE_IDS.checkout, "setup"), {
			steps: act(clickButton("Roll token"), confirmIn("Roll this source's token?", "Roll token"), waitForText(/^Token rolled/)),
		}),
		on("deleted", "Delete and land on the list", at(SOURCE_IDS.checkout), {
			steps: act(clickButton("Delete"), confirmIn("Delete source?", "Delete"), waitForText("Source deleted")),
		}),
	],
}
