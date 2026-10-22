import { AsyncData } from "foldkit"
import { Result } from "effect"
import { expect as expectView, given, scene, selector, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../../data/load-failure"
import { Message, type Model } from "./model"
import { init, revisit, update } from "./update"
import { view } from "./view"

const member = (id: string) => ({
	id,
	name: id,
	identifier: `${id}@acme.test`,
	imageUrl: "",
	role: "org:member",
	createdAtMs: 0,
	isCurrentUser: false,
})

describe("members tab", () => {
	test("a failed Load more keeps the rows and frees the button for another try", () => {
		const firstPage = {
			rows: Array.from({ length: 10 }, (_, index) => member(`user_${index}`)),
			total: 12,
		}
		const loaded = update(
			init(true).model,
			Message.CompletedFetchMembers({ page: 1, generation: 0, result: Result.succeed(firstPage) }),
		).model
		const fetching = update(loaded, Message.ClickedLoadMoreMembers())
		expect(fetching.commands?.map((command) => command.name)).toEqual(["FetchClerkMemberships"])
		const failed = update(
			fetching.model,
			Message.CompletedFetchMembers({
				page: 2,
				generation: 0,
				result: Result.fail(toLoadFailure(new Error("rate limited"))),
			}),
		).model
		const data = AsyncData.getOrElse(failed.members, () => null)
		expect(data?.rows).toHaveLength(10)
		expect(data?.isFetchingMore).toBe(false)
		expect(
			update(failed, Message.ClickedLoadMoreMembers()).commands?.map((command) => command.name),
		).toEqual(["FetchClerkMemberships"])
	})
})

describe("members paging under a mutation", () => {
	test("a Load more in flight when a role change re-reads page 1 is dropped, not appended", () => {
		const firstPage = {
			rows: Array.from({ length: 10 }, (_, index) => member(`user_${index}`)),
			total: 12,
		}
		const loaded = update(
			init(true).model,
			Message.CompletedFetchMembers({ page: 1, generation: 0, result: Result.succeed(firstPage) }),
		).model
		const paging = update(loaded, Message.ClickedLoadMoreMembers()).model
		const changed = update(
			paging,
			Message.CompletedRoleChange({
				name: "user_1",
				next: "org:admin",
				result: Result.succeed(undefined),
			}),
		)
		const reread = changed.commands?.find((command) => command.name === "FetchClerkMemberships")
		expect(reread?.args).toMatchObject({ page: 1 })
		const generation = changed.model.membersGeneration
		const refreshed = update(
			changed.model,
			Message.CompletedFetchMembers({ page: 1, generation, result: Result.succeed(firstPage) }),
		).model
		const stale = update(
			refreshed,
			Message.CompletedFetchMembers({
				page: 2,
				generation: 0,
				result: Result.succeed({ rows: [member("user_10"), member("user_11")], total: 12 }),
			}),
		).model
		const data = AsyncData.getOrElse(stale.members, () => null)
		expect(data?.rows).toHaveLength(10)
		expect(data?.isFetchingMore).toBe(false)
	})
})

describe("members revisits after a failure", () => {
	test("two quick revisits read page 1 twice and only the newer answer lands", () => {
		const failure = Result.fail(toLoadFailure(new Error("down")))
		const failed = update(
			init(true).model,
			Message.CompletedFetchMembers({ page: 1, generation: 0, result: failure }),
		).model
		const generationOf = (step: ReturnType<typeof revisit>) =>
			step.commands?.find((command) => command.name === "FetchClerkMemberships")?.args?.generation
		const first = revisit(failed)
		const second = revisit(first.model)
		expect(generationOf(second)).not.toBe(generationOf(first))
		const newer = { rows: [member("user_new")], total: 1 }
		const landed = update(
			second.model,
			Message.CompletedFetchMembers({
				page: 1,
				generation: second.model.membersGeneration,
				result: Result.succeed(newer),
			}),
		).model
		const older = { rows: [member("user_old")], total: 1 }
		const late = update(
			landed,
			Message.CompletedFetchMembers({
				page: 1,
				generation: first.model.membersGeneration,
				result: Result.succeed(older),
			}),
		).model
		expect(AsyncData.getOrElse(late.members, () => null)?.rows.map((row) => row.id)).toEqual(["user_new"])
	})
})

describe("members avatars", () => {
	test("a member's Clerk image is drawn over the initials", () => {
		const withOrg = update(init(true).model, Message.CompletedFetchOrganization({ name: "Acme" })).model
		const rows = [{ ...member("ada"), imageUrl: "https://img.clerk.test/ada.png" }, member("bob")]
		const page = Result.succeed({ rows, total: 2 })
		const loaded = update(
			withOrg,
			Message.CompletedFetchMembers({ page: 1, generation: 0, result: page }),
		).model
		const image = selector('[data-slot="avatar-image"]')
		scene(
			{
				update: (model: Model, message: Message) => update(model, message),
				view: withViewInputs(view, { nowMs: 0, timeZone: "UTC" })(),
			},
			given(loaded),
			expectView(image).toHaveAttr("src", "https://img.clerk.test/ada.png"),
		)
	})
})
