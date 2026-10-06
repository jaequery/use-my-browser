---
name: use-my-browser
description: >-
  Operate any website as whoever is signed in to the Google Chrome on the
  machine running it, using that existing login — no password, no API key. Use
  when asked to "use my browser", "do this in my browser", "log in as me and…",
  "check my account on <site>", "post this on X / LinkedIn / Reddit / …", "tweet
  this", "fill in this form", "read my dashboard", or when an automation says
  "launch Chrome, copy the cookies, and go into <site>". Copies one Chrome
  profile's cookie store into a throwaway profile, drives the real Chrome binary
  over the DevTools Protocol with generic verbs (goto, text, click, type, press,
  wait, eval, screenshot), then deletes the throwaway profile. Works on any site;
  macOS + Google Chrome only.
---

# Use my browser

Drives a website as whoever is signed in to this machine's Google Chrome. It reads
`~/Library/Application Support/Google/Chrome`, so the accounts are the ones logged in on the
machine running it, which may not be the person who asked. Check who you are before acting.

## How it works (why it needs no password)

1. Picks a Chrome profile: Chrome's own last-used one, or `--profile`. It never reads cookie
   values, and never looks at which sites a profile is signed in to.
2. Copies that profile's `Cookies` file (plus its `Local Storage`) into a fresh temp
   `--user-data-dir`.
3. Launches the **real** Google Chrome binary on it, headless, and leaves it running as a
   session. Chrome itself decrypts the cookies with the "Chrome Safe Storage" Keychain key, so
   nothing is ever decrypted or written out in plaintext. Playwright's bundled Chromium can NOT
   do this: it has no Keychain key, which is why it lands on login pages.
4. Each verb connects to that session over the DevTools Protocol, does one thing, and exits.
   Clicks and typing are real input events, so editors that ignore a scripted `.focus()` or
   `.value =` still work.
5. `stop` kills that Chrome and deletes the temp profile.

## Steps

The script ships beside this file, in this skill's base directory; it needs Node 22+ (global
`WebSocket`). `B` below means `node <this skill's base directory>/scripts/browser.mjs`.

1. **Settle anything outward-facing with the user first**: a post, a message, a purchase, a
   form submission, a setting change. Show the exact text or action and get a yes, unless an
   automation's prompt already authorized it. Reading pages needs no sign-off.
2. Pick the profile when there may be several: `B profiles` lists each one's directory, name and
   account. Then `B start` (or `B start --profile "Profile 3"`). Add `--headful` to watch.
3. Work the page in a loop: `B goto <url>`, then **look before you act** with `B text` (or
   `B screenshot <scratchpad>/page.png` and read the image), then `B click` / `B type` /
   `B press`, then `B wait` for the result. Confirm you are signed in as the right account
   before any write; a login page means that profile is signed out of that site.
4. Verify the outcome on the site itself (the new post on the profile, the saved setting, the
   confirmation page) and report what you saw.
5. **Always `B stop`**, even after a failure. It deletes the throwaway profile; say so.

## Verbs

| Verb | Does |
|---|---|
| `profiles` | list Chrome profiles and the last-used one |
| `start [--profile DIR] [--headful]` | launch the session |
| `status` | the session's profile and current page |
| `goto <url>` | navigate, wait for load, print url + title |
| `text [selector] [--max N]` | visible text of the page or one element (default 20000 chars) |
| `eval <js>` | evaluate an expression in the page (awaits promises), print JSON |
| `click <selector> [--text STR]` | real click on the first match whose text contains STR |
| `type <text>` or `type --file PATH`, `[--into SELECTOR]` | type into the focused element, or click SELECTOR first; newlines become Enter |
| `press <key>` | Enter, Tab, Escape, Backspace, ArrowDown, ArrowUp |
| `wait <js> [--timeout MS]` | poll until the expression is truthy |
| `screenshot <file.png>` | capture the viewport |
| `stop` | kill Chrome, delete the throwaway profile |

For multi-line text, or text with quotes, write it to a file in your scratchpad and pass
`type --file <path>`. Prefer stable selectors (`[data-testid=…]`, `[aria-label=…]`, `role`,
`name`) over generated class names; find them with `eval` over `document.querySelectorAll`.

## Example: posting on X

```sh
B start
B goto https://x.com/home
B eval "document.querySelector('a[data-testid=AppTabBar_Profile_Link]')?.getAttribute('href')"  # who am I
B goto https://x.com/compose/post
B type --file "$SCRATCH/tweet.txt" --into '[data-testid="tweetTextarea_0"]'
B text '[data-testid="tweetTextarea_0"]'      # check it holds exactly the agreed text
B click '[data-testid="tweetButton"]'
B wait "!document.querySelector('[data-testid=tweetTextarea_0]')"
B goto https://x.com/<handle>                  # verify the new post is on the profile
B stop
```

Any other site is the same loop with its own URLs and selectors.

## When it fails

- `Google Chrome not found`: this skill needs macOS with Google Chrome in `/Applications`.
- A login page where you expected to be signed in: that profile is signed out of the site (or
  the site keeps its session somewhere other than cookies and Local Storage). Try another
  profile from `B profiles`, or ask the user to log in in their normal Chrome and `start` again.
  Don't try to log in for them.
- `a session is already running`: `B status` to see it, `B stop` to end it.
- `timed out waiting for …` / `no element matches …`: the markup differs from what you assumed
  or an interstitial appeared. `B screenshot` and look. Never repeat a write (Post, Send, Buy)
  until you have checked the site, since a "timeout" after clicking may still have gone through.
- Never copy cookie *values* out, decrypt them, or paste them into another browser or tool, and
  never print secrets from a page into the conversation.
