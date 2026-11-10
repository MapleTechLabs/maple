import { AlertValidationError } from "@maple/domain/http"
import { afterEach, assert, describe, it } from "@effect/vitest"
import * as PG from "@maple-dev/effect-orm/postgres"
import { AlertDestinations } from "@maple/db/tables"
import { AlertDestinationId, ChatWorkspaceId, OrgId } from "@maple/domain/http"
import { Effect, Option, Schema } from "effect"
import type { EncryptedValue } from "@maple/backend/platform/Crypto"
import { parseSecretKeyring, sealSecret } from "@maple/backend/platform/SecretBox"
import { alertDestinationSecretSlot } from "@maple/backend/platform/secret-slots"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { hydrateDestinationRow, type DestinationSecretConfig } from "./AlertDestinationHydration"

/*
 * These go through a real driver round-trip on purpose. `config_json` is a
 * jsonb column, so the driver hands back a parsed object — decoding it as a
 * JSON *string* fails for every destination of every type, which is exactly
 * what silently broke escalation and error-issue delivery in production
 * ("Stored destination config is invalid"). A hand-built row object would pass
 * with or without the bug; only the DB read pins it.
 */

const createdDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(createdDbs))

const sealError = (message: string) => new AlertValidationError({ message, details: [] })

const makeKeyring = parseSecretKeyring(
	{ primary: Buffer.alloc(32, 1).toString("base64"), decryptOnly: Option.none() },
	sealError,
)

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asDestinationId = Schema.decodeUnknownSync(AlertDestinationId)
const ORG = asOrgId("org_destination_hydration_test")

const hydrationErrors = {
	onPublicConfigInvalid: () => "public_config_invalid" as const,
	onDecryptFailure: () => "decrypt_failure" as const,
	onSecretConfigInvalid: () => "secret_config_invalid" as const,
}

const seedDestination = (options: {
	readonly id: AlertDestinationId
	readonly type: string
	readonly publicConfig: Record<string, unknown>
	readonly secretConfig: DestinationSecretConfig
	/** A triple sealed elsewhere, stored as-is instead of sealing for this row. */
	readonly storedSecret?: EncryptedValue
}) =>
	Effect.gen(function* () {
		const database = yield* Database
		const keyring = yield* makeKeyring
		const encrypted =
			options.storedSecret ??
			(yield* sealSecret(
				keyring,
				alertDestinationSecretSlot,
				{ orgId: ORG, id: options.id },
				JSON.stringify(options.secretConfig),
				sealError,
			))
		const now = 0
		yield* database.execute((db) =>
			db.run(
				PG.insertInto(AlertDestinations).values({
					id: options.id,
					orgId: ORG,
					name: `destination-${options.type}-${options.id}`,
					type: options.type,
					enabled: true,
					// Stored as an object, exactly as AlertsService writes it.
					configJson: options.publicConfig,
					secretCiphertext: encrypted.ciphertext,
					secretIv: encrypted.iv,
					secretTag: encrypted.tag,
					createdAt: now,
					updatedAt: now,
					createdBy: "test",
					updatedBy: "test",
				}),
			),
		)
	})

const loadDestination = (id: AlertDestinationId) =>
	Effect.gen(function* () {
		const database = yield* Database
		const rows = yield* database.execute((db) =>
			db.run(
				PG.from(AlertDestinations)
					.select()
					.where(($) => [$.id.eq(id)]),
			),
		)
		const row = rows[0]
		assert.isDefined(row)
		return row
	})

