# Ultrawide hero

Originally generated using built-in imagegen from `maple-rome-balanced.webp`. Used above 1800px as a continuous full-width scene, preserving proportions with object-fit cover.

Restored with the imagegen CLI (`gpt-image-2`, high quality, explicit `3840x1280` size) from the original panorama and `maple-rome-balanced.webp` as the texture reference. Verified output dimensions: 3840 × 1280 (previously 2172 × 724). Exported to `maple-rome-ultrawide.webp` with `cwebp -q 95 -m 6` to preserve fine engraving detail. Full-resolution source: `output/imagegen/maple-rome-ultrawide-4k.png`.

## Resolution restoration prompt

Use case: precise-object-edit. Image 1 is the edit target: preserve its exact 3:1 panorama composition, temple position and scale, aqueduct route, landscape, framing and amber/charcoal palette. Image 2 is a texture reference only: match its crisp fine dithered engraving, sharp stone edges and resolved architectural details. Restore image 1 at native 3840x1280 with genuinely detailed engraving throughout. Preserve the scene without redesigning it. Resolve fine masonry, columns, foliage, rocks and water with consistent sharpness and fine stippling. Keep upper left sky quiet and dark for website text. No blur, smudging, painterly shading, halos, text, borders or new structures.

## Prompt

Edit the supplied original Roman temple artwork into ONE continuous ultrawide panorama, aspect ratio 3:1, ideally 3072x1024. Outpaint the scene to the LEFT: preserve the original temple on the far right, its architecture and proportions, and continue its existing aqueduct and rocky river valley naturally across the entire lower portion of the widened canvas. One continuous connected aqueduct, one coherent perspective and landscape, no separated vignettes or seams. Preserve the original amber on charcoal palette and fine balanced dithered engraving texture exactly. The temple occupies rightmost quarter, distant low hills and smaller aqueduct arches stretch across the bottom left and bottom middle. Keep upper 60% of the left two thirds mostly flat charcoal sky for a website headline and buttons. Do not add a second foreground structure on the left. Do not mirror, duplicate, blur or stretch the original architecture. No text, no border, no new colors. The result should feel like the camera pulled back to show the wider world of the SAME original image.
