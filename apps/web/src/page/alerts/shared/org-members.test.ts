import { Effect, Array as Arr } from "effect"
import { describe, expect, it } from "vitest"
import type { ClerkMembershipResource } from "../../../platform/clerk"
import { MAX_MEMBERS, memberName, membersOf } from "./org-members"

const membership = (n: number): ClerkMembershipResource => ({
	id: `mem_${n}`,
	role: "org:member",
	createdAt: new Date(0),
	publicUserData: {
		userId: `user_${n}`,
		firstName: `Person`,
		lastName: String(n),
		identifier: `person${n}@acme.test`,
		imageUrl: "",
		hasImage: false,
	},
	update: () => Promise.resolve(),
	destroy: () => Promise.resolve(),
})

/** An org of `total` members, served 100 a page, counting the pages asked for. */
const organizationOf = (total: number) => {
	const asked: Array<number> = []
	return {
		asked,
		getMemberships: ({ initialPage = 1, pageSize = 10 }: { initialPage?: number; pageSize?: number }) => {
			asked.push(initialPage)
			const start = (initialPage - 1) * pageSize
			return Promise.resolve({
				data: Arr.map(Arr.range(start, Math.min(start + pageSize, total) - 1), membership),
				total_count: total,
			})
		},
	}
}

describe("org members", () => {
	it("reads every page of a large org, not just the first 100", async () => {
		const organization = organizationOf(250)
		const members = await Effect.runPromise(membersOf(organization))
		expect(members).toHaveLength(250)
		expect(memberName(members, "user_249")).toBe("Person 249")
		expect([...organization.asked].sort()).toEqual([1, 2, 3])
	})

	it("stops at the cap, and names a member past it neutrally rather than as gone", async () => {
		const members = await Effect.runPromise(membersOf(organizationOf(MAX_MEMBERS + 150)))
		expect(members).toHaveLength(MAX_MEMBERS)
		expect(memberName(members, `user_${MAX_MEMBERS + 10}`)).toBe("Member")
	})

	it("reads unknown ids as former members only once the whole directory is known", () => {
		expect(memberName(null, "user_1")).toBe("Member")
		expect(memberName([], "user_1")).toBe("A former member")
	})
})
