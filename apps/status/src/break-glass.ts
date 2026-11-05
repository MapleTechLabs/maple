import {
	StatusPageIncidentImpact,
	type StatusPageIncidentKind,
	StatusPageIncidentStatus,
} from "@maple/domain/primitives"
import {
	sha256Base64Url,
	STATUS_PAGE_OVERLAY_MAX_ENTRIES,
	StatusPageKeys,
	type StatusPageOverlayEntry,
	type StatusPageSnapshot,
	statusFitsKind,
} from "@maple/domain/status-page"
import { MANAGE_FIELDS, NEW_INCIDENT, NO_CHANGE } from "@maple/status-page"
import { Effect, Option, Schema, Array as Arr, String as Str } from "effect"
import type { StatusEnv, StatusStorageError } from "./ports"
import { listOverlay, rememberOverlay } from "./snapshot"

/** A break-glass post that was refused; `status` is the HTTP status the form page answers with. */
export class BreakGlassRejected extends Schema.TaggedError<BreakGlassRejected>()(
	"@maple/status/BreakGlassRejected",
	{ message: Schema.String, status: Schema.Number },
) {}

/** The overlay could not be read or written, so the update was not saved. */
export class BreakGlassNotSaved extends Schema.TaggedError<BreakGlassNotSaved>()(
	"@maple/status/BreakGlassNotSaved",
	{ message: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}

/** Posted forms are small; anything larger is not a person typing an update. */
export const MAX_FORM_BYTES = 32 * 1024

export const BreakGlassForm = Schema.Struct({
	token: Schema.String.check(Schema.isMinLength(1)),
	incidentId: Schema.String,
	title: Schema.String.check(Schema.isMaxLength(200)),
	/** Null is "No change"; a new incident then starts `investigating`. */
	status: Schema.NullOr(StatusPageIncidentStatus),
	/** Null is "No change"; a new incident then starts `major`. */
	impact: Schema.NullOr(StatusPageIncidentImpact),
	body: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(5000)),
	componentIds: Schema.Array(Schema.String),
})
export type BreakGlassForm = typeof BreakGlassForm.Type

const decodeForm = Schema.decodeUnknownOption(BreakGlassForm)

const reject = (status: number, message: string) => Effect.fail(new BreakGlassRejected({ status, message }))

const unreadable = () => new BreakGlassRejected({ status: 400, message: "The form could not be read." })
const TOO_LARGE = "The update is too large."

/** Compares every character whatever the first mismatch, so timing does not leak the digest. */
export const constantTimeEqual = (a: string, b: string): boolean =>
	Arr.reduce(
		Array.from(
			{ length: Math.max(a.length, b.length) },
			// @effect-diagnostics-next-line preferEffectString:off -- per-character loop; Str.charCodeAt allocates an Option per character
			(_, index) => a.charCodeAt(index) ^ b.charCodeAt(index),
		),
		a.length ^ b.length,
		(diff, bits) => diff | bits,
	) === 0

const text = (form: FormData, name: string): string => {
	const value = form.get(name)
	return typeof value === "string" ? Str.trim(value) : ""
}

const orNoChange = (value: string): string | null => (value === NO_CHANGE ? null : value)

/** Reads the body chunk by chunk and stops past the cap, whatever `content-length` claims. */
const readCapped = (
	reader: ReadableStreamDefaultReader<unknown>,
	chunks: ReadonlyArray<Uint8Array>,
	total: number,
): Effect.Effect<ReadonlyArray<Uint8Array>, BreakGlassRejected> =>
	Effect.tryPromise({ try: () => reader.read(), catch: unreadable }).pipe(
		Effect.flatMap((chunk) => {
			if (chunk.done) return Effect.succeed(chunks)
			const value = chunk.value
			if (!(value instanceof Uint8Array)) return Effect.fail(unreadable())
			const size = total + value.byteLength
			if (size > MAX_FORM_BYTES) {
				return Effect.tryPromise({ try: () => reader.cancel(), catch: unreadable }).pipe(
					Effect.ignore,
					Effect.andThen(reject(413, TOO_LARGE)),
				)
			}
			return readCapped(reader, [...chunks, value], size)
		}),
	)

const readFormData = (request: Request): Effect.Effect<FormData, BreakGlassRejected> =>
	Effect.gen(function* () {
		if (Number(request.headers.get("content-length") ?? "0") > MAX_FORM_BYTES) {
			return yield* reject(413, TOO_LARGE)
		}
		const chunks = request.body === null ? [] : yield* readCapped(request.body.getReader(), [], 0)
		const bytes = new Uint8Array(Arr.reduce(chunks, 0, (size, chunk) => size + chunk.byteLength))
		Arr.reduce(chunks, 0, (offset, chunk) => {
			bytes.set(chunk, offset)
			return offset + chunk.byteLength
		})
		const contentType = request.headers.get("content-type") ?? ""
		return yield* Effect.tryPromise({
			try: () => new Response(bytes, { headers: { "content-type": contentType } }).formData(),
			catch: unreadable,
		})
	})

