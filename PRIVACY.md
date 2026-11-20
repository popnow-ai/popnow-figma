# Privacy

The PopNow plugin for Figma and FigJam has no analytics and reads nothing from your file by itself.

- **Your sign-in** (OAuth tokens for your PopNow account) is stored with `figma.clientStorage` on your
  computer and sent only to `api.popnow.ai`. Signing out deletes it and revokes the tokens. The sign-in relay
  `connect.popnow.ai` only passes a one-time code back to the plugin; it never sees a token.
- **The selected layer** is exported and uploaded to your PopNow account only after you pick a tool and fill
  in what it needs, so the price can be shown. Other layers are never read.
- **Your prompt** is sent to `api.popnow.ai` when the panel asks for a price or you start a creation.
- **Results** are downloaded from PopNow's storage and added to your file as new layers.
- **Fonts**: the panel loads the Gabarito font from Google Fonts.

PopNow's handling of your requests and files is covered by its [privacy policy](https://popnow.ai/privacy).
