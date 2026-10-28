import { StatusPageIncidentImpact, StatusPageIncidentStatus } from "@maple/domain/primitives"
import {
	decodeStatusPageOverlayJson,
	sha256Base64Url,
	STATUS_PAGE_OVERLAY_MAX_ENTRIES,
	StatusPageKeys,
	type StatusPageOverlayEntry,
	type StatusPageSnapshot,
} from "@maple/domain/status-page"
import { MANAGE_FIELDS, NEW_INCIDENT } from "@maple/status-page"
import { Effect, Option, Schema } from "effect"
import type { StatusEnv } from "./ports"

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
	status: StatusPageIncidentStatus,
	impact: StatusPageIncidentImpact,
	body: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(5000)),
	componentIds: Schema.Array(Schema.String),
})
export type BreakGlassForm = typeof BreakGlassForm.Type

const decodeForm = Schema.decodeUnknownOption(BreakGlassForm)

const reject = (status: number, message: string) => Effect.fail(new BreakGlassRejected({ status, message }))

/** Compares every character whatever the first mismatch, so timing does not leak the digest. */
export const constantTimeEqual = (a: string, b: string): boolean =>
	Array.from(
		{ length: Math.max(a.length, b.length) },
		(_, index) => a.charCodeAt(index) ^ b.charCodeAt(index),
	).reduce((diff, bits) => diff | bits, a.length ^ b.length) === 0

const text = (form: FormData, name: string): string => {
	const value = form.get(name)
	return typeof value === "string" ? value.trim() : ""
}

/** Reads the posted form into a validated update, or says what is wrong with it. */
export const parseForm = (request: Request): Effect.Effect<BreakGlassForm, BreakGlassRejected> =>
	Effect.gen(function* () {
		const length = Number(request.headers.get("content-length") ?? "0")
		if (length > MAX_FORM_BYTES) return yield* reject(413, "The update is too large.")
		const form = yield* Effect.tryPromise({
			try: () => request.formData(),
			catch: () => new BreakGlassRejected({ status: 400, message: "The form could not be read." }),
		})
		const decoded = decodeForm({
			token: text(form, MANAGE_FIELDS.token),
			incidentId: text(form, MANAGE_FIELDS.incidentId),
			title: text(form, MANAGE_FIELDS.title),
			status: text(form, MANAGE_FIELDS.status),
			impact: text(form, MANAGE_FIELDS.impact),
			body: text(form, MANAGE_FIELDS.body),
			componentIds: form
				.getAll(MANAGE_FIELDS.componentIds)
				.filter((value) => typeof value === "string"),
		})
		if (Option.isNone(decoded)) {
			return yield* reject(
				400,
				"Check the form: a token, a status, an impact and a message of 1 to 5000 characters are required, and titles are at most 200 characters.",
			)
		}
		return decoded.value
	})

/** Checks the token and the form against the page, then appends the update to the KV overlay. */
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
		if (!isNew && !snapshot.incidents.some((incident) => incident.id === form.incidentId)) {
			return yield* reject(400, "That incident is not on this page.")
		}
		const componentIds = new Set<string>(snapshot.components.map((component) => component.id))
		if (!form.componentIds.every((id) => componentIds.has(id))) {
			return yield* reject(400, "One of the selected components is not on this page.")
		}

		const key = StatusPageKeys.overlay(snapshot.pageId)
		const raw = yield* env.storage
			.kvGet(key)
			.pipe(
				Effect.mapError(
					(cause) => new BreakGlassNotSaved({ message: "The overlay could not be read.", cause }),
				),
			)
		const entries =
			raw === null
				? []
				: Option.match(decodeStatusPageOverlayJson(raw), {
						onNone: () => [],
						onSome: (overlay) => overlay.entries,
					})
		if (entries.length >= STATUS_PAGE_OVERLAY_MAX_ENTRIES) {
			return yield* reject(
				409,
				"This page holds the most break-glass updates it can until Maple imports them.",
			)
		}

		const entry: StatusPageOverlayEntry = {
			id: env.randomId(),
			at: env.nowMs,
			incidentId: isNew ? null : form.incidentId,
			title: form.title === "" ? null : form.title,
			status: form.status,
			impact: form.impact,
			body: form.body,
			componentIds: form.componentIds,
		}
		// Read-modify-write: two posts in the same instant can drop one. Break-glass has one or two writers.
		yield* env.storage
			.kvPut(key, JSON.stringify({ entries: [...entries, entry] }))
			.pipe(
				Effect.mapError(
					(cause) =>
						new BreakGlassNotSaved({ message: "The overlay could not be written.", cause }),
				),
			)
		return entry
	})
