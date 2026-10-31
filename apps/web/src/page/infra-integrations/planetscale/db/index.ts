import { definePage } from "../../../contract"
import { Message } from "./model"
import { Model } from "./model"
import { pageCode } from "../../../code"

/** `/infra/planetscale/$dbName`: one database's branches; a new database is a new instance. */
export const entry = definePage(
	"InfraPlanetscaleDatabase",
	{ Model, Message },
	{ routes: ["InfraPlanetscaleDatabase"], key: (route) => `InfraPlanetscaleDatabase:${route.dbName}` },
)

export const page = entry.lazy(pageCode.InfraPlanetscaleDatabase)
