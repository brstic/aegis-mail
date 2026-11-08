# Aegis Mail link check (browser extension, experimental)

Marks risky links in webmail: lookalike domains, text that says one site but goes to another, disguised addresses, and link shorteners. **It runs entirely on your device.** The manifest requests no permissions and the code makes no network requests, so nothing about your mail leaves the page.

Build: `pnpm --filter @aegis/extension build`, then load `apps/extension/dist` as an unpacked extension.

Limits: it only sees links, not the full analysis. Tested against a local stand-in page served at the webmail addresses, not the real webmail products, whose markup can change. `xn--` hosts aren't decoded in the browser build, so some homographs are missed. It hasn't been submitted to any extension store.
