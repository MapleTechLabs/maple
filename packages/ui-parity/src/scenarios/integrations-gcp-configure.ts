import type { Page } from "playwright"
import type { Scenario } from "./types.ts"

/** `GcpConfigure`: the Google Cloud wizard, a new connection's four steps and a connection's three. */

const PATH = "/integrations?integration=gcp"
const CONNECTED = "infra-integrations"
const HELD_MS = 60_000

const v2Failure = {
	status: 503,
	body: {
		error: {
			_tag: "@maple/http/errors/IntegrationsPersistenceError",
			type: "api_error",
			code: "integration_persistence_unavailable",
			title: "Integrations are temporarily unavailable",
			message: "Integrations are temporarily unavailable. Retry in a few seconds.",
			retryable: true,
			recovery: "retry",
		},
	},
}

const wizard = (
	id: string,
	title: string,
	steps: (page: Page) => Promise<void>,
	options: Pick<Scenario, "dataset" | "faults" | "settle"> = {},
): Scenario => ({
	id: `integrations-gcp-configure-${id}`,
	title: `Google Cloud wizard: ${title}`,
	path: PATH,
	dataset: options.dataset ?? "default",
	viewports: ["desktop"],
	themes: ["light", "dark"],
	steps,
	faults: options.faults,
	settle: options.settle,
	area: "integrations",
})

const dialog = (page: Page) => page.getByRole("dialog")

/** The empty card's button, or the connected card's "Add connection". */
const openNew = (page: Page) => page.getByRole("button", { name: "Connect Google Cloud" }).click()
const openAdd = (page: Page) => page.getByRole("button", { name: "Add connection" }).click()

const fillProject = async (page: Page, id = "acme-prod") => {
	await dialog(page).getByRole("textbox", { name: "Project ID" }).fill(id)
	await dialog(page).getByRole("textbox", { name: "Project ID" }).blur()
}

const toData = async (page: Page) => {
	await openNew(page)
	await fillProject(page)
	await dialog(page).getByRole("button", { name: "Continue" }).click()
	await dialog(page).getByText("What should Maple collect?").waitFor()
}

const openFilter = (page: Page) =>
	dialog(page)
		.getByRole("button", { name: /^Log filter/ })
		.click()

const tickCloudRun = async (page: Page) => {
	await openFilter(page)
	await dialog(page).getByRole("button", { name: "Can't forward via OpenTelemetry" }).click()
	await dialog(page).getByRole("checkbox", { name: "Cloud Run" }).click()
}

/** The create, onto the Method step. */
const toMethod = async (page: Page) => {
	await dialog(page).getByRole("button", { name: "Continue" }).click()
	await dialog(page).getByText("How do you want to connect?").waitFor()
}

/** Continue on the Method step, with `method` picked first. */
const setUp = async (page: Page, method?: string) => {
	if (method !== undefined) await dialog(page).getByText(method, { exact: true }).click()
	await dialog(page).getByRole("button", { name: "Continue" }).click()
}

/** The create and the Method step, onto the script. */
const create = async (page: Page) => {
	await toMethod(page)
	await setUp(page)
	await dialog(page).getByText("Run this script in Cloud Shell").waitFor()
}

const openConfigure = async (page: Page) => {
	await page.getByRole("button", { name: /^Actions for / }).click()
	await page.getByRole("menuitem", { name: "Configure" }).click()
	await dialog(page).getByText("What should Maple collect?").waitFor()
}

/** The Method step's legend once something of the connection is set up. */
const CHANGE = "How do you want to apply the change?"

const metricsOff = (page: Page) => dialog(page).getByRole("switch", { name: "Metrics and resources" }).click()

/** A new connection: the scope step, the data step, the create and the run step. */
const newConnection: ReadonlyArray<Scenario> = [
	wizard("scope", "the scope step", openNew),
	wizard("scope-invalid", "a project ID that breaks the rule", async (page) => {
		await openNew(page)
		await fillProject(page, "Acme_Prod")
	}),
	wizard(
		"scope-folder",
		"a folder beside a connected project",
		async (page) => {
			await openAdd(page)
			await dialog(page).getByRole("button", { name: "Folder" }).click()
			await dialog(page).getByRole("textbox", { name: "Folder ID" }).fill("12345a")
			await dialog(page).getByRole("textbox", { name: "Folder ID" }).blur()
			await dialog(page).getByRole("textbox", { name: "Host project ID" }).fill("1-bad")
			await dialog(page).getByRole("textbox", { name: "Host project ID" }).blur()
		},
		{ dataset: CONNECTED },
	),
	wizard("cancel", "cancel on the scope step", async (page) => {
		await openNew(page)
		await dialog(page).getByRole("button", { name: "Cancel" }).click()
		await dialog(page).waitFor({ state: "detached" })
	}),
	wizard("data", "the data step, metrics unavailable", toData),
	wizard("data-filter", "the log filter, forwarding Cloud Run", async (page) => {
		await toData(page)
		await tickCloudRun(page)
	}),
	wizard(
		"data-metrics-off",
		"the data step with metrics switched off",
		async (page) => {
			await openAdd(page)
			await fillProject(page)
			await dialog(page).getByRole("button", { name: "Continue" }).click()
			await metricsOff(page)
		},
		{ dataset: CONNECTED },
	),
	wizard("back", "back from the data step", async (page) => {
		await toData(page)
		await dialog(page).getByRole("button", { name: "Back" }).click()
	}),
	wizard("create", "create, then the Method step", async (page) => {
		await toData(page)
		await toMethod(page)
	}),
	wizard("create-script", "the script on the Set up step", async (page) => {
		await toData(page)
		await create(page)
	}),
	wizard("create-filter", "create with Cloud Run output, the script shown", async (page) => {
		await toData(page)
		await tickCloudRun(page)
		await create(page)
		await dialog(page).getByRole("button", { name: "Show all" }).click()
	}),
]