/** Reads the posted form into a validated update, or says what is wrong with it. */
export const parseForm = (request: Request): Effect.Effect<BreakGlassForm, BreakGlassRejected> =>
	Effect.gen(function* () {
		const form = yield* readFormData(request)
		const decoded = decodeForm({
			token: text(form, MANAGE_FIELDS.token),
			incidentId: text(form, MANAGE_FIELDS.incidentId),
			title: text(form, MANAGE_FIELDS.title),
			status: orNoChange(text(form, MANAGE_FIELDS.status)),
			impact: orNoChange(text(form, MANAGE_FIELDS.impact)),
			body: text(form, MANAGE_FIELDS.body),
			componentIds: Arr.filter(
				form.getAll(MANAGE_FIELDS.componentIds),
				(value) => typeof value === "string",
			),
		})
		if (Option.isNone(decoded)) {
			return yield* reject(
				400,
				"Check the form: a token and a message of 1 to 5000 characters are required, status and impact must be listed values, and titles are at most 200 characters.",
			)
		}
		return decoded.value
	})

const notSaved = (message: string) => (cause: StatusStorageError | Schema.SchemaError) =>
	new BreakGlassNotSaved({ message, cause })

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

/**
 * Checks the token and the form against the page as visitors see it (overlay applied), then writes
 * the update under its own KV key. Nothing shared is rewritten, so concurrent posts cannot drop one.
 */
export const postBreakGlassUpdate = (
	env: StatusEnv,
	snapshot: StatusPageSnapshot,
	form: BreakGlassForm,
): Effect.Effect<StatusPageOverlayEntry, BreakGlassRejected | BreakGlassNotSaved> =>
	Effect.gen(function* () {
		const expected = snapshot.breakGlassTokenSha256
		if (expected === null) return yield* reject(403, "Break-glass updates are not enabled for this page.")
		const digest = yield* Effect.promise(() => sha256Base64Url(form.token))
		if (!constantTimeEqual(digest, expected))
			return yield* reject(403, "That token is not valid for this page.")

		const isNew = form.incidentId === NEW_INCIDENT || form.incidentId === ""
		if (isNew && form.title === "") return yield* reject(400, "Give the new incident a title.")
		const target = isNew
			? Option.none()
			: Arr.findFirst(snapshot.incidents, (incident) => incident.id === form.incidentId)
		if (!isNew && Option.isNone(target)) return yield* reject(400, "That incident is not on this page.")
		const kind = Option.getOrElse(
			Option.map(target, (incident) => incident.kind),
			(): StatusPageIncidentKind => "incident",
		)
		if (form.status !== null && !statusFitsKind(kind, form.status)) {
			return yield* reject(
				400,
				kind === "incident"
					? "That status is for maintenance; pick an incident status."
					: "That status is for incidents; pick a maintenance status.",
			)
		}
		// Deduped, and every id must be one of the page's components, so at most that many remain.
		const componentIds = [...new Set(form.componentIds)]
		const known = new Set<string>(Arr.map(snapshot.components, (component) => component.id))
		if (!Arr.every(componentIds, (id) => known.has(id))) {
			return yield* reject(400, "One of the selected components is not on this page.")
		}

		const listed = yield* listOverlay(env, snapshot.pageId).pipe(
			Effect.mapError(notSaved("The overlay could not be read.")),
		)
		if (listed.keys.length >= STATUS_PAGE_OVERLAY_MAX_ENTRIES) {
			return yield* reject(
				409,
				"This page holds the most break-glass updates it can until Maple imports them.",
			)
		}

		const id = env.randomId()
		const entry: StatusPageOverlayEntry = {
			id,
			at: env.nowMs,
			incidentId: isNew ? null : form.incidentId,
			title: form.title === "" ? null : form.title,
			status: isNew ? (form.status ?? "investigating") : form.status,
			impact: isNew ? (form.impact ?? "major") : form.impact,
			body: form.body,
			componentIds,
		}
		yield* encodeJson(entry).pipe(
			Effect.flatMap((json) =>
				env.storage.kvPut(StatusPageKeys.overlayEntry(snapshot.pageId, id), json),
			),
			Effect.mapError(notSaved("The overlay could not be written.")),
		)
		// KV `list` lags writes, so the colo cache carries the new entry until the list catches up.
		yield* rememberOverlay(env, snapshot.pageId, [...listed.entries, entry])
		return entry
	})
