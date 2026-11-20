# Figma Community listing

**Name:** PopNow: AI Image Generator and Editor

**Tagline (100 characters max):** Generate images and edit layers with AI. The price in credits is on the button before you start.

**Description:**

Generate images and edit the layer you selected, without leaving Figma or FigJam. Every button shows its price
in credits before anything starts, and results land as new layers next to the original.

- Generate from a prompt with Nano Banana, Seedream, GPT Image and more, or let Auto pick
- Select a layer to Edit image, Remove background, Upscale, Expand, Relight or change the Camera angle
- Split layers turns a flat picture into separate layers in one group
- Image to video makes a short clip from a layer and places its first frame with a link to play it
- Results never overwrite your work: they appear next to the source and get selected
- Works in Figma design files and FigJam boards, in light and dark themes

Sign in with your PopNow account. Same credits and same prices as popnow.ai. Failed creations are refunded
automatically.

PopNow AI is the world's first AI studio with automatic price protection.

**Category:** Design tools / Image generation (pick the closest offered)

**Tags:** ai, image generator, background remover, upscale, relight, expand image, image to video, layers

**Website:** https://popnow.ai
**Support:** support@popnow.ai
**Privacy policy:** https://popnow.ai/privacy
**Terms:** https://popnow.ai/terms

**Network access (shown on the Community page, from manifest.json):** api.popnow.ai, connect.popnow.ai,
media.popnow.ai, *.r2.cloudflarestorage.com, fonts.googleapis.com, fonts.gstatic.com, with the reasoning in
`manifest.json`.

## Assets

| File | Use |
| --- | --- |
| `store/icon-128.png` | Plugin icon, 128 × 128 |
| `store/cover-1920x960.png` | Cover / thumbnail, 1920 × 960 |
| `store/carousel-1-generate.png` | Carousel 1, Generate |
| `store/carousel-2-selection.png` | Carousel 2, Edit the selected layer (light and dark) |
| `store/carousel-3-sign-in.png` | Carousel 3, Sign in and long jobs |
| `store/screenshots/{light,dark}-sign-in.png` | Panel: sign-in |
| `store/screenshots/{light,dark}-generate.png` | Panel: Generate with the price on the button |
| `store/screenshots/{light,dark}-selection.png` | Panel: tools on the selected layer |
| `store/screenshots/{light,dark}-progress.png` | Panel: a video in progress with Stop waiting |

The canvas in the cover and carousel 2 shows a real PopNow edit (before and after), not a filter.
Regenerate everything with `npm run screenshots`.

## Before submitting

1. Deploy PopNow Connect at `https://connect.popnow.ai` (sign-in needs it).
2. Publish from Figma desktop: Plugins → Development → the plugin → Publish. Figma assigns the plugin id;
   put it in `manifest.json` and commit.
3. Run one full pass with a real account: sign in, Generate, each tool on a layer, Stop waiting on a video,
   Sign out.
