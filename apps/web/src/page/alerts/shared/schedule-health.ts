import { MAX_ONCALL_REPORTED_GAPS, ONCALL_GAP_LOOKAHEAD_MS } from "@maple/domain/http"
import type { V2OnCallSchedule } from "@maple/domain/http/v2"
import { pluralize } from "@maple/ui/lib/format"
import { Array as Arr, Option } from "effect"
import { memberOf, type OrgMember } from "./org-members"

// What is wrong with a schedule, in words: stretches nobody covers, and participants who left the
// org (their shifts pass to the next person until the rotation is edited).

type Members = ReadonlyArray<OrgMember> | null
type Health = Pick<V2OnCallSchedule, "coverage_gaps" | "departed_user_ids">

const LOOKAHEAD_DAYS = Math.round(ONCALL_GAP_LOOKAHEAD_MS / 86_400_000)

/** "3 gaps in the next 14 days"; none for a schedule with no gap ahead. The API reports up to 20. */
export const coverageGapsText = (schedule: Health): Option.Option<string> => {
	const count = schedule.coverage_gaps.length
	const gaps =
		count >= MAX_ONCALL_REPORTED_GAPS
			? `${MAX_ONCALL_REPORTED_GAPS} or more gaps`
			: `${count} ${pluralize(count, "gap")}`
	return count === 0 ? Option.none() : Option.some(`${gaps} in the next ${LOOKAHEAD_DAYS} days`)
}

/** The departed participants the member list still names; it rarely names someone who left. */
const namedDeparted = (members: Members, schedule: Health): ReadonlyArray<string> =>
	Arr.flatMap(schedule.departed_user_ids, (userId) =>
		Option.match(memberOf(members, userId), { onNone: () => [], onSome: (member) => [member.name] }),
	)

/** A row's few words: "Ben Brook left the org", "A former member left the org", "2 people left the org". */
export const departedText = (members: Members, schedule: Health): Option.Option<string> => {
	const count = schedule.departed_user_ids.length
	const who =
		count === 1
			? Option.getOrElse(Arr.head(namedDeparted(members, schedule)), () => "A former member")
			: `${count} people`
	return count === 0 ? Option.none() : Option.some(`${who} left the org`)
}

const nameList = new Intl.ListFormat("en-GB", { type: "conjunction" })

/**
 * Everyone who left, by name, as a sentence: "Ben Brook and 2 former members left the org". The
 * people the member list no longer names are counted after the named ones.
 */
export const departedSentence = (members: Members, schedule: Health): Option.Option<string> => {
	const named = namedDeparted(members, schedule)
	const unnamed = schedule.departed_user_ids.length - named.length
	// Alone, the unnamed one opens the sentence.
	const one = named.length === 0 ? "A former member" : "a former member"
	const others = unnamed === 0 ? [] : [unnamed === 1 ? one : `${unnamed} former members`]
	return schedule.departed_user_ids.length === 0
		? Option.none()
		: Option.some(`${nameList.format([...named, ...others])} left the org`)
}
