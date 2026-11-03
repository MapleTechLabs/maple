import { createHash } from "node:crypto"
import { Effect, Option, Array as Arr, String as Str } from "effect"
import { AdoptPolicy } from "alchemy/AdoptPolicy"
import { AlchemyContext } from "alchemy/AlchemyContext"
import { Stack } from "alchemy/Stack"
import { createInternalTags } from "alchemy/Tags"
import { MapleAlertRuleOwnershipError, MapleAlertRuleTagsError } from "./errors"

const prefix = "alchemy:"

export const ownershipTags = (tags: ReadonlyArray<string>) =>
	Arr.filter(tags, (tag) => Str.startsWith(prefix)(tag))

/** Maple limits tags to 32 characters, so hash Alchemy's stack/stage/FQN identity. */
const ruleOwnerTag = Effect.fn(function* (fqn: string) {
	const identity = yield* createInternalTags(fqn)
	// A fixed local identity is encoded for hashing, not sent over a JSON boundary.
	// oxlint-disable-next-line effecttsgo/global-json-in-effect
	return `${prefix}${Str.slice(0, 24)(createHash("sha256").update(JSON.stringify(identity)).digest("hex"))}`
})

export const ruleOwnerTags = Effect.fn(function* (fqn: string) {
	const current = yield* ruleOwnerTag(fqn)
	const stack = yield* Stack
	// An explicit logical rename transfers the same stack/stage's ownership.
	const previous = yield* Effect.forEach(stack.resources[fqn]?.FormerFqns ?? [], ruleOwnerTag)
	return [current, ...previous] as const
})

export const ruleTags = Effect.fn(function* (
	tags: ReadonlyArray<string> | undefined,
	observed: ReadonlyArray<string>,
	owner: string,
) {
	const userTags = Array.from(
		new Set(
			Arr.filter(
				Arr.map(tags ?? Arr.filter(observed, (tag) => !Str.startsWith(prefix)(tag)), (tag) =>
					Str.toLowerCase(Str.trim(tag)),
				),
				Boolean,
			),
		),
	)
	if (userTags.length > 19 || Arr.some(userTags, (tag) => Str.startsWith(prefix)(tag))) {
		return yield* new MapleAlertRuleTagsError({
			message: "Alert rules allow up to 19 user tags; the alchemy: prefix is reserved for ownership.",
		})
	}
	return [...userTags, owner]
})

/** Match the engine's per-resource, service, then CLI adoption precedence. */
export const canAdoptRule = Effect.fn(function* (fqn: string) {
	const stack = yield* Stack
	const resourceSetting = stack.resources[fqn]?.Adopt
	if (resourceSetting !== undefined) return resourceSetting
	const policy = yield* Effect.serviceOption(AdoptPolicy)
	if (Option.isSome(policy)) return policy.value
	const context = yield* Effect.serviceOption(AlchemyContext)
	return Option.isSome(context) && context.value.adopt
})

export const ownsRule = (tags: ReadonlyArray<string>, expected: ReadonlyArray<string>, tracked: boolean) => {
	const owners = ownershipTags(tags)
	// Existing state is the ownership evidence for pre-tag provider releases.
	return (owners.length === 1 && expected.includes(owners[0])) || (tracked && owners.length === 0)
}

export const ownershipError = (fqn: string, ruleName: string) =>
	new MapleAlertRuleOwnershipError({
		fqn,
		ruleName,
		message: `Alert rule '${ruleName}' is not owned by '${fqn}' in this stack and stage. Use explicit Alchemy adoption to take it over.`,
	})
