import { describe, expect, test } from "vitest"
import { vercelHealth, vercelIssues } from "../components/integrations/vercel-model"
import { Message as IntegrationsMessage } from "../page/integrations/message"
import { init, Message, update } from "./vercel-lab"

const NOW = Date.UTC(2026, 9, 20, 12)
const opened = () => init({ nowMs: NOW, timeZone: "UTC" }).model
const sceneOf = (model: ReturnType<typeof opened>, id: string) => {
	const scene = model.scenes.find((candidate) => candidate.id === id)
	if (scene === undefined) throw new Error(`no scene ${id}`)
	return scene
}
const statusOf = (model: ReturnType<typeof opened>, id: string) => {
	const data = sceneOf(model, id).hub.statuses.vercel.data
	if (data._tag !== "Success") throw new Error(`scene ${id} has no status`)
	return data.data
}
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

describe("vercel lab", () => {
	test("the scenes read as the states they are named for", () => {
		const model = opened()
		expect(vercelHealth(statusOf(model, "healthy"))).toBe("healthy")
		expect(vercelHealth(statusOf(model, "first-sync"))).toBe("pending")
		expect(vercelIssues(statusOf(model, "logs-deleted")).map((issue) => issue.key)).toEqual(["Logs"])
		expect(vercelIssues(statusOf(model, "traces-failing")).map((issue) => issue.key)).toEqual(["Traces"])
		expect(vercelIssues(statusOf(model, "token-rejected")).map((issue) => issue.fix)).toEqual(["token"])
		expect(sceneOf(model, "usage-failed").hub.vercelCard.projects.data._tag).toBe("Failure")
	})

	test("each connect step opens the dialog on that step without sending a request", () => {
		const team = update(opened(), Message.ClickedConnectStep({ step: "team" }))
		const configure = sceneOf(team.model, "connect").hub.vercelCard.configure
		expect(configure?.teams?.length).toBe(2)
		expect(configure?.projects).toBeNull()
		expect(configure?.dialog.isOpen).toBe(true)
		expect(names(team.commands).some((name) => /Vercel|Load/.test(name))).toBe(false)

		const settings = sceneOf(update(opened(), Message.ClickedConnectStep({ step: "settings" })).model, "connect")
		expect(settings.hub.vercelCard.configure?.draft).toEqual(
			expect.objectContaining({ projectScope: "some", projectIds: ["prj_storefront", "prj_api"], samplingRate: 0.25 }),
		)
		const refused = sceneOf(update(opened(), Message.ClickedConnectStep({ step: "refused" })).model, "connect")
		expect(refused.hub.vercelCard.configure?.error).not.toBeNull()
	})

	test("a write is answered in the lab: connecting closes the dialog", () => {
		const settings = update(opened(), Message.ClickedConnectStep({ step: "settings" })).model
		const index = settings.scenes.findIndex((scene) => scene.id === "connect")
		const connected = update(
			settings,
			Message.GotHubMessage({ index, message: IntegrationsMessage.SubmittedVercelConnect() }),
		)
		expect(sceneOf(connected.model, "connect").hub.vercelCard.configure).toBeNull()
	})
})
