import { accessCatalogOf, type CatalogApi, type EndpointAccessEntry } from "./access-catalog"
import { MapleAiApi } from "./ai-api"
import { MapleApi } from "./api"
import { MapleInternalApi } from "./internal-api"
import { MapleApiV2 } from "./v2/api"

/** Maple's own APIs: the dashboard's, the public `/v2` and the AI app's. */
export const mapleApis: ReadonlyArray<CatalogApi> = [MapleApi, MapleInternalApi, MapleApiV2, MapleAiApi]

/** Every gated endpoint of Maple's APIs with what it asks. Its own subpath: it imports every API. */
export const accessCatalog = (): ReadonlyArray<EndpointAccessEntry> => accessCatalogOf(mapleApis)
