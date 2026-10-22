import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { Command, expect as expectView, given, Mount, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { PageOutMessage, type PageContext } from "../../../contract"
import * as Frame from "../../kit/frame"
import * as InstallModal from "../../kit/install-modal"
import { Message } from "./message"
import type { ContainerRow, Model } from "./model"
import { containersInput, init, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-01 00:00:00", endTime: "2026-10-01 12:00:00" }
const NOW = Date.parse("2026-10-01T12:00:00Z")

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()

const row = (containerName: string): ContainerRow => ({
	containerName,
	hostName: "build-runner-01",
	containerId: "abc",
	imageName: "redis:7",
	composeProject: "ci-stack",
	composeService: "redis",
	runtime: "docker",
	environment: "ci",
	lastSeen: "2026-10-01 12:00:00",
	cpuPct: 0.1,
	memoryPct: 0.2,
	cpuPctPeak: 0.2,
	memoryPctPeak: 0.3,
	cpuLimitCores: 1,
	uptimeSeconds: 600,
	saturation: 0.3,
})

const windowed = (search: Model["search"] = {}) =>
	pageUpdate(
		init({ search }, context).model,
		Message.GotFrameMessage({
			message: Frame.Message.CompletedResolveWindow({
				window,
				nowMs: NOW,
				locale: "en-US",
				mode: "Load",
			}),
		}),
	)

const loaded = (rows: ReadonlyArray<ContainerRow>, search: Model["search"] = {}) => {
	const model = windowed(search).model
	return pageUpdate(
		model,
		Message.CompletedFetchContainers({
			key: model.containers.key ?? "",
			result: Result.succeed({ data: rows, totalCount: rows.length }),
		}),
	).model
}

describe("containers list", () => {
	test("the window requests the page, the scope-only summary and the facets", () => {
		const names = (windowed().commands ?? []).map(({ name }) => name)
		expect(names).toEqual(
			expect.arrayContaining([
				"FetchInfraContainers",
				"FetchInfraContainersSummary",
				"FetchInfraContainerFacets",
			]),
		)
	})

	test("the server sees the debounced search, not each keystroke", () => {
		const typed = pageUpdate(windowed().model, Message.ElapsedSearchDebounce({ query: "red" }))
		expect(typed.commands ?? []).toHaveLength(0)
		const settled = pageUpdate(
			{ ...windowed({ q: "redis" }).model },
			Message.ElapsedSearchDebounce({ query: "redis" }),
		)
		expect(containersInput(settled.model, window).search).toBe("redis")
	})

	test("a sort header cycles the direction on its key", () => {
		const sorted = pageUpdate(
			loaded([row("a")], { sortBy: "cpuPct" }),
			Message.ClickedSort({ key: "cpuPct" }),
		)
		expect(sorted.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/infra/containers?sortBy=cpuPct&sortDir=asc",
				isReplace: false,
			}),
		)
	})

	test("an org with no containers shows the Docker setup and fetches the ingest key once it mounts", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded([])),
			Mount.resolve(InstallModal.MountInstallModal, InstallModal.Message.MountedInstallModal()),
			Command.resolve(
				InstallModal.FetchIngestKey,
				InstallModal.Message.CompletedFetchIngestKey({ result: Result.succeed("maple_sk_test") }),
			),
			expectView(text("No containers reporting yet")).toExist(),
		)
		const mounted = pageUpdate(
			loaded([]),
			Message.GotInstallMessage({ message: InstallModal.Message.MountedInstallModal() }),
		)
		expect((mounted.commands ?? []).map(({ name }) => name)).toEqual(["FetchInstallIngestKey"])
	})
})
