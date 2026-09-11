# browser-updates.md — fork changelog (ireniumsecurity)

Local fork of Agent360's browser-mcp (`ugbodagadave/browser-mcp-fork`), optimized
for parallel security-research agents. Upstream PRs are pursued separately per
feature; this file is the running record of what this fork adds over upstream.

## 4. Effect-verified actions (honest `ok`)

**Problem (measured):** the extension reports `ok:true` for actions that did not
happen — append-instead-of-replace fills, synthetic clicks that never dispatch in
background tabs — and its own `landed:false` flag misfires in the other direction
(clicks whose handler provably fired while `landed:false`). Agents burn 5–30 calls
per incident retrying blindly, or abandon working paths on a false miss.

**What changed (`mcp-server/verify.js`, hooked in `index.js`):** after every
`fill / select_option / set_combobox / set_date / click / navigate`, the server
re-reads the effect and attaches `verified` + `effect` to the response.

| Tool | Rule |
|---|---|
| fill, select_option, set_combobox, set_date | HARD: read-back value must equal the requested value. Mismatch → `ok:false`, `effect: field is X, wanted Y`, plus a targeted hint. |
| click | RECONCILED: url/tab/target/content signals decide. Miss report + no signals → `ok:false` + hint. Observed effect → `ok:true, verified:true` even if the extension reported a miss. Effect with no downgrade otherwise (advisory: copy/download clicks legitimately change nothing visible). |
| navigate | HARD on origin: same URL, same-origin redirect, or prefix → `verified:true` + final URL. Anything else → `ok:false` + where the tab actually is. |

Cost: +1–3 cheap read calls per action (~1–2 s). A failed read-back never
punishes the original result (`verified:false` + note instead).

**Evidence (live, `test-improvements.py`, 2026-09-11):**
- Append caught: `{"ok": false, "verified": false, "effect": "field is \"helloold\", wanted \"hello\""}` — the extension had returned ok; the agent now knows in one call instead of looping.
- Miss override: `{"ok": true, "landed": false, "verified": true, "effect": "page content changed (note: the extension reported a miss, but the effect above was observed)"}` — handler provably fired (marker div `untouched`→`touched`).
- Missing target stays honest: `{"ok": false, "verified": false, "effect": "no observable change ..."}`.

## 5. Accessibility snapshot (`browser_snapshot`)

**Problem:** routine observation via screenshot costs ~100 KB+ per step; raw page
text has no actionable selectors. Playwright MCP's published trick is a 2–5 KB
semantic snapshot; this is that, server-side (no extension change).

**What changed (`mcp-server/snapshot.js`):** one line per visible interactive
element or heading — `[ref] role "name" [states] -> selector-hint`. `<div>` soup,
hidden nodes, and scripts are omitted. `max_nodes` (default 250, cap 1000) and
`root` (subtree scoping) bound the size. Refs are per-snapshot; the `->` hints
(`#id` or `text=`) feed straight into click/fill.

**Evidence (live):**

| Page | Snapshot | Page text | Screenshot (b64) |
|---|---|---|---|
| example.com (2 nodes) | 69 chars | 214 chars | 28,972 bytes |
| iana.org/domains/reserved (48 nodes) | 2,255 chars | 2,693 chars | 213,516 bytes |

~95x smaller than screenshots on the rich page, and unlike raw text every line is
directly actionable.

## 6. Auth profiles (`browser_auth_save` / `browser_auth_load`)

**Problem:** agents re-login to every target on every run (OTP round-trips, 2FA
walls), and two-account checks (the IDOR standard) need two live sessions at once.

**What changed (`mcp-server/auth.js`):** profiles under
`~/.local/share/browser-mcp/profiles/` (0700 dir, 0600 files, git-ignored).
`save` captures the active tab origin's cookies (via the cookies API, incl.
httpOnly) + local/session storage; `load` restores cookies, navigates, restores
storage, and reloads so the app boots authenticated. Tool output carries counts
and domains only — secret values never leave the profile file.

**Evidence (live):** save → poison (cookie + both storages overwritten with JUNK)
→ load → cookie, localStorage, and sessionStorage all restored to the secret;
neither tool's output contained the secret; profile file created 0600.

**Known limits:** persistent (expiry-dated) cookies restore as session cookies
(the extension's setter takes no expiry) — re-save after a Chrome restart if a
login fades. Restore adds cookies by name+domain+path; exact overwrite semantics
follow the cookies API. Always confirm login with `browser_snapshot` after load
(the tool says so in its own output).

## Earlier fork work

- **Partitions** (`browser_partition_new/list/close`, per-call `partition`
  routing): isolated tab groups per parallel agent. E2E 18/18 + live 5-agent
  concurrency test 5/5 ISOLATED. Upstream PR:
  `Agent360dk/browser-mcp#20` (partition-only diff, adapted to upstream's
  lazy-port architecture).
- **Burp proxy tools** (`browser_set_proxy`, `browser_get_network_requests`):
  inherited from the base snapshot, predate this log.

## Ops notes

- New tools take effect for freshly spawned servers (each opencode session spawns
  its own); running sessions keep the code they started with. No restart needed —
  new sessions pick it up automatically.
- Regression: `mcp-server/test-partitions.py` (18 checks) and
  `mcp-server/test-improvements.py` (25 checks) run against live Chrome; both
  clean up tabs, partitions, and probe profiles after themselves.
- Never commit `profiles/` (git-ignored) or paste profile contents into reports.
