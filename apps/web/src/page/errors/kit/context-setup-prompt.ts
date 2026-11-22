import { Array as Arr } from "effect"

// What an error is missing to say which build and which user it hit, and the prompt that has a
// coding agent add it.

/** Which of the two the samples never carry. */
export type MissingContext = Readonly<{ release: boolean; user: boolean }>

/** The attributes Maple reads: `service.version` on the resource, `user.id` (or `enduser.id`) on the span. */
export const RELEASE_ATTRIBUTE = "service.version"
export const USER_ATTRIBUTE = "user.id"

const ATTRIBUTE_NAMES = (missing: MissingContext): ReadonlyArray<string> => [
	...(missing.release ? [RELEASE_ATTRIBUTE] : []),
	...(missing.user ? [USER_ATTRIBUTE] : []),
]

/** The foot's one line: what adding the missing context gets you, not what is absent. */
export const missingContextLine = (missing: MissingContext): string =>
	missing.release && missing.user
		? "See which release broke and who it hits"
		: missing.release
			? "See which release each error came from"
			: "See which users each error hits"

export type ContextItem = Readonly<{
	key: "release" | "user"
	title: string
	/** What Maple shows once it is set. */
	gain: string
	attribute: string
	/** Where the attribute goes, after its name. */
	where: string
}>

const ITEMS: ReadonlyArray<ContextItem> = [
	{
		key: "release",
		title: "Release",
		gain: "Which build each error came from, and which release a fix shipped in.",
		attribute: RELEASE_ATTRIBUTE,
		where: "on the SDK resource: a version or commit SHA",
	},
	{
		key: "user",
		title: "User",
		gain: "How many users an error hits, with a link to each one.",
		attribute: USER_ATTRIBUTE,
		where: "on every span after sign-in, including the one that records the error",
	},
]

/** The missing items, release first, for the setup card. */
export const missingContextItems = (missing: MissingContext): ReadonlyArray<ContextItem> =>
	Arr.filter(ITEMS, (item) => missing[item.key])

/** A prompt a coding agent can act on in the service's repository, naming only what is missing. */
export const contextSetupPrompt = (serviceName: string, missing: MissingContext): string => {
	const service = serviceName === "" ? "this service" : `the ${serviceName} service`
	const steps = [
		...(missing.release
			? [
					`Set the OpenTelemetry resource attribute \`${RELEASE_ATTRIBUTE}\` where the SDK is initialised. Use the deployed version: a release tag or the git commit SHA, read from an environment variable the build or deploy sets (add one to the build if none exists). Keep \`service.name\` as it is.`,
				]
			: []),
		...(missing.user
			? [
					`Set the span attribute \`${USER_ATTRIBUTE}\` to the signed-in user's stable id, right after authentication. Maple reads it from the span that records the exception, so it must reach child spans too: put it in baggage and copy it onto each new span with a span processor, or set it wherever errors are recorded. Use an opaque id, not an email or a name. Skip it for anonymous requests.`,
				]
			: []),
	]
	return Arr.join(
		[
			`Add ${Arr.join(ATTRIBUTE_NAMES(missing), " and ")} to the OpenTelemetry instrumentation of ${service}, so Maple can show which release and which user each error comes from.`,
			"",
			...Arr.map(steps, (step, index) => `${index + 1}. ${step}`),
			`${steps.length + 1}. Keep the change small and follow the existing instrumentation setup. Do not add a second SDK or exporter.`,
			"",
			"Afterwards, tell me where you set each attribute and how to check it on a new trace.",
		],
		"\n",
	)
}
