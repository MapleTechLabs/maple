/// <reference types="@types/bun" />
import { render } from "@react-email/components"
import { baseDigestProps } from "./emails/_sample"
import { WeeklyDigest } from "./weekly-digest"

const html = await render(WeeklyDigest(baseDigestProps))

const path = "/tmp/maple-digest-preview.html"
await Bun.write(path, html)
console.log(`Rendered ${html.length} chars -> ${path}`)
