// index.html's first module script: its small graph runs while `entry.ts`'s bundle is still
// downloading and evaluating. The OAuth return still leaves the URL before anything reads it.
import "./platform/oauth-return-boot"
import { startClerkBoot } from "./platform/clerk-boot"

startClerkBoot()
// Not a static import: the page loaders carry every page's preload list, Clerk's start won't wait for it.
void import("./page/code").then(({ startRoutePageCode }) => startRoutePageCode(location.pathname))
