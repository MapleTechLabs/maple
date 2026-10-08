/**
 * `/SKILL.md`: the `maple-onboard` skill, served as-is so one pasted line
 * ("Add Maple to my app: maple.dev/SKILL.md") is the whole agent setup. No
 * install step; companion skills are fetched on demand by the skill itself.
 */
import type { APIRoute } from "astro"
import skill from "../../../../skills/maple-onboard/SKILL.md?raw"
import { markdown } from "../lib/page-markdown"

export const GET: APIRoute = () => markdown(skill)
