/**
 * Where every sealed secret lives, for the job that brings stored values onto the current key
 * and envelope (`SecretResealService`). A column that was never resealed stops opening once its
 * old key is retired, so `RESEAL_TARGETS` has to name every slot: a missing one does not compile.
 */
import * as Orm from "@maple-dev/effect-orm/database"
import type { MapleDb, MapleDbError } from "@maple/db/client"
import {
	AlertDestinations,
	AwsConnections,
	ChatWorkspaces,
	CliDeviceAuthorizations,
	CostConnections,
	DashboardShares,
	ExternalDataSources,
	GcpConnectors,
	OAuthConnections,
	OrgClickHouseSettings,
	OrgIngestKeys,
	OpenRouterCostConnections,
	FleetConnections,
	OrgOpenRouterKeys,
	PlanetscaleConnections,
	PlanetscaleDatabases,
	RailwayConnections,
	ScrapeTargets,
	UptimeMonitors,
	VercelConnections,
} from "@maple/db/tables"
import { DataSourceConfig } from "@maple/domain/data-sources"
import { StoredUptimeMonitorConfig } from "@maple/domain/uptime"
import { Array as Arr, Effect, Schema } from "effect"
import type { EncryptedValue } from "@maple/backend/platform/Crypto"
import {
	currentEnvelopePrefixes,
	openSecret,
	sealSecret,
	type SecretKeyring,
	type SecretSlot,
} from "@maple/backend/platform/SecretBox"
import * as slots from "@maple/backend/platform/secret-slots"

export class SecretResealError extends Schema.TaggedError<SecretResealError>()(
	"@maple/backend/services/SecretResealError",
	{
		message: Schema.String,
		cause: Schema.optionalKey(Schema.String),
	},
) {}

const resealError = (message: string) => new SecretResealError({ message })

/** A stored value that is not sealed by the current key and envelope. */
export interface PendingSecret {
	/** The row's identity columns, in the target's order: the page cursor and the log label. */
	readonly keys: ReadonlyArray<string>
	/** Opens the stored value and seals it again under the current key and envelope. */
	readonly reseal: (keyring: SecretKeyring) => Effect.Effect<EncryptedValue, SecretResealError>
	/** Writes only if the row still holds the value that was read; false when it moved on. */
	readonly write: (db: MapleDb, sealed: EncryptedValue) => Effect.Effect<boolean, MapleDbError>
}

export interface ResealTarget {
	readonly slotName: string
	/** What a value sealed by the primary key in a current envelope of this slot starts with. */
	readonly currentPrefixes: (keyring: SecretKeyring) => ReadonlyArray<string>
	/** The next `limit` pending rows after `cursor`, in identity order. */
	readonly pending: (
		db: MapleDb,
		prefixes: ReadonlyArray<string>,
		cursor: ReadonlyArray<string> | null,
		limit: number,
	) => Effect.Effect<ReadonlyArray<PendingSecret>, MapleDbError>
	readonly countPending: (
		db: MapleDb,
		prefixes: ReadonlyArray<string>,
	) => Effect.Effect<number, MapleDbError>
}

interface TableLike {
	readonly name: string
	readonly columns: Readonly<Record<string, { readonly sqlName?: string }>>
}

const sqlColumn = <T extends TableLike>(table: T, key: keyof T["columns"] & string) =>
	Orm.sql.identifier(table.columns[key]?.sqlName ?? key)

const One = Schema.Tuple([Schema.String])
const Two = Schema.Tuple([Schema.String, Schema.String])
const Three = Schema.Tuple([Schema.String, Schema.String, Schema.String])

const PendingCountRow = Schema.Struct({ pending: Schema.NumberFromString })
const WrittenRow = Schema.Struct({ written: Schema.Number })

interface TripleTargetConfig<T extends TableLike, Keys extends ReadonlyArray<string>, Ref, Context> {
	readonly slot: SecretSlot<Ref>
	readonly table: T
	readonly columns: {
		readonly ciphertext: keyof T["columns"] & string
		readonly iv: keyof T["columns"] & string
		readonly tag: keyof T["columns"] & string
	}
	/** Columns that identify one row and carry everything the slot's ref needs. */
	readonly identity: ReadonlyArray<keyof T["columns"] & string>
	readonly keys: Schema.Codec<Keys, ReadonlyArray<string>>
	/** Other columns the ref needs (where the value is sent), decoded from a JSON array of them. */
	readonly context: {
		readonly columns: ReadonlyArray<keyof T["columns"] & string>
		readonly schema: Schema.Codec<Context, unknown>
	}
	readonly ref: (keys: Keys, context: Context) => Ref
}

