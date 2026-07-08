# Browser Access (template) - real-browser UI verification

Copy to `_shared/browser-access.md` during bootstrap and fill placeholders.
Applies to any agent whose brief requires rendered-page verification.

## Mandate

Rendered UI work is verified in a REAL browser - screenshot plus read-back -
never by curl/grep on markup alone. Source-only checks are complementary,
never the sole verify; rendered verification is the highest-confidence gate
against silent CSS / template / token drift that HTTP status cannot detect.
Carve-out: backend, decision-only, and pure file-organization tickets with no
rendered change are exempt.

## Tool

`{{BROWSER_TOOL | e.g. Playwright MCP, agent-browser CLI | ask:first_use}}` -
once chosen, record here: invocation verbs, screenshot command, and a
session-isolation convention (one named session per agent, preventing
cross-contamination when several agents browse in the same cycle).

## Allowed origins (STRICT WHITELIST)

- `{{APP_ORIGIN | e.g. http://localhost:PORT}}` - dev server
- `{{TEST_SERVER_ORIGIN | optional}}` - e2e test server
- `{{LAN_ORIGINS | optional}}`

Never open any URL outside the whitelist - no search engines, no docs sites,
no external host of any kind. Never follow external redirects - stop and
report. If a brief implies opening an external URL, flag to the PM:
`Browser-scope violation request: brief implies <url> outside the whitelist; need decision.`
Documentation comes from local sources only.

## Viewport and evidence

- Desktop: `{{DESKTOP_VIEWPORT | default:1280x720}}` - mandatory for every UI
  verify and spec-vs-implementation review.
- Mobile: `{{MOBILE_VIEWPORT | optional}}` - verify the tool ACTUALLY emulates
  it (check `window.innerWidth`) before trusting device flags; the source
  project's device flag silently kept the desktop viewport. If emulation is
  unavailable: note desktop-only explicitly in close output, and flag
  phone-critical specs (touch targets, on-screen keyboard, mobile-first
  interactions) to the owner instead of signing off desktop-only.
- Screenshots to a stable path convention
  (`{{SCREENSHOT_PATH_CONVENTION | default:/tmp/<agent>-<ticket>-<route>-<viewport>.png}}`);
  READ THEM BACK before claiming anything.
- Locale spot-check every configured locale (`profiles/project.md`) for UI
  verifies.
- Close-output line per page tested:
  `browser self-verify: desktop OK / mobile <status>` + screenshot paths +
  visual observations (layout regression, palette drift, missing tokens).

## Login for smoke/verify flows

Use a dedicated smoke credential `{{SMOKE_CREDENTIAL | ask:first_use}}` -
never a throwaway account that pollutes real data, never the owner's account
except in an owner-approved production smoke where the brief supplies it.
