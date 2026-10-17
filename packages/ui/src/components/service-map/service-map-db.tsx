import {
	ClickhouseIcon,
	CloudflareBrandIcon,
	DatabaseIcon,
	FireIcon,
	type IconComponent,
	MagnifierIcon,
	MongodbIcon,
	MysqlIcon,
	PaperPlaneIcon,
	PlanetScaleIcon,
	PostgresIcon,
	RedisIcon,
} from "../icons"

import { POSTGRES_MARK_PATH } from "../icons/postgres"
import { MYSQL_MARK_PATH } from "../icons/mysql"
import { REDIS_MARK_PATH } from "../icons/redis"
import { CLICKHOUSE_MARK_PATH } from "../icons/clickhouse"
import { MONGODB_MARK_PATH } from "../icons/mongodb"
import {
	type DbIconKey,
	type DbNodeStyle,
	type DbStyle,
	getDbStyle,
	resolveDbNodeStyle,
	resolvePlanetScaleDbStyle,
} from "./service-map-db-style"

export {
	CLOUDFLARE_COLOR,
	getDbNodeColor,
	PLANETSCALE_COLOR,
	withAlpha,
} from "./service-map-db-style"

// The colors, labels and categories live in `service-map-db-style.ts`; this module
// resolves their icon keys to React icon components and 3D mark artwork.

const ICONS = {
	postgres: PostgresIcon,
	mysql: MysqlIcon,
	clickhouse: ClickhouseIcon,
	mongodb: MongodbIcon,
	redis: RedisIcon,
	database: DatabaseIcon,
	fire: FireIcon,
	"paper-plane": PaperPlaneIcon,
	magnifier: MagnifierIcon,
	cloudflare: CloudflareBrandIcon,
	planetscale: PlanetScaleIcon,
} satisfies Record<DbIconKey, IconComponent>

const MARK_PATHS = new Map<DbIconKey, string>([
	["postgres", POSTGRES_MARK_PATH],
	["mysql", MYSQL_MARK_PATH],
	["clickhouse", CLICKHOUSE_MARK_PATH],
	["mongodb", MONGODB_MARK_PATH],
	["redis", REDIS_MARK_PATH],
])

export interface DbDescriptor extends Omit<DbStyle, "icon"> {
	/** Branded icon when the system is recognised, otherwise a generic category icon. */
	Icon: IconComponent
	/** Shared SVG artwork for marks on 3D machines; absent for category fallbacks. */
	markPath?: string
}

/** {@link getDbStyle} with the icon component and 3D mark resolved. */
export function getDbDescriptor(system: string | undefined): DbDescriptor {
	const { icon, ...style } = getDbStyle(system)
	const markPath = MARK_PATHS.get(icon)
	return markPath === undefined ? { ...style, Icon: ICONS[icon] } : { ...style, Icon: ICONS[icon], markPath }
}

/** Everything a DB node / detail-panel header needs to render, brand included. */
export interface DbNodePresentation extends Omit<DbNodeStyle, "icon"> {
	Icon: IconComponent
}

const withIcon = ({ icon, ...style }: DbNodeStyle): DbNodePresentation => ({ ...style, Icon: ICONS[icon] })

/** {@link resolveDbNodeStyle} with the icon component resolved. */
export function resolveDbNodePresentation(
	dbSystem: string | undefined,
	dbNamespace: string | undefined,
): DbNodePresentation {
	return withIcon(resolveDbNodeStyle(dbSystem, dbNamespace))
}

/** {@link resolvePlanetScaleDbStyle} with the PlanetScale mark resolved. */
export function resolvePlanetScaleDbPresentation(
	dbSystem: string | undefined,
	dbNamespace: string | undefined,
	kind: string | undefined,
): DbNodePresentation {
	return withIcon(resolvePlanetScaleDbStyle(dbSystem, dbNamespace, kind))
}
