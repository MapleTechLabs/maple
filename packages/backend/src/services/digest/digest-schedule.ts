import { DateTime, Option } from "effect"

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The shortest gap between two sends of one digest. Shorter than a week so a send that ran
 * late last week never blocks this week's, longer than a day so moving the hour or zone right
 * after a send cannot fire the same week's digest twice.
 */
const MIN_RESEND_GAP_MS = 6 * DAY_MS

export interface DigestSchedule {
	/** 0 = Sunday ... 6 = Saturday, in `timezone`. */
	readonly dayOfWeek: number
	/** Local hour (0-23) from which the digest is due for the rest of that local day. */
	readonly sendHour: number
	/** IANA zone; an unknown one falls back to UTC rather than never sending. */
	readonly timezone: string
}

const resolveZone = (timezone: string): DateTime.TimeZone =>
	Option.getOrElse(DateTime.zoneMakeNamed(timezone), () => DateTime.zoneMakeOffset(0))

/**
 * Latest instant a previous send or claimed attempt may sit at for a new one to be allowed.
 * The tick filter and the claim both guard on it, so one local-day window gets one attempt
 * even when it straddles UTC midnight.
 */
export const digestResendCutoffMs = (nowMs: number): number => nowMs - MIN_RESEND_GAP_MS

/** The later of the last send and the last claimed attempt, the activity the gap is measured from. */
export const lastDigestActivity = (
	lastSentAt: number | null,
	lastAttemptedAt: number | null,
): number | null =>
	lastSentAt === null
		? lastAttemptedAt
		: lastAttemptedAt === null
			? lastSentAt
			: Math.max(lastSentAt, lastAttemptedAt)

/**
 * Whether a weekly digest should go out at `nowMs`: it is the subscriber's chosen weekday in
 * their zone, the local clock has reached their send hour, and nothing was sent or attempted in
 * the last six days. The digest tick runs every 15 minutes, so this window is hit on the first
 * tick at or after the send hour, and `lastActivityAt` keeps every later tick that day idempotent.
 */
export function isDigestDue(schedule: DigestSchedule, lastActivityAt: number | null, nowMs: number): boolean {
	const local = DateTime.toParts(
		DateTime.makeZonedUnsafe(nowMs, { timeZone: resolveZone(schedule.timezone) }),
	)
	if (local.weekDay !== schedule.dayOfWeek || local.hour < schedule.sendHour) return false
	return lastActivityAt === null || lastActivityAt <= digestResendCutoffMs(nowMs)
}
