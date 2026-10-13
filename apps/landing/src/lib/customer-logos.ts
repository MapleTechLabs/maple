import EffectLogomark from "../components/icons/EffectLogomark.astro"
import GymscoreLogo from "../components/icons/GymscoreLogo.astro"
import HazelLogo from "../components/icons/HazelLogo.astro"
import SakuraLogo from "../components/icons/SakuraLogo.astro"
import SuperwallLogo from "../components/icons/SuperwallLogo.astro"

/**
 * `logos` entry id (filename) → brand mark. Add a customer by dropping a
 * src/content/logos/<id>.md file and registering its logo component here.
 * Shared by the logo band and the customer stories.
 */
export const LOGOS: Record<string, typeof HazelLogo> = {
	hazel: HazelLogo,
	sakura: SakuraLogo,
	gymscore: GymscoreLogo,
	superwall: SuperwallLogo,
	effect: EffectLogomark,
} satisfies Record<string, typeof HazelLogo>
