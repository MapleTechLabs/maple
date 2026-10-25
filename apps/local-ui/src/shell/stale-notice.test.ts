import { Result } from "effect"
import { AsyncData } from "foldkit"
import { describe, expect, test } from "vitest"
import { shownDataOf } from "../data/shown"
import { idle } from "../data/slot"
import { describeNotice } from "./stale-notice"

const NOW = Date.parse("2026-10-01T12:00:00Z")
const timeFormat = { locale: "en-US", timeZone: "UTC" }
const shownAt = (atMs: number, extra: Readonly<{ isStandIn?: boolean; isRefreshing?: boolean }> = {}) => ({
	rows: {
		...idle<ReadonlyArray<number>>(),
		key: "k",
		data: extra.isRefreshing === true ? AsyncData.Refreshing({ data: [1] }) : AsyncData.Success({ data: [1] }),
		updatedAtMs: atMs,
		isStandIn: extra.isStandIn ?? false,
	},
})
const notice = (page: unknown, flags: Readonly<{ isDisconnected?: boolean; isBusy?: boolean }> = {}) =>
	describeNotice({
		isDisconnected: flags.isDisconnected ?? false,
		isBusy: flags.isBusy ?? false,
		shown: shownDataOf(page, NOW),
		nowMs: NOW,
		timeFormat,
	})

describe("stale data notice", () => {
	test("a stand-in from an older window says it is loading newer results", () => {
		expect(notice(shownAt(NOW - 3_600_000, { isStandIn: true, isRefreshing: true }))?.text).toBe(
			"Loading newer results. Showing results from 11:00 AM.",
		)
	})

	test("a busy server and a gone one say so; only the gone one offers Try again", () => {
		const standIn = shownAt(NOW - 3_600_000, { isStandIn: true, isRefreshing: true })
		expect(notice(standIn, { isBusy: true })).toEqual({ tone: "warn", text: "Maple Local is busy. Showing results from 11:00 AM.", isRetrying: false })
		expect(notice(standIn, { isDisconnected: true })?.isRetrying).toBe(true)
	})

	test("fresh results on screen need no notice; a refetch of old ones does", () => {
		expect(notice(shownAt(NOW - 5_000))).toBeNull()
		expect(notice(shownAt(NOW - 5_000, { isRefreshing: true }))).toBeNull()
		expect(notice(shownAt(NOW - 60_000, { isRefreshing: true }))?.tone).toBe("neutral")
	})

	test("an older day shows its date", () => {
		expect(notice(shownAt(NOW - 26 * 3_600_000, { isStandIn: true }))?.text).toBe("Loading newer results. Showing results from Sep 30, 10:00 AM.")
	})

	test("an expanded error card's failed traces refresh counts as a failed refresh", () => {
		const refreshed = { ...shownAt(NOW - 60_000).rows, data: AsyncData.settle(AsyncData.Refreshing({ data: [1] }), Result.fail({ message: "down" })) }
		expect(shownDataOf({ cards: { abc: { isExpanded: true, traces: refreshed } } }, NOW).refreshFailed).toBe(true)
	})
})
