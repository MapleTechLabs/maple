import { Array as Arr, Option } from "effect"
import { describe, expect, test } from "vitest"
import { vercelHealth, vercelIssues } from "../page/infra-integrations/vercel/integration/vercel-model"
import { Message as IntegrationsMessage } from "../page/integrations/message"
import { VercelMessage } from "../page/infra-integrations/vercel/integration/vercel"
import { init, Message, update } from "./vercel-lab"

const NOW = Date.UTC(2026, 9, 20, 12)
const opened = () => init({ nowMs: NOW, timeZone: "UTC" }).model
const sceneOf = (model: ReturnType<typeof opened>, id: string) => {
	const scene = Arr.findFirst(model.scenes, (candidate) => candidate.id === id)
	if (Option.isNone(scene)) throw new Error(`no scene ${id}`)
	return scene.value
}
const statusOf = (model: ReturnType<typeof opened>, id: string) => {
	const data = sceneOf(model, id).hub.statuses.vercel.data
	if (data._tag !== "Success") throw new Error(`scene ${id} has no status`)
	return data.data
}
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)

describe("vercel lab", () => {
	test("the scenes read as the states they are named for", () => {
		const model = opened()
		expect(vercelHealth(statusOf(model, "healthy"))).toBe("healthy")
		expect(vercelHealth(statusOf(model, "first-sync"))).toBe("pending")
		expect(Arr.map(vercelIssues(statusOf(model, "logs-deleted")), (issue) => issue.key)).toEqual(["Logs"])
		expect(Arr.map(vercelIssues(statusOf(model, "traces-failing")), (issue) => issue.key)).toEqual([
			"Traces",
		])
		expect(Arr.map(vercelIssues(statusOf(model, "ai-gateway-disabled")), (issue) => issue.title)).toEqual(
			["The AI Gateway drain is disabled on Vercel"],
		)
		expect(Arr.map(vercelIssues(statusOf(model, "token-rejected")), (issue) => issue.fix)).toEqual([
			"token",
		])
	})

	test("each connect step opens the dialog on that step without sending a request", () => {
		const team = update(opened(), Message.ClickedConnectStep({ step: "team" }))
		const configure = sceneOf(team.model, "connect").hub.vercelCard.configure
		expect(configure?.teams?.length).toBe(2)
		expect(configure?.projects).toBeNull()
		expect(configure?.dialog.isOpen).toBe(true)
		expect(Arr.some(names(team.commands), (name) => /Vercel|Load/.test(name))).toBe(false)

		const settings = sceneOf(
			update(opened(), Message.ClickedConnectStep({ step: "settings" })).model,
			"connect",
		)
		expect(settings.hub.vercelCard.configure?.draft).toEqual(
			expect.objectContaining({
				projectScope: "some",
				projectIds: ["prj_storefront", "prj_api"],
				samplingRate: 0.25,
			}),
		)
		const refused = sceneOf(
			update(opened(), Message.ClickedConnectStep({ step: "refused" })).model,
			"connect",
		)
		expect(refused.hub.vercelCard.configure?.error).not.toBeNull()
	})

	test("a write is answered in the lab: connecting closes the dialog", () => {
		const settings = update(opened(), Message.ClickedConnectStep({ step: "settings" })).model
		const index = Option.getOrThrow(
			Arr.findFirstIndex(settings.scenes, (scene) => scene.id === "connect"),
		)
		const connected = update(
			settings,
			Message.GotHubMessage({
				index,
				message: IntegrationsMessage.GotVercelMessage({ message: VercelMessage.SubmittedConnect() }),
			}),
		)
		expect(sceneOf(connected.model, "connect").hub.vercelCard.configure).toBeNull()
	})
})
