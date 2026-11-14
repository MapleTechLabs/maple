import type { DataSourceKind } from "@maple/domain/data-sources"
import type {
	V2DataSource,
	V2DataSourceConnectionParams,
	V2DataSourceCreateParams,
	V2DataSourceUpdateParams,
} from "@maple/domain/http/v2"
import { Array as Arr, Option, String as Str } from "effect"
import { type Draft, DraftField } from "./model"

// The connect form's rules, and the draft as the v2 API takes it.

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/
const MAX_TAGS = 10

export const emptyDraft: Draft = {
	name: "",
	description: "",
	environment: "production",
	tags: "",
	agentAccess: true,
	agentPii: false,
	url: "",
	user: "",
	database: "default",
	password: "",
	secretKey: "",
}

export const draftOf = (source: V2DataSource): Draft => ({
	...emptyDraft,
	name: source.name,
	description: source.description,
	environment: source.environment,
	tags: Arr.join(source.tags, ", "),
	agentAccess: source.agent_access,
	agentPii: source.agent_pii,
	...(source.connection.type === "clickhouse"
		? { url: source.connection.url, user: source.connection.user, database: source.connection.database }
		: undefined),
})

/** Clerk keys say their instance: `sk_live_` is production, `sk_test_` development. */
export const clerkInstanceOf = (key: string): "production" | "development" | null => {
	const trimmed = Str.trim(key)
	if (Str.startsWith("sk_live_")(trimmed)) return "production"
	if (Str.startsWith("sk_test_")(trimmed)) return "development"
	return null
}

export const tagsOf = (draft: Draft): ReadonlyArray<string> =>
	Arr.dedupe(Arr.filter(Arr.map(Str.split(draft.tags, ","), Str.trim), Str.isNonEmpty))

const isHttpUrl = (value: string): boolean =>
	URL.canParse(Str.trim(value)) && /^https?:/i.test(Str.trim(value))

/** Each invalid field and why. `isEditing` lets the secret stay blank (it keeps the stored one). */
export const draftErrors = (
	draft: Draft,
	kind: DataSourceKind,
	isEditing: boolean,
): Partial<Record<DraftField, string>> => {
	const errors: Partial<Record<DraftField, string>> = {}
	if (!NAME_PATTERN.test(Str.trim(draft.name)))
		errors.name = "Use lowercase letters, digits and dashes, starting with a letter or digit (shop-prod)."
	if (Str.trim(draft.description) === "")
		errors.description = "Describe what this source holds. Assistants read it to pick the right source."
	const tags = tagsOf(draft)
	if (tags.length > MAX_TAGS) errors.tags = `Use at most ${MAX_TAGS} tags.`
	else if (Arr.some(tags, (tag) => tag.length > 40)) errors.tags = "Keep each tag to 40 characters."
	if (kind === "clickhouse") {
		if (!isHttpUrl(draft.url))
			errors.url =
				"Enter the HTTP interface URL, starting with https:// (or http://, which sends the password unencrypted)."
		if (Str.trim(draft.user) === "") errors.user = "Enter the user Maple connects as."
		if (Str.trim(draft.database) === "") errors.database = "Enter the database to read."
	} else if (
		!(isEditing && Str.trim(draft.secretKey) === "") &&
		clerkInstanceOf(draft.secretKey) === null
	) {
		errors.secretKey = "Paste a Clerk secret key; it starts with sk_live_ or sk_test_."
	}
	return errors
}

export const isDraftValid = (draft: Draft, kind: DataSourceKind, isEditing: boolean): boolean =>
	Arr.every(DraftField.literals, (field) => draftErrors(draft, kind, isEditing)[field] === undefined)

const connectionOf = (draft: Draft, kind: DataSourceKind): V2DataSourceConnectionParams => {
	const secret = (value: string) => Option.liftPredicate(Str.trim(value), Str.isNonEmpty)
	if (kind === "clerk")
		return Option.match(secret(draft.secretKey), {
			onNone: () => ({ type: "clerk" }),
			onSome: (secretKey) => ({ type: "clerk", secret_key: secretKey }),
		})
	const base = {
		type: "clickhouse" as const,
		url: Str.trim(draft.url),
		user: Str.trim(draft.user),
		database: Str.trim(draft.database),
	}
	return Option.match(secret(draft.password), {
		onNone: () => base,
		onSome: (password) => ({ ...base, password }),
	})
}

export const createParamsOf = (draft: Draft, kind: DataSourceKind): V2DataSourceCreateParams => ({
	name: Str.trim(draft.name),
	description: Str.trim(draft.description),
	environment: draft.environment,
	tags: tagsOf(draft),
	agent_access: draft.agentAccess,
	agent_pii: draft.agentPii,
	connection: connectionOf(draft, kind),
})

/** An edit sends every field; the connection only when it changed or a new secret was typed. */
export const updateParamsOf = (
	draft: Draft,
	kind: DataSourceKind,
	source: V2DataSource,
): V2DataSourceUpdateParams => {
	const { connection, ...rest } = createParamsOf(draft, kind)
	const saved = draftOf(source)
	const isConnectionChanged =
		draft.url !== saved.url ||
		draft.user !== saved.user ||
		draft.database !== saved.database ||
		Str.trim(draft.password) !== "" ||
		Str.trim(draft.secretKey) !== ""
	return isConnectionChanged ? { ...rest, connection } : rest
}
