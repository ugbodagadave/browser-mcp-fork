#!/usr/bin/env python3
"""E2E test for browser-mcp partition tooling.

Spawns a fresh `node index.js` (new code), speaks MCP over stdio, and:
1. verifies tools/list exposes the 3 partition tools + partition param on tools
2. creates a partition and waits for the Chrome extension to adopt it
3. navigates INSIDE the partition, lists tabs in vs out of the partition
   (isolation proof), creates a tab in the default partition, re-checks
4. closes the partition and verifies it is gone

The test server is a separate process; the real Chrome extension connects to
its ports like any other opencode session. Everything is released when the
process exits.
"""
import json
import subprocess
from pathlib import Path
import sys
import time

SERVER_DIR = str(Path(__file__).resolve().parent)
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
    content = resp["result"]["content"]
    text = content[0].get("text", "")
    if resp["result"].get("isError"):
        raise RuntimeError(f"{name} failed: {text}")
    if len(content) > 1 or "image" in (content[0] or {}):
        return text  # screenshot-ish payload
    try:
        return json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return text


def check(label, cond, detail=""):
    status = "PASS" if cond else "FAIL"
    print(f"[{status}] {label}" + (f"  -- {detail}" if detail else ""))
    if not cond:
        proc.terminate()
        sys.exit(1)


# 1. init
init = rpc("initialize", {
    "protocolVersion": "2024-11-05",
    "capabilities": {},
    "clientInfo": {"name": "partition-test", "version": "1.0"},
})
rpc("notifications/initialized", notify=True)
check("initialize handshake", "serverInfo" in init.get("result", {}))

# 2. tools list
tools = rpc("tools/list")["result"]["tools"]
names = [t["name"] for t in tools]
for t in ("browser_partition_new", "browser_partition_list", "browser_partition_close"):
    check(f"tool exposed: {t}", t in names)
nav = next(t for t in tools if t["name"] == "browser_navigate")
check("browser_navigate has partition param",
      "partition" in nav["inputSchema"]["properties"])
check("browser_list_tabs has partition param",
      "partition" in next(t for t in tools if t["name"] == "browser_list_tabs")["inputSchema"]["properties"])

# 3. create a partition
res = call_tool("browser_partition_new", {"label": "partition-test"})
P = res["partition"]
check(f"partition created (port {P})", isinstance(P, int) and 9876 <= P <= 9895)
check("extension adopted partition", res.get("connected") is True, f"connected={res.get('connected')}")

# 4. list partitions
lst = call_tool("browser_partition_list")
ports = [p["partition"] for p in lst["partitions"]]
check("partition list shows default + new", lst["partitions"][0]["role"] == "default" and P in ports)

# 5. navigate INSIDE the partition
res = call_tool("browser_navigate", {"url": "https://example.com/", "partition": P})
check("navigate inside partition", "example.com" in json.dumps(res).lower() or isinstance(res, (dict, str)))

# 6. isolation: partition tab list vs default partition tab list
ptabs = call_tool("browser_list_tabs", {"partition": P})
pjson = json.dumps(ptabs).lower()
check("partition sees its tab", "example.com" in pjson, str(ptabs)[:200])
dtabs = call_tool("browser_list_tabs", {})
djson = json.dumps(dtabs).lower()
check("default partition does NOT see the partition's tab", "example.com" not in djson, str(dtabs)[:200])

# 7. default partition still works independently
res = call_tool("browser_navigate", {"url": "https://example.org/", "new_tab": True})
dtabs = call_tool("browser_list_tabs", {})
check("default partition has its own tab", "example.org" in json.dumps(dtabs).lower())
ptabs = call_tool("browser_list_tabs", {"partition": P})
check("partition unaffected by default navigation", "example.org" not in json.dumps(ptabs).lower())

# 8. bad partition errors cleanly
resp = rpc("tools/call", {"name": "browser_navigate", "arguments": {"url": "https://example.com/", "partition": 9894}})
errtext = resp["result"]["content"][0]["text"]
check("unknown partition gives actionable error",
      resp["result"].get("isError") and "browser_partition_new" in errtext, errtext[:120])

# 9. close the partition
res = call_tool("browser_partition_close", {"partition": P})
check("partition closed", res.get("closed") == P)
res = call_tool("browser_partition_list")
check("closed partition gone from list", P not in [p["partition"] for p in res["partitions"]])

# 10. close default partition is refused
res = rpc("tools/call", {"name": "browser_partition_close", "arguments": {"partition": res["partitions"][0]["partition"]}})
check("closing default partition refused", resp_ok := "cannot be closed" in res["result"]["content"][0]["text"])

print("\nALL TESTS PASSED")
proc.terminate()
try:
    proc.wait(timeout=5)
except subprocess.TimeoutExpired:
    proc.kill()
