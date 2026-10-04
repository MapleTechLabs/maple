import { Context, Duration, Effect, Layer, Option, Schema } from "effect"
import { EmailSender } from "./bindings"
import { Env } from "./Env"

class EmailDeliveryError extends Schema.TaggedError<EmailDeliveryError>()(
	"@maple/api/platform/EmailDeliveryError",
	{ message: Schema.String },
) {}

export interface EmailServiceApi {
	readonly isConfigured: boolean
	readonly send: (
		to: string,
		subject: string,
		html: string,
		replyTo?: string,
	) => Effect.Effect<void, EmailDeliveryError>
}

const EMAIL_TIMEOUT = Duration.seconds(15)

export class EmailService extends Context.Service<EmailService, EmailServiceApi>()(
	"@maple/api/lib/EmailService",
	{
		make: Effect.gen(function* () {
			const env = yield* Env
			const fromEmail = env.EMAIL_FROM

			// The prd-only `send_email` binding, as the Worker's init bound it.
			const sender = Option.flatten(yield* Effect.serviceOption(EmailSender))

			// Real sends are production-only: non-prod stages share real user data
			// (branched DBs, Clerk members), so a live binding there would deliver
			// duplicate copies of every cron-driven email. The alchemy configs no
			// longer attach EMAIL outside prd; this guard covers any binding that
			// still reaches a non-prod worker (`alchemy dev`, manual deploys).
			const emailAllowed =
				env.MAPLE_ENVIRONMENT === "production" || env.MAPLE_EMAIL_ALLOW_NONPROD === "true"
			const isConfigured = Option.isSome(sender) && emailAllowed

			const send = Effect.fn("EmailService.send")(function* (
				to: string,
				subject: string,
				html: string,
				replyTo?: string,
			) {
				// PII: never stamp recipient/reply-to addresses on spans or logs
				yield* Effect.annotateCurrentSpan("email.subject", subject)
				yield* Effect.annotateCurrentSpan("email.provider", "cloudflare")

				if (Option.isNone(sender)) {
					return yield* Effect.fail(
						new EmailDeliveryError({
							message: "Email not configured: EMAIL binding is missing",
						}),
					)
				}

				if (!emailAllowed) {
					return yield* Effect.fail(
						new EmailDeliveryError({
							message: `Email suppressed: sends are disabled in ${env.MAPLE_ENVIRONMENT} (set MAPLE_EMAIL_ALLOW_NONPROD=true to override)`,
						}),
					)
				}

				const result = yield* sender.value.send({ from: fromEmail, to, subject, html, replyTo }).pipe(
					Effect.mapError(
						(error) =>
							new EmailDeliveryError({
								message: `Cloudflare Email send failed: ${error.message}`,
							}),
					),
					Effect.timeoutOrElse({
						duration: EMAIL_TIMEOUT,
						orElse: () =>
							Effect.fail(
								new EmailDeliveryError({
									message: "Cloudflare Email send timed out after 15s",
								}),
							),
					}),
				)

				yield* Effect.annotateCurrentSpan("email.message_id", result.messageId)
				yield* Effect.logInfo("Email sent successfully").pipe(
					Effect.annotateLogs({ subject, messageId: result.messageId }),
				)
			})

			return { isConfigured, send } satisfies EmailServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
