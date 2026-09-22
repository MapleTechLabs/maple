/**
 * The channel allowlist, which is the whole of what makes a workspace-wide install a bot that is
 * only in the channels somebody put it in.
 *
 * The empty case is the one worth stating out loud: no list means the bot answers NOWHERE, so a
 * workspace that is linked but not configured is silent rather than listening everywhere.
 */
import { describe, expect, it } from "vitest"
import { ALLOWED_CHANNELS_SETTING, isChannelAllowed } from "./settings"

const listing = (value: string) => ({ [ALLOWED_CHANNELS_SETTING]: value })

describe("the channels a bot answers in", () => {
	it("answers nowhere until channels are listed", () => {
		expect(isChannelAllowed({}, "channel-1")).toBe(false)
		expect(isChannelAllowed(listing(""), "channel-1")).toBe(false)
		expect(isChannelAllowed({ approver_role_id: "role-1" }, "channel-1")).toBe(false)
	})

	it("answers in a listed channel and nowhere else", () => {
		const settings = listing("channel-1, channel-2")
		expect(isChannelAllowed(settings, "channel-1")).toBe(true)
		expect(isChannelAllowed(settings, "channel-2")).toBe(true)
		expect(isChannelAllowed(settings, "channel-3")).toBe(false)
		// A prefix of a listed id is a different channel.
		expect(isChannelAllowed(settings, "channel-10")).toBe(false)
	})

	it("reads the ids however an admin separated them", () => {
		// One pasted column, one typed line, and the trailing comma somebody leaves behind.
		for (const value of ["channel-1\nchannel-2\n", "channel-1 , channel-2,"]) {
			expect(isChannelAllowed(listing(value), "channel-1")).toBe(true)
			expect(isChannelAllowed(listing(value), "channel-2")).toBe(true)
			expect(isChannelAllowed(listing(value), "")).toBe(false)
		}
	})
})
