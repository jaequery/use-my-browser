# use-my-browser

A Claude Code skill that operates any website as whoever is signed in to this Mac's Google Chrome, using that existing login — no password, no API key.

It copies one Chrome profile's cookie store into a throwaway profile, drives the real Chrome binary over the DevTools Protocol (goto, text, click, type, press, wait, eval, screenshot), then deletes the throwaway profile. Cookie values are never read or decrypted by the script; Chrome decrypts them itself with its Keychain key.

- **Requires:** macOS, Google Chrome in `/Applications`, Node 22+.
- **Install in Fredrin:** Settings → Skills → `jaequery/use-my-browser`.
- **Invoke:** `/use-my-browser:use-my-browser`, or just ask "do this in my browser".

See [`SKILL.md`](SKILL.md) for the verbs and the safety rules: outward-facing actions (posts, messages, purchases, form submissions) are confirmed with the user first.