describe("hydrateDestinationRow", () => {
	it.effect("hydrates a webhook destination read back from the database", () => {
		const testDb = createTestDb(createdDbs)
		const id = asDestinationId("00000000-0000-4000-8000-000000000001")
		const secretConfig: DestinationSecretConfig = {
			type: "webhook",
			url: "https://hooks.example.com/maple",
			signingSecret: "s3cret",
		}
		return Effect.gen(function* () {
			yield* seedDestination({
				id,
				type: "webhook",
				publicConfig: { summary: "POST hooks.example.com", channelLabel: null },
				secretConfig,
			})
			const row = yield* loadDestination(id)

			// The defect this test exists for: jsonb comes back parsed.
			assert.notTypeOf(row.configJson, "string")

			const hydrated = yield* hydrateDestinationRow(row, yield* makeKeyring, hydrationErrors)
			assert.deepStrictEqual(hydrated.publicConfig, {
				summary: "POST hooks.example.com",
				channelLabel: null,
			})
			assert.deepStrictEqual(hydrated.secretConfig, secretConfig)
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("round-trips a telegram destination without leaking the token into config_json", () => {
		const testDb = createTestDb(createdDbs)
		const id = asDestinationId("00000000-0000-4000-8000-000000000009")
		const secretConfig: DestinationSecretConfig = {
			type: "telegram",
			botToken: "123456789:AAHqwertyuiopasdfghjklzxcvbnm123456",
			chatId: "-1001234567890",
		}
		return Effect.gen(function* () {
			yield* seedDestination({
				id,
				type: "telegram",
				publicConfig: { summary: "Chat -1001234567890", channelLabel: "-1001234567890" },
				secretConfig,
			})
			const row = yield* loadDestination(id)

			// `config_json` is Electric-synced to the browser, so the bot token may
			// exist only inside the encrypted blob.
			assert.notInclude(JSON.stringify(row.configJson), "AAHqwerty")

			const hydrated = yield* hydrateDestinationRow(row, yield* makeKeyring, hydrationErrors)
			assert.deepStrictEqual(hydrated.secretConfig, secretConfig)
			assert.strictEqual(hydrated.publicConfig.channelLabel, "-1001234567890")
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("hydrates a chat destination carrying optional public config keys", () => {
		const testDb = createTestDb(createdDbs)
		const id = asDestinationId("00000000-0000-4000-8000-000000000002")
		const workspaceId = Schema.decodeSync(ChatWorkspaceId)("11111111-1111-4111-8111-111111111111")
		const secretConfig: DestinationSecretConfig = {
			type: "chat",
			workspaceId,
			channelId: "C123",
			channelName: "alerts",
		}
		return Effect.gen(function* () {
			yield* seedDestination({
				id,
				type: "chat",
				publicConfig: {
					summary: "Acme",
					channelLabel: "#alerts",
					chatConnector: "testchat",
					chatWorkspaceId: workspaceId,
				},
				secretConfig,
			})
			const row = yield* loadDestination(id)

			const hydrated = yield* hydrateDestinationRow(row, yield* makeKeyring, hydrationErrors)
			assert.deepStrictEqual(hydrated.publicConfig, {
				summary: "Acme",
				channelLabel: "#alerts",
				chatConnector: "testchat",
				chatWorkspaceId: workspaceId,
			})
			assert.deepStrictEqual(hydrated.secretConfig, secretConfig)
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("fails with onPublicConfigInvalid when the stored config is genuinely malformed", () => {
		const testDb = createTestDb(createdDbs)
		const id = asDestinationId("00000000-0000-4000-8000-000000000003")
		return Effect.gen(function* () {
			yield* seedDestination({
				id,
				type: "webhook",
				// `summary` is required by DestinationPublicConfigSchema.
				publicConfig: { channelLabel: null },
				secretConfig: {
					type: "webhook",
					url: "https://hooks.example.com/maple",
					signingSecret: null,
				},
			})
			const row = yield* loadDestination(id)

			const error = yield* Effect.flip(hydrateDestinationRow(row, yield* makeKeyring, hydrationErrors))
			assert.strictEqual(error, "public_config_invalid")
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("opens a row-bound secret on its own row and refuses it on another row", () => {
		const testDb = createTestDb(createdDbs)
		const ownId = asDestinationId("00000000-0000-4000-8000-000000000004")
		const otherId = asDestinationId("00000000-0000-4000-8000-000000000005")
		const secretConfig: DestinationSecretConfig = {
			type: "discord",
			webhookUrl: "https://discord.example.com/api/webhooks/1/abc",
		}
		const publicConfig = { summary: "Discord", channelLabel: null }
		return Effect.gen(function* () {
			const keyring = yield* makeKeyring
			const storedSecret = yield* sealSecret(
				keyring,
				alertDestinationSecretSlot,
				{ orgId: ORG, id: ownId },
				JSON.stringify(secretConfig),
				sealError,
			)
			yield* seedDestination({ id: ownId, type: "discord", publicConfig, secretConfig, storedSecret })
			yield* seedDestination({ id: otherId, type: "discord", publicConfig, secretConfig, storedSecret })

			const hydrated = yield* hydrateDestinationRow(
				yield* loadDestination(ownId),
				keyring,
				hydrationErrors,
			)
			assert.deepStrictEqual(hydrated.secretConfig, secretConfig)

			const error = yield* Effect.flip(
				hydrateDestinationRow(yield* loadDestination(otherId), keyring, hydrationErrors),
			)
			assert.strictEqual(error, "decrypt_failure")
		}).pipe(Effect.provide(testDb.layer))
	})
})
