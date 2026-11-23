import EffectLogomark from "../components/icons/EffectLogomark.astro"
import GymscoreLogo from "../components/icons/GymscoreLogo.astro"
import JobflowLogo from "../components/icons/JobflowLogo.astro"
import SakuraLogo from "../components/icons/SakuraLogo.astro"
import SuperwallLogo from "../components/icons/SuperwallLogo.astro"

/**
 * `logos` entry id (filename) → brand mark. Add a customer by dropping a
 * src/content/logos/<id>.md file and registering its logo component here.
 * Shared by the logo band and the customer stories.
 */
export const LOGOS: Record<string, typeof SuperwallLogo> = {
	sakura: SakuraLogo,
	gymscore: GymscoreLogo,
	superwall: SuperwallLogo,
	effect: EffectLogomark,
	jobflow: JobflowLogo,
} satisfies Record<string, typeof SuperwallLogo>