/** Faults on the create and the script read. */
const newConnectionFaults: ReadonlyArray<Scenario> = [
	wizard(
		"create-failure",
		"create fails",
		async (page) => {
			await toData(page)
			await dialog(page).getByRole("button", { name: "Continue" }).click()
			await dialog(page).getByRole("alert").waitFor()
		},
		{ faults: { failures: { "gcpIntegration.createConnector": v2Failure } } },
	),
	wizard(
		"create-script-loading",
		"the run step while the script loads",
		async (page) => {
			await toData(page)
			await create(page)
		},
		{ faults: { delays: { "gcpIntegration.setupScripts": HELD_MS } } },
	),
	wizard(
		"create-script-error",
		"the run step when the script fails to load",
		async (page) => {
			await toData(page)
			await create(page)
			await dialog(page).getByRole("button", { name: "Try again" }).waitFor()
		},
		{ faults: { failures: { "gcpIntegration.setupScripts": v2Failure } } },
	),
	wizard("create-close", "close the run step", async (page) => {
		await toData(page)
		await create(page)
		await dialog(page).getByRole("button", { name: "Close" }).first().click()
		await dialog(page).waitFor({ state: "detached" })
	}),
]

/** An existing connection: what it collects, the confirmation, the save and the run step. */
const connection: ReadonlyArray<Scenario> = [
	wizard("choose", "a connection's data step", openConfigure, { dataset: CONNECTED }),
	wizard(
		"choose-filter",
		"replace the sink's filter",
		async (page) => {
			await openConfigure(page)
			await openFilter(page)
			await dialog(page).getByRole("combobox").click()
			await page.getByRole("option", { name: /^Replace filter/ }).click()
		},
		{ dataset: CONNECTED },
	),
	wizard(
		"choose-metrics-off",
		"switch metrics off",
		async (page) => {
			await openConfigure(page)
			await metricsOff(page)
		},
		{ dataset: CONNECTED },
	),
	wizard(
		"confirm",
		"the confirmation for turning metrics off",
		async (page) => {
			await openConfigure(page)
			await metricsOff(page)
			await dialog(page).getByRole("button", { name: "Save and continue" }).click()
			await page.getByRole("alertdialog").waitFor()
		},
		{ dataset: CONNECTED },
	),
	wizard(
		"save",
		"save metrics off, then the run step",
		async (page) => {
			await openConfigure(page)
			await metricsOff(page)
			await dialog(page).getByRole("button", { name: "Save and continue" }).click()
			await page.getByRole("alertdialog").getByRole("button", { name: "Turn off and continue" }).click()
			await page.getByRole("alertdialog").waitFor({ state: "detached" })
		},
		{ dataset: CONNECTED },
	),
	wizard(
		"save-failure",
		"the save fails",
		async (page) => {
			await openConfigure(page)
			await metricsOff(page)
			await dialog(page).getByRole("button", { name: "Save and continue" }).click()
			await page.getByRole("alertdialog").getByRole("button", { name: "Turn off and continue" }).click()
			await page.getByText("Failed to save the change").waitFor()
		},
		{
			dataset: CONNECTED,
			faults: { failures: { "gcpIntegration.updateConnector": v2Failure } },
		},
	),
	wizard(
		"rerun",
		"continue unchanged through the Method step to the script",
		async (page) => {
			await openConfigure(page)
			await dialog(page).getByRole("button", { name: "Continue" }).click()
			await dialog(page).getByText(CHANGE).waitFor()
			await setUp(page)
			await dialog(page).getByText("Run this script in Cloud Shell").waitFor()
		},
		{ dataset: CONNECTED },
	),
	wizard(
		"rerun-edit",
		"edit from the Set up step, back on the Method step",
		async (page) => {
			await openConfigure(page)
			await dialog(page).getByRole("button", { name: "Continue" }).click()
			await setUp(page)
			await dialog(page).getByRole("button", { name: "Edit" }).click()
			await dialog(page).getByText(CHANGE).waitFor()
		},
		{ dataset: CONNECTED },
	),
]

