# Changelog

## 0.1.0

- First version for Figma and FigJam.
- Sign in with a PopNow account (OAuth with PKCE through PopNow Connect); tokens in `figma.clientStorage`.
- Generate: prompt, shape and model (Auto first).
- On the selected layer: Edit image, Remove background, Upscale, Expand, Relight, Camera angle, Split layers
  (as one group) and Image to video (first frame plus a link).
- The price in credits is on every button before anything starts; the approved price is the limit and is
  never raised. Get credits when the balance is too low. Consent is ticked by the user.
- Results are new layers next to the source and get selected; the source is never changed.
- Long jobs show the elapsed time; Stop waiting leaves the job running on PopNow.
- Light and dark panel that follows Figma's theme.