const NO_CONTEXT = { columns: [], schema: Schema.Null }

/** A slot whose ref is the row's identity alone. */
const tripleTarget = <T extends TableLike, Keys extends ReadonlyArray<string>, Ref>(
	config: Omit<TripleTargetConfig<T, Keys, Ref, null>, "context" | "ref"> & {
		readonly ref: (keys: Keys) => Ref
	},
): ResealTarget => tripleTargetWithContext({ ...config, context: NO_CONTEXT })

const tripleTargetWithContext = <T extends TableLike, Keys extends ReadonlyArray<string>, Ref, Context>(
	config: TripleTargetConfig<T, Keys, Ref, Context>,
): ResealTarget => {
	const table = Orm.sql.identifier(config.table.name)
	const ciphertext = sqlColumn(config.table, config.columns.ciphertext)
	const iv = sqlColumn(config.table, config.columns.iv)
	const tag = sqlColumn(config.table, config.columns.tag)
	const identity = Arr.map(config.identity, (key) => sqlColumn(config.table, key))
	const identityList = Orm.sql.join(identity)
	const contextList = Arr.isReadonlyArrayNonEmpty(config.context.columns)
		? Orm.sql`jsonb_build_array(${Orm.sql.join(
				Arr.map(config.context.columns, (key) => sqlColumn(config.table, key)),
			)})::text`
		: Orm.sql`'null'`
	const PendingRow = Schema.Struct({
		keys: Schema.fromJsonString(config.keys),
		// Decoded per row in `reseal`: one row that no longer decodes fails alone, not the page.
		context: Schema.String,
		ciphertext: Schema.String,
		iv: Schema.String,
		tag: Schema.String,
	})
	const decodeContext = Schema.decodeEffect(Schema.fromJsonString(config.context.schema))
	const isPending = (prefixes: ReadonlyArray<string>) =>
		Orm.sql`${ciphertext} is not null and ${iv} is not null and ${tag} is not null${Orm.sql.join(
			Arr.map(prefixes, (prefix) => Orm.sql` and not starts_with(${ciphertext}, ${prefix})`),
			Orm.sql.empty,
		)}`

	const toPending = (row: typeof PendingRow.Type): PendingSecret => {
		const stored = { ciphertext: row.ciphertext, iv: row.iv, tag: row.tag }
		return {
			keys: row.keys,
			reseal: (keyring) =>
				decodeContext(row.context).pipe(
					Effect.mapBoth({
						onFailure: () => resealError("The row's stored destination does not decode"),
						onSuccess: (context) => config.ref(row.keys, context),
					}),
					Effect.flatMap((ref) =>
						openSecret(keyring, config.slot, ref, stored, resealError).pipe(
							Effect.flatMap((plaintext) =>
								sealSecret(keyring, config.slot, ref, plaintext, resealError),
							),
						),
					),
				),
			write: (db, sealed) =>
				db
					.query(
						Orm.sql`
							update ${table}
							set ${ciphertext} = ${sealed.ciphertext}, ${iv} = ${sealed.iv}, ${tag} = ${sealed.tag}
							where (${identityList}) = (${Orm.sql.join(row.keys)})
								and ${ciphertext} = ${stored.ciphertext}
							returning 1 as written`,
						WrittenRow,
					)
					.pipe(Effect.map((rows) => rows.length > 0)),
		}
	}

	return {
		slotName: config.slot.name,
		currentPrefixes: (keyring) => currentEnvelopePrefixes(keyring, config.slot),
		pending: (db, prefixes, cursor, limit) =>
			db
				.query(
					Orm.sql`
						select jsonb_build_array(${identityList})::text as keys, ${contextList} as context,
							${ciphertext} as ciphertext, ${iv} as iv, ${tag} as tag
						from ${table}
						where ${isPending(prefixes)}${
							cursor === null
								? Orm.sql.empty
								: Orm.sql` and (${identityList}) > (${Orm.sql.join(cursor)})`
						}
						order by ${identityList}
						limit ${limit}`,
					PendingRow,
				)
				.pipe(Effect.map(Arr.map(toPending))),
		countPending: (db, prefixes) =>
			db
				.query(
					Orm.sql`select count(*)::text as pending from ${table} where ${isPending(prefixes)}`,
					PendingCountRow,
				)
				.pipe(Effect.map((rows) => rows[0]?.pending ?? 0)),
	}
}

