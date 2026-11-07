import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Array as Arr, Option, Result, Schema, SchemaGetter } from "effect"
import { IsoDateTimeString, UserId } from "../primitives"
import { SessionAuthorization } from "./current-tenant"

// The org's 3D service map as a world the team builds: one row per entity, each with its own
// revision, so teammates editing different buildings never clobber each other. New entity kinds
// join the `WorldEntity` union; stored rows of an unknown kind are skipped, never fatal.

export const WORLD_SCHEMA_VERSION = 1
export const WORLD_OPS_MAX = 500
/** A world is a few hundred services; the cap keeps a runaway client from filling the table. */
export const WORLD_ENTITIES_MAX = 5000
const COORDINATE_LIMIT = 10_000

/** `svc:<nodeId>` for a service's building; later kinds take their own prefix (`dec:`, `road:`). */
export const WorldEntityId = Schema.String.check(
	Schema.isMinLength(5),
	Schema.isMaxLength(300),
	Schema.isPattern(/^[a-z]+:.+$/u),
).pipe(Schema.brand("@maple/WorldEntityId"))
export type WorldEntityId = typeof WorldEntityId.Type

/** A grid cell; scene units are `cell * CELL_SIZE` in the web world core. */
export const WorldCell = Schema.Struct({
	x: Schema.Number.check(
		Schema.isInt(),
		Schema.isBetween({ minimum: -COORDINATE_LIMIT, maximum: COORDINATE_LIMIT }),
	),
	z: Schema.Number.check(
		Schema.isInt(),
		Schema.isBetween({ minimum: -COORDINATE_LIMIT, maximum: COORDINATE_LIMIT }),
	),
})
export type WorldCell = typeof WorldCell.Type

export const WorldRotation = Schema.Literals([0, 90, 180, 270])
export type WorldRotation = typeof WorldRotation.Type

/** The building models the 3D map can draw (`MachineKind`). */
export const BuildingType = Schema.Literals(["processor", "tank", "loader", "gateway", "shed"])
export type BuildingType = typeof BuildingType.Type

/** A service, database, queue or external node placed by hand. `building: null` keeps the
 * type the node's kind implies. */
export const ServiceBuilding = Schema.TaggedStruct("ServiceBuilding", {
	nodeId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
	cell: WorldCell,
	rotation: WorldRotation,
	building: Schema.NullOr(BuildingType),
})
export type ServiceBuilding = typeof ServiceBuilding.Type

export const WorldEntity = Schema.Union([ServiceBuilding])
export type WorldEntity = typeof WorldEntity.Type

export const serviceBuildingId = (nodeId: string): WorldEntityId => WorldEntityId.make(`svc:${nodeId}`)

/** The one id an entity may be stored under; a Put under any other id is rejected. Kinds placed
 * freely (decorations, roads) will check their id's prefix here instead of deriving it. */
export const entityIdOf = (entity: WorldEntity): WorldEntityId => {
	switch (entity._tag) {
		case "ServiceBuilding":
			return serviceBuildingId(entity.nodeId)
	}
}

export const WorldRevision = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))

export class WorldEntityRecord extends Schema.Class<WorldEntityRecord>("WorldEntityRecord")({
	id: WorldEntityId,
	entity: WorldEntity,
	revision: WorldRevision,
	updatedAt: IsoDateTimeString,
	updatedBy: Schema.NullOr(UserId),
}) {}

/** `expectedRevision`: the live revision the client last saw, `null` for "nothing is there yet".
 * A mismatch fails the whole batch with `WorldConflictError`; nothing is ever overwritten blind. */
export const WorldPut = Schema.TaggedStruct("Put", {
	id: WorldEntityId,
	entity: WorldEntity,
	expectedRevision: Schema.NullOr(WorldRevision),
})
export const WorldRemove = Schema.TaggedStruct("Remove", {
	id: WorldEntityId,
	expectedRevision: Schema.NullOr(WorldRevision),
})
export const WorldOp = Schema.Union([WorldPut, WorldRemove])

const decodeRecord = Schema.decodeUnknownOption(WorldEntityRecord)
const encodeRecord = Schema.encodeSync(WorldEntityRecord)

/** Records as a newer server may send them: a kind this build does not know is skipped, so a
 * tab on an older bundle still loads the rest of the world. */
const WorldEntityRecords = Schema.Array(Schema.Unknown).pipe(
	Schema.decodeTo(Schema.Array(WorldEntityRecord), {
		// The getters see the encoded records: keep the ones this build can decode.
		decode: SchemaGetter.transform((raw: ReadonlyArray<unknown>) =>
			Arr.filterMap(raw, (item) =>
				Result.fromOption(Option.map(decodeRecord(item), encodeRecord), () => undefined),
			),
		),
		encode: SchemaGetter.transform((records: ReadonlyArray<unknown>) => records),
	}),
)
export type WorldOp = typeof WorldOp.Type

export class WorldDocument extends Schema.Class<WorldDocument>("WorldDocument")({
	schemaVersion: Schema.Number,
	entities: WorldEntityRecords,
}) {}

export class ApplyWorldOpsRequest extends Schema.Class<ApplyWorldOpsRequest>("ApplyWorldOpsRequest")({
	ops: Schema.Array(WorldOp).check(Schema.isMinLength(1), Schema.isMaxLength(WORLD_OPS_MAX)),
}) {}

export class ApplyWorldOpsResponse extends Schema.Class<ApplyWorldOpsResponse>("ApplyWorldOpsResponse")({
	/** The rows as stored after the batch, for every `Put`. */
	put: WorldEntityRecords,
	removed: Schema.Array(WorldEntityId),
}) {}

export class WorldPersistenceError extends Schema.TaggedError<WorldPersistenceError>()(
	"@maple/http/service-map-world/WorldPersistenceError",
	{ message: Schema.String, cause: Schema.optionalKey(Schema.String) },
	{ httpApiStatus: 503 },
) {}

/** Some `expectedRevision` did not match: `current` is what is stored now (absent = no row). */
export class WorldConflictError extends Schema.TaggedError<WorldConflictError>()(
	"@maple/http/service-map-world/WorldConflictError",
	{ message: Schema.String, ids: Schema.Array(WorldEntityId), current: WorldEntityRecords },
	{ httpApiStatus: 409 },
) {}

/** The batch would push the org past `WORLD_ENTITIES_MAX`, or repeats an id. */
export class WorldInvalidOpsError extends Schema.TaggedError<WorldInvalidOpsError>()(
	"@maple/http/service-map-world/WorldInvalidOpsError",
	{ message: Schema.String },
	{ httpApiStatus: 400 },
) {}

export class ServiceMapWorldApiGroup extends HttpApiGroup.make("serviceMapWorld")
	.add(
		HttpApiEndpoint.get("get", "/", {
			success: WorldDocument,
			error: WorldPersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.post("apply", "/ops", {
			payload: ApplyWorldOpsRequest,
			success: ApplyWorldOpsResponse,
			error: [WorldPersistenceError, WorldConflictError, WorldInvalidOpsError],
		}),
	)
	.prefix("/internal/service-map/world")
	.middleware(SessionAuthorization) {}
