#!/usr/bin/env python3
"""E2E test + improvement evidence for snapshot / verify / auth.

Spawns a fresh `node index.js`, speaks MCP over stdio against live Chrome.
Leaves no tabs, partitions, or profiles behind (uses a throwaway profile name).

Evidence collected (printed for browser-updates.md):
- snapshot chars/nodes vs get_page_content chars vs screenshot bytes
- fill verified:true + effect; disabled-field honest ok:false downgrade
- auth round-trip: save -> poison -> load -> restored; secrets never echoed
"""
import json
import os
import stat
import subprocess
import sys
from pathlib import Path

SERVER_DIR = str(Path(__file__).resolve().parent)
PROF = "e2e-probe-profile"
SECRET = "s3cr3t-probe-value-9z"
proc = subprocess.Popen(
    ["/usr/bin/node", "index.js"],
    cwd=SERVER_DIR,
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
    bufsize=1,
)

_next_id = [0]
EVIDENCE = {}


def rpc(method, params=None, notify=False):
    msg = {"jsonrpc": "2.0", "method": method}
    if params is not None:
        msg["params"] = params
    if notify:
        proc.stdin.write(json.dumps(msg) + "\n")
        proc.stdin.flush()
        return None
    _next_id[0] += 1
    msg["id"] = _next_id[0]
    proc.stdin.write(json.dumps(msg) + "\n")
    proc.stdin.flush()
    while True:
        line = proc.stdout.readline()
        if not line:
            raise RuntimeError("server closed stdout")
        resp = json.loads(line)
        if resp.get("id") == msg["id"]:
            return resp


def call_tool(name, args=None):
    resp = rpc("tools/call", {"name": name, "arguments": args or {}})
    if resp.get("error"):
        raise RuntimeError(f"{name}: {resp['error']}")
    res = resp["result"]
    if res.get("isError"):
        raise RuntimeError(f"{name} failed: {res['content'][0].get('text', '')[:300]}")
    texts = [c.get("text", "") for c in res["content"] if c.get("text")]
    imgs = [c for c in res["content"] if c.get("type") == "image"]
    parsed = None
    if texts:
        try:
            parsed = json.loads(texts[0])
        except (json.JSONDecodeError, TypeError):
            parsed = texts[0]
    return parsed, texts, imgs


def check(label, cond, detail=""):
    print(f"[{'PASS' if cond else 'FAIL'}] {label}" + (f"  -- {detail}" if detail else ""))
    if not cond:
        proc.terminate()
        sys.exit(1)


def cleanup():
    try:
        tabs, _, _ = call_tool("browser_list_tabs", {})
        for t in tabs.get("tabs", []):
            try:
                call_tool("browser_close_tab", {"tab_id": t["id"]})
            except Exception:
                pass
    except Exception:
        pass
    p = Path.home() / ".local/share/browser-mcp/profiles" / f"{PROF}.json"
    if p.exists():
        p.unlink()
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()


