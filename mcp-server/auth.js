// Auth profiles: login once, reuse across runs (server-side, no extension changes).
//
// A profile stores a target's cookies + localStorage + sessionStorage as JSON
// under ~/.local/share/browser-mcp/profiles/ (0700 dir, 0600 files — secret
// values are NEVER echoed in tool output, only counts). Typical flow for the
// two-account checks the pipeline demands: save account A, save account B,
// load A in one partition and B in another.

import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'fs';

export function profileDir() {
  const d = join(homedir(), '.local', 'share', 'browser-mcp', 'profiles');
  mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

export function profilePath(name) {
  const safe = String(name || 'default').replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 64) || 'default';
  return join(profileDir(), safe + '.json');
}

const SAFESAMESITE = new Set(['no_restriction', 'lax', 'strict']);

export async function authSave(call, args, partition) {
  const name = args?.name || 'default';
  const tabs = await call('list_tabs', {}, 15000, partition);
  const list = tabs.tabs || [];
  const tab = list.find((t) => t.active) || list[0];
  if (!tab || !tab.url) throw new Error('no open tab to capture auth state from');
  let host;
  try { host = new URL(tab.url).hostname; } catch { throw new Error('active tab has no usable URL'); }
  const domains = [...new Set(
    (args?.domains && args.domains.length ? args.domains : [host, '.' + host]).map(String)
  )];
  const cookies = [];
  const seen = new Set();
  for (const d of domains) {
    let got;
    try { got = await call('get_cookies', { domain: d }, 15000, partition); }
    catch { continue; }
    const arr = got && typeof got === 'object' && !Array.isArray(got) && got.cookies ? got.cookies : got;
    for (const c of (Array.isArray(arr) ? arr : [])) {
      const key = `${c.domain || d}|${c.path || '/'}|${c.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cookies.push(c);
    }
  }
  let stor = {};
  if (args?.include_storage !== false) {
    const raw = await call('execute_script', {
      code: '(()=>({local:Object.assign({},localStorage),session:Object.assign({},sessionStorage),href:location.href}))()',
    }, 15000, partition);
    const v = raw && typeof raw === 'object' && 'result' in raw ? raw.result : raw;
    stor = v && typeof v === 'object' ? v : {};
  }
  const profile = {
    name,
    origin: (() => { try { return new URL(tab.url).origin; } catch { return ''; } })(),
    domains,
    cookies,
    localStorage: stor.local || {},
    sessionStorage: stor.session || {},
    saved_at: new Date().toISOString(),
  };
  const p = profilePath(name);
  writeFileSync(p, JSON.stringify(profile, null, 2), { mode: 0o600 });
  try { chmodSync(p, 0o600); } catch {}
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        saved: name,
        origin: profile.origin,
        cookies: cookies.length,
        local_keys: Object.keys(profile.localStorage).length,
        session_keys: Object.keys(profile.sessionStorage).length,
        note: 'secret values live only in the profile file (0600), never in tool output',
      }, null, 2),
    }],
  };
}

export async function authLoad(call, args, partition) {
  const name = args?.name || 'default';
  const p = profilePath(name);
  if (!existsSync(p)) {
    return { content: [{ type: 'text', text: `no such auth profile: ${name}` }], isError: true };
  }
  const prof = JSON.parse(readFileSync(p, 'utf8'));
  const url = args?.url || (prof.origin ? prof.origin + '/' : null);
  if (!url) throw new Error('profile has no origin and no url was given');
  let set = 0;
  const failed = [];
  for (const c of prof.cookies || []) {
    const bare = String(c.domain || '').replace(/^\./, '');
    const params = {
      name: c.name,
      value: c.value,
      path: c.path || '/',
      url: 'https://' + bare + '/',
    };
    if (c.domain) params.domain = c.domain;
    if (typeof c.secure === 'boolean') params.secure = c.secure;
    if (typeof c.httpOnly === 'boolean') params.httpOnly = c.httpOnly;
    if (typeof c.sameSite === 'string' && SAFESAMESITE.has(c.sameSite)) params.sameSite = c.sameSite;
    try { await call('set_cookies', params, 15000, partition); set++; }
    catch { failed.push(c.name); }
  }
  await call('navigate', { url }, 30000, partition);
  const code = `(()=>{const L=${JSON.stringify(prof.localStorage || {})},S=${JSON.stringify(prof.sessionStorage || {})};let l=0,s=0;try{for(const[k,v]of Object.entries(L)){localStorage.setItem(k,String(v));l++;}}catch(e){}try{for(const[k,v]of Object.entries(S)){sessionStorage.setItem(k,String(v));s++;}}catch(e){}return{local:l,session:s,href:location.href};})()`;
  let restored = {};
  try {
    const raw = await call('execute_script', { code }, 15000, partition);
    restored = (raw && typeof raw === 'object' && 'result' in raw ? raw.result : raw) || {};
  } catch (e) { restored = { error: e.message }; }
  // Reload so the app boots with the restored state actually applied.
  await call('navigate', { url }, 30000, partition);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        loaded: name,
        at: url,
        cookies_set: set,
        cookies_failed: failed,
        storage_restored: restored,
        limitation: 'persistent (expiry-dated) cookies restore as session cookies; re-save after Chrome restarts if login fades',
        verify_hint: 'confirm the logged-in state with browser_snapshot before proceeding',
      }, null, 2),
    }],
  };
}