/** The remaining controls: the third scope kind, undoing the runtime ticks, retry, Done, Escape. */
const controls: ReadonlyArray<Scenario> = [
	wizard("scope-organization", "an organization scope", async (page) => {
		await openNew(page)
		await dialog(page).getByRole("button", { name: "Organization" }).click()
		await dialog(page).getByRole("textbox", { name: "Organization ID" }).fill("123456789012")
		await dialog(page).getByRole("textbox", { name: "Host project ID" }).fill("acme-observability")
	}),
	wizard("escape", "Escape closes the wizard", async (page) => {
		await openNew(page)
		await dialog(page).getByRole("textbox", { name: "Project ID" }).waitFor()
		await page.keyboard.press("Escape")
		await dialog(page).waitFor({ state: "detached" })
	}),
	// Focus back on <body>, as after the focused control re-renders away: Escape still closes it.
	wizard("escape-body-focus", "Escape closes the wizard with focus outside it", async (page) => {
		await openNew(page)
		await dialog(page).getByRole("textbox", { name: "Project ID" }).waitFor()
		await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined))
		await page.keyboard.press("Escape")
		await dialog(page).waitFor({ state: "detached" })
	}),
	wizard("close-x","the dialog's close button", async (page) => {
		await openNew(page)
		await dialog(page).getByRole("button", { name: "Close", exact: true }).click()
		await dialog(page).waitFor({ state: "detached" })
	}),
	wizard("data-use-otel", "back to OpenTelemetry from the runtime ticks", async (page) => {
		await toData(page)
		await tickCloudRun(page)
		await dialog(page).getByRole("button", { name: "Use OpenTelemetry instead" }).click()
	}),
	wizard(
		"create-script-retry",
		"retry a failed script read",
		async (page) => {
			await toData(page)
			await create(page)
			await dialog(page).getByRole("button", { name: "Try again" }).click()
			await dialog(page).getByRole("button", { name: "Try again" }).waitFor()
		},
		{ faults: { failures: { "gcpIntegration.setupScripts": v2Failure } } },
	),
	wizard(
		"edit-save",
		"edit a new connection, then save without a confirmation",
		async (page) => {
			await openAdd(page)
			await fillProject(page)
			await dialog(page).getByRole("button", { name: "Continue" }).click()
			await metricsOff(page)
			await create(page)
			await dialog(page).getByRole("button", { name: "Edit" }).click()
			await dialog(page).getByRole("button", { name: "Back" }).click()
			await dialog(page).getByRole("switch", { name: "Metrics and resources" }).click()
			await dialog(page).getByRole("button", { name: "Save and continue" }).click()
			await setUp(page)
			await dialog(page).getByText("Run this script in Cloud Shell").waitFor()
		},
		{ dataset: CONNECTED },
	),
	wizard(
		"save-done",
		"Done after the confirmed run",
		async (page) => {
			await openConfigure(page)
			await metricsOff(page)
			await dialog(page).getByRole("button", { name: "Save and continue" }).click()
			await page.getByRole("alertdialog").getByRole("button", { name: "Turn off and continue" }).click()
			await dialog(page).getByText(CHANGE).waitFor()
			await setUp(page)
			await dialog(page).getByRole("button", { name: "Done" }).click()
			await dialog(page).waitFor({ state: "detached" })
		},
		{ dataset: CONNECTED },
	),
]

/** The Method step and the setups without the script: console steps, Terraform and Alchemy. */
const methods: ReadonlyArray<Scenario> = [
	wizard("method-code", "infrastructure as code picked on the Method step", async (page) => {
		await toData(page)
		await toMethod(page)
		await dialog(page).getByText("Infrastructure as code", { exact: true }).click()
	}),
	wizard("manual", "the console steps", async (page) => {
		await toData(page)
		await toMethod(page)
		await setUp(page, "Manual setup")
		await dialog(page).getByText("Create these in the Google Cloud console").waitFor()
	}),
	wizard("manual-step", "another console step opened", async (page) => {
		await toData(page)
		await toMethod(page)
		await setUp(page, "Manual setup")
		await dialog(page).getByRole("button", { expanded: false }).last().click()
	}),
	wizard("terraform", "the Terraform file", async (page) => {
		await toData(page)
		await toMethod(page)
		await setUp(page, "Infrastructure as code")
		await dialog(page).getByText("Add this to your Terraform configuration").waitFor()
	}),
	wizard("alchemy", "the Alchemy file, shown in full", async (page) => {
		await toData(page)
		await toMethod(page)
		await dialog(page).getByText("Infrastructure as code", { exact: true }).click()
		await dialog(page).getByRole("button", { name: "Alchemy" }).click()
		await setUp(page)
		await dialog(page).getByText("Add this to your Alchemy app").waitFor()
		await dialog(page).getByRole("button", { name: "Show all" }).click()
	}),
	wizard("method-back", "edit from the console steps, back on the Method step", async (page) => {
		await toData(page)
		await toMethod(page)
		await setUp(page, "Manual setup")
		await dialog(page).getByRole("button", { name: "Edit" }).click()
		await dialog(page).getByText("How do you want to connect?").waitFor()
	}),
]

export const gcpConfigureScenarios: ReadonlyArray<Scenario> = [
	...newConnection,
	...methods,
	...newConnectionFaults,
	...connection,
	...controls,
]