rpc("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                   "clientInfo": {"name": "improve-test", "version": "1.0"}})
rpc("notifications/initialized", notify=True)

# 1. tools exposed
tools = rpc("tools/list")["result"]["tools"]
names = [t["name"] for t in tools]
for tname in ("browser_snapshot", "browser_auth_save", "browser_auth_load"):
    check(f"tool exposed: {tname}", tname in names)
    tdef = next(t for t in tools if t["name"] == tname)
    check(f"{tname} has partition param", "partition" in tdef["inputSchema"]["properties"])

# 2. baseline page
nav, _, _ = call_tool("browser_navigate", {"url": "https://example.com/"})
check("navigate verified", nav.get("verified") is True, str(nav.get("effect")))

# 3. snapshot vs alternatives (evidence)
snap, _, _ = call_tool("browser_snapshot", {})
check("snapshot returns lines", snap.get("nodes", 0) >= 1, f"nodes={snap.get('nodes')}")
EVIDENCE["snapshot_chars"] = snap.get("chars")
EVIDENCE["snapshot_nodes"] = snap.get("nodes")
EVIDENCE["snapshot_sample"] = (snap.get("snapshot") or "")[:400]
content, texts, _ = call_tool("browser_get_page_content", {"format": "text"})
EVIDENCE["pagecontent_chars"] = len(texts[0]) if texts else -1
_, _, imgs = call_tool("browser_screenshot", {})
EVIDENCE["screenshot_bytes"] = len(imgs[0].get("data", "")) if imgs else -1
print(f"EVIDENCE snapshot_chars={EVIDENCE['snapshot_chars']} pagecontent_chars={EVIDENCE['pagecontent_chars']} screenshot_b64={EVIDENCE['screenshot_bytes']}")

# 3b. rich-page economics (IANA reserved-domains page)
call_tool("browser_navigate", {"url": "https://www.iana.org/domains/reserved"})
rsnap, _, _ = call_tool("browser_snapshot", {})
_, rtexts, _ = call_tool("browser_get_page_content", {"format": "text"})
_, _, rimgs = call_tool("browser_screenshot", {})
EVIDENCE["rich"] = {"snapshot_chars": rsnap.get("chars"), "nodes": rsnap.get("nodes"),
                    "pagecontent_chars": len(rtexts[0]) if rtexts else -1,
                    "screenshot_b64": len(rimgs[0].get("data", "")) if rimgs else -1}
print("EVIDENCE rich=" + json.dumps(EVIDENCE["rich"]))
call_tool("browser_navigate", {"url": "https://example.com/"})

# 4. snapshot hint is actionable: plant a same-page button, click via CSS, expect override
call_tool("browser_execute_script", {"code": "(()=>{document.body.insertAdjacentHTML('beforeend','<button id=cb>tap</button><div id=mark>untouched</div>');document.getElementById('cb').addEventListener('click',()=>{document.getElementById('mark').textContent='touched';});return 'planted';})()"})
clk, _, _ = call_tool("browser_click", {"selector": "#cb"})
check("click reconciles miss-report with observed effect",
      clk.get("ok") is True and clk.get("verified") is True and "page content changed" in str(clk.get("effect", "")),
      json.dumps(clk)[:300])
EVIDENCE["click_override"] = {k: clk.get(k) for k in ("ok", "landed", "verified", "effect")}
# honest failure still propagates: nonexistent target, nothing changes
miss, _, _ = call_tool("browser_click", {"selector": "#does-not-exist-xyz"})
check("click on missing target stays ok:false",
      miss.get("ok") is False and miss.get("verified") is False, json.dumps(miss)[:200])

# back to example.com for the controlled tests
call_tool("browser_navigate", {"url": "https://example.com/"})

# 5a. fill verified:true on an EMPTY planted input
call_tool("browser_execute_script", {"code": "(()=>{document.body.insertAdjacentHTML('beforeend','<input id=vf>');return 'planted';})()"})
fill, _, _ = call_tool("browser_fill", {"selector": "#vf", "value": "hello"})
check("fill verified:true", fill.get("verified") is True and fill.get("ok", True) is not False,
      str(fill.get("effect")))
EVIDENCE["fill_effect"] = fill.get("effect")

# 5b. honest downgrade: extension appends instead of replacing (caught live)
call_tool("browser_execute_script", {"code": "(()=>{document.body.insertAdjacentHTML('beforeend','<input id=vfa value=\"old\">');return 'planted';})()"})
app, _, _ = call_tool("browser_fill", {"selector": "#vfa", "value": "hello"})
check("append-instead-of-replace caught honestly",
      app.get("ok") is False and app.get("verified") is False and '"hello"' in str(app.get("effect", "")),
      json.dumps(app)[:250])
EVIDENCE["append_caught"] = app.get("effect")

# 6. read-back is truthful even where DOM rules say it should fail: the
# debugger-level fill writes a disabled input, and verification confirms it
call_tool("browser_execute_script", {"code": "(()=>{document.body.insertAdjacentHTML('beforeend','<input id=vro disabled value=\"fixed\">');return 'planted';})()"})
dis, _, _ = call_tool("browser_fill", {"selector": "#vro", "value": "nope"})
check("disabled fill truthfully verified (debugger path writes it)",
      dis.get("verified") is True and '"nope"' in str(dis.get("effect", "")),
      json.dumps(dis)[:200])
EVIDENCE["disabled_fill"] = dis.get("effect")

# 7. auth round-trip on example.com (planted cookie + storage)
call_tool("browser_execute_script", {"code": f"(()=>{{document.cookie='probe={SECRET};path=/';localStorage.setItem('probe_ls','{SECRET}');sessionStorage.setItem('probe_ss','{SECRET}');return document.cookie;}})()"})
saved, stexts, _ = call_tool("browser_auth_save", {"name": PROF})
check("auth_save reports counts", saved.get("cookies", 0) >= 1, json.dumps(saved)[:160])
check("auth_save echoes no secrets", SECRET not in stexts[0])
p = Path.home() / ".local/share/browser-mcp/profiles" / f"{PROF}.json"
check("profile file exists with 0600", p.exists() and (os.stat(p).st_mode & 0o777) == 0o600,
      oct(os.stat(p).st_mode & 0o777))
check("profile file holds the secret (restore source)", SECRET in p.read_text())
# poison live state, then restore
call_tool("browser_execute_script", {"code": "(()=>{document.cookie='probe=JUNK;path=/';localStorage.setItem('probe_ls','JUNK');sessionStorage.setItem('probe_ss','JUNK');return 'poisoned';})()"})
loaded, ltexts, _ = call_tool("browser_auth_load", {"name": PROF, "url": "https://example.com/"})
check("auth_load restores", loaded.get("cookies_set", 0) >= 1, json.dumps(loaded)[:200])
check("auth_load echoes no secrets", SECRET not in ltexts[0])
back, _, _ = call_tool("browser_execute_script", {"code": "(()=>({cookie:document.cookie,ls:localStorage.getItem('probe_ls'),ss:sessionStorage.getItem('probe_ss')}))()"})
bv = back.get("result", back) if isinstance(back, dict) else back
check("cookie restored", SECRET in str(bv.get("cookie", "")), str(bv.get("cookie"))[:60])
check("localStorage restored", bv.get("ls") == SECRET, str(bv.get("ls"))[:40])
check("sessionStorage restored", bv.get("ss") == SECRET, str(bv.get("ss"))[:40])
EVIDENCE["auth_load"] = loaded

# 8. partition routing on the new tools
np, _, _ = call_tool("browser_partition_new", {"label": "improve-test"})
P = np["partition"]
psnap, _, _ = call_tool("browser_snapshot", {"partition": P})
check("snapshot works inside a partition", psnap.get("nodes") is not None)
ptabs, _, _ = call_tool("browser_list_tabs", {"partition": P})
dtabs, _, _ = call_tool("browser_list_tabs", {})
pj = json.dumps(ptabs)
check("partition isolated from default session", "example.com" not in pj or len(ptabs.get("tabs", [])) == 0, pj[:120])
for t in ptabs.get("tabs", []):
    call_tool("browser_close_tab", {"tab_id": t["id"], "partition": P})
call_tool("browser_partition_close", {"partition": P})

print("\nEVIDENCE " + json.dumps({k: v for k, v in EVIDENCE.items() if k != "snapshot_sample"}, indent=1)[:800])
print("ALL TESTS PASSED")
cleanup()