const orgRow = ([orgId, id]: typeof Two.Type) => ({ orgId, id })
const org = ([orgId]: typeof One.Type) => ({ orgId })
const oauth = ([orgId, provider]: typeof Two.Type) => ({ orgId, provider })

export const RESEAL_TARGETS = {
	alertDestinationSecretSlot: tripleTarget({
		slot: slots.alertDestinationSecretSlot,
		table: AlertDestinations,
		columns: { ciphertext: "secretCiphertext", iv: "secretIv", tag: "secretTag" },
		identity: ["orgId", "id"],
		keys: Two,
		ref: orgRow,
	}),
	awsStreamSecretSlot: tripleTarget({
		slot: slots.awsStreamSecretSlot,
		table: AwsConnections,
		columns: { ciphertext: "streamSecretCiphertext", iv: "streamSecretIv", tag: "streamSecretTag" },
		identity: ["orgId", "id"],
		keys: Two,
		ref: orgRow,
	}),
	chatWorkspaceCredentialsSlot: tripleTarget({
		slot: slots.chatWorkspaceCredentialsSlot,
		table: ChatWorkspaces,
		columns: { ciphertext: "credentialsCiphertext", iv: "credentialsIv", tag: "credentialsTag" },
		identity: ["orgId", "connector", "externalWorkspaceId"],
		keys: Three,
		ref: ([orgId, connector, externalWorkspaceId]) => ({ orgId, connector, externalWorkspaceId }),
	}),
	cliDeviceTokenSlot: tripleTarget({
		slot: slots.cliDeviceTokenSlot,
		table: CliDeviceAuthorizations,
		columns: { ciphertext: "tokenCiphertext", iv: "tokenIv", tag: "tokenTag" },
		identity: ["deviceCodeHash"],
		keys: One,
		ref: ([deviceCodeHash]) => ({ deviceCodeHash }),
	}),
	dashboardShareTokenSlot: tripleTarget({
		slot: slots.dashboardShareTokenSlot,
		table: DashboardShares,
		columns: { ciphertext: "tokenCiphertext", iv: "tokenIv", tag: "tokenTag" },
		identity: ["orgId", "id"],
		keys: Two,
		ref: orgRow,
	}),
	externalDataSourceSecretSlot: tripleTargetWithContext({
		slot: slots.externalDataSourceSecretSlot,
		table: ExternalDataSources,
		columns: { ciphertext: "secretCiphertext", iv: "secretIv", tag: "secretTag" },
		identity: ["orgId", "id"],
		keys: Two,
		context: { columns: ["config"], schema: Schema.Tuple([DataSourceConfig]) },
		ref: ([orgId, id], [config]) => ({ orgId, id, config }),
	}),
	gcpConnectorSecretSlot: tripleTarget({
		slot: slots.gcpConnectorSecretSlot,
		table: GcpConnectors,
		columns: { ciphertext: "secretCiphertext", iv: "secretIv", tag: "secretTag" },
		identity: ["orgId", "id"],
		keys: Two,
		ref: orgRow,
	}),
	oauthAccessTokenSlot: tripleTarget({
		slot: slots.oauthAccessTokenSlot,
		table: OAuthConnections,
		columns: { ciphertext: "accessTokenCiphertext", iv: "accessTokenIv", tag: "accessTokenTag" },
		identity: ["orgId", "provider"],
		keys: Two,
		ref: oauth,
	}),
	oauthRefreshTokenSlot: tripleTarget({
		slot: slots.oauthRefreshTokenSlot,
		table: OAuthConnections,
		columns: { ciphertext: "refreshTokenCiphertext", iv: "refreshTokenIv", tag: "refreshTokenTag" },
		identity: ["orgId", "provider"],
		keys: Two,
		ref: oauth,
	}),
	clickHousePasswordSlot: tripleTargetWithContext({
		slot: slots.clickHousePasswordSlot,
		table: OrgClickHouseSettings,
		columns: { ciphertext: "chPasswordCiphertext", iv: "chPasswordIv", tag: "chPasswordTag" },
		identity: ["orgId"],
		keys: One,
		context: { columns: ["chUrl"], schema: One },
		ref: ([orgId], [chUrl]) => ({ orgId, chUrl }),
	}),
	ingestPrivateKeySlot: tripleTarget({
		slot: slots.ingestPrivateKeySlot,
		table: OrgIngestKeys,
		columns: { ciphertext: "privateKeyCiphertext", iv: "privateKeyIv", tag: "privateKeyTag" },
		identity: ["orgId"],
		keys: One,
		ref: org,
	}),
	fleetTokenSlot: tripleTargetWithContext({
		slot: slots.fleetTokenSlot,
		table: FleetConnections,
		columns: { ciphertext: "tokenCiphertext", iv: "tokenIv", tag: "tokenTag" },
		identity: ["orgId"],
		keys: One,
		context: { columns: ["baseUrl"], schema: One },
		ref: ([orgId], [baseUrl]) => ({ orgId, baseUrl }),
	}),
	openRouterKeySlot: tripleTarget({
		slot: slots.openRouterKeySlot,
		table: OrgOpenRouterKeys,
		columns: { ciphertext: "keyCiphertext", iv: "keyIv", tag: "keyTag" },
		identity: ["orgId"],
		keys: One,
		ref: org,
	}),
	openRouterCostKeySlot: tripleTarget({
		slot: slots.openRouterCostKeySlot,
		table: OpenRouterCostConnections,
		columns: { ciphertext: "keyCiphertext", iv: "keyIv", tag: "keyTag" },
		identity: ["orgId"],
		keys: One,
		ref: org,
	}),
	costConnectionSecretSlot: tripleTarget({
		slot: slots.costConnectionSecretSlot,
		table: CostConnections,
		columns: { ciphertext: "secretCiphertext", iv: "secretIv", tag: "secretTag" },
		identity: ["orgId", "provider"],
		keys: Two,
		ref: ([orgId, provider]) => ({ orgId, provider }),
	}),
	planetScaleWebhookSecretSlot: tripleTarget({
		slot: slots.planetScaleWebhookSecretSlot,
		table: PlanetscaleConnections,
		columns: { ciphertext: "webhookSecretCiphertext", iv: "webhookSecretIv", tag: "webhookSecretTag" },
		identity: ["orgId", "id"],
		keys: Two,
		ref: orgRow,
	}),
	planetScaleDatabaseWebhookSecretSlot: tripleTarget({
		slot: slots.planetScaleDatabaseWebhookSecretSlot,
		table: PlanetscaleDatabases,
		columns: { ciphertext: "webhookSecretCiphertext", iv: "webhookSecretIv", tag: "webhookSecretTag" },
		identity: ["orgId", "id"],
		keys: Two,
		ref: orgRow,
	}),
	railwayTokenSlot: tripleTarget({
		slot: slots.railwayTokenSlot,
		table: RailwayConnections,
		columns: { ciphertext: "tokenCiphertext", iv: "tokenIv", tag: "tokenTag" },
		identity: ["orgId"],
		keys: One,
		ref: org,
	}),
	scrapeTargetCredentialsSlot: tripleTargetWithContext({
		slot: slots.scrapeTargetCredentialsSlot,
		table: ScrapeTargets,
		columns: {
			ciphertext: "authCredentialsCiphertext",
			iv: "authCredentialsIv",
			tag: "authCredentialsTag",
		},
		identity: ["orgId", "id"],
		keys: Two,
		context: { columns: ["url"], schema: One },
		ref: ([orgId, id], [url]) => ({ orgId, id, url }),
	}),
	uptimeMonitorHeadersSlot: tripleTargetWithContext({
		slot: slots.uptimeMonitorHeadersSlot,
		table: UptimeMonitors,
		columns: { ciphertext: "headersCiphertext", iv: "headersIv", tag: "headersTag" },
		identity: ["orgId", "id"],
		keys: Two,
		context: { columns: ["configJson"], schema: Schema.Tuple([StoredUptimeMonitorConfig]) },
		ref: ([orgId, id], [config]) => ({ orgId, id, config }),
	}),
	vercelTokenSlot: tripleTarget({
		slot: slots.vercelTokenSlot,
		table: VercelConnections,
		columns: { ciphertext: "tokenCiphertext", iv: "tokenIv", tag: "tokenTag" },
		identity: ["orgId"],
		keys: One,
		ref: org,
	}),
} satisfies Record<keyof typeof slots, ResealTarget>
