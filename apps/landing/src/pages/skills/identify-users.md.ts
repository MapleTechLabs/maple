/**
 * `/skills/identify-users.md`: the `maple-identify-users` skill, served as-is so the Users page's
 * one pasted line ("Identify the signed-in users ...: maple.dev/skills/identify-users.md") is the
 * whole agent task.
 */
import type { APIRoute } from "astro"
import skill from "../../../../../skills/maple-identify-users/SKILL.md?raw"
import { markdown } from "../../lib/page-markdown"

export const GET: APIRoute = () => markdown(skill)
