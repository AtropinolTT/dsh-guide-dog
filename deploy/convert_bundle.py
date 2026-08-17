#!/usr/bin/env python3
"""Convert the dynamic plugin halves into the static web-profile bundle.

Reads plugin-host.js / plugin-client.js (dynamic plugin format — the body is
`return { apply(ctx) {...} }`) and writes bundle/lib/index.js and
bundle/lib/client.js in the static bundle format consumed by the web profile:

- host half: a plain ESM module with named `name`/`apply` exports. The
  dynamic sandbox used to inject `harness`; the generated module defines a
  compatibility layer instead: `defineTool` is a passthrough (definitions
  already carry standard JSON Schemas), `registerTool` goes through the
  global `tools` registry (visible to every session — this is what removes
  the per-session dynamic instances), and `handle` RPCs become JSON POST
  routes under /guide-dog/api/. The per-workspace sandbox root is replaced
  by the global ~/.dsh/guide-dog directory (one config/media store).
- client half: a `window.__ModuleLoader__.load({id, factory})` CJS factory
  exactly like the published dsh-better-sidebar client bundle. The dynamic
  sandbox used to inject `React`/`styles`/`host`; the factory requires
  `react` from the platform seed, manages its own <style> tag, and turns
  `host.call` into same-origin fetches against the JSON routes.

Run after changing plugin-host.js / plugin-client.js:

    python3 deploy/convert_bundle.py
"""
import os
import re

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(REPO, 'bundle', 'lib')

HOST_HEAD = """import { homedir } from 'node:os'

export const name = 'dsh-guide-dog'

// Cordis parks this plugin until every listed service is registered, then
// calls apply. Without inject the bundle's apply ran before the core
// services existed and every ctx.get(...) came back undefined (observed
// 2026-08-16: "apply shell=false fs=false ..." + "cannot get property
// \\"tools\\" without inject"). Same mechanism the published
// dsh-better-sidebar bundle uses (its host half exports inject:
// webServer/sessions/loader/tools).
export const inject = [
  'shell',
  'fs',
  'webServer',
  'sandboxPolicy',
  'systemPrompt',
  'subprocess',
  'timer',
  'tools',
]

export function apply(ctx) {
  // Compatibility layer: the dynamic host half ran inside the
  // cordis-host-runner sandbox, which injected `harness`
  // (defineTool/registerTool/handle). In the static bundle there is no
  // harness: defineTool passes definitions through unchanged (they already
  // carry standard JSON Schemas), registerTool goes through the global
  // `tools` registry (visible to every session — no per-session dynamic
  // instances needed), and `handle` RPCs become JSON POST routes on the web
  // server, consumed by the client half via same-origin fetch.
  const GLOBAL_ROOT = homedir() + '/.dsh/guide-dog'
  // The dynamic harness.defineTool normalized a value-schema DSL (per-property
  // `required: true` on fields) into standard JSON Schema (object-level
  // `required` arrays). The static tools registry accepts only the standard
  // form, so re-implement that normalization here (observed 2026-08-16:
  // "JsonSchemaError: unsupported JSON schema: schema.properties.ok.required
  // is not supported on type \\"boolean\\"").
  function normalizeJsonSchema(node) {
    if (Array.isArray(node)) return node.map(normalizeJsonSchema)
    if (!node || typeof node !== 'object') return node
    const out = {}
    for (const k of Object.keys(node)) {
      if (k === 'required' && typeof node[k] === 'boolean') continue
      out[k] = normalizeJsonSchema(node[k])
    }
    if (out.type === 'object' && out.properties && typeof out.properties === 'object') {
      const req = Array.isArray(out.required) ? out.required.slice() : []
      for (const p of Object.keys(out.properties)) {
        const ps = out.properties[p]
        if (ps && typeof ps === 'object' && ps.required === true) {
          req.push(p)
          delete ps.required
        }
      }
      if (req.length) out.required = req
    }
    return out
  }
  const harness = {
    defineTool: function (d) {
      if (!d) return d
      const normalized = {}
      for (const k of Object.keys(d)) {
        if (k === 'output' && d.output && d.output.schema) {
          normalized.output = { ...d.output, schema: normalizeJsonSchema(d.output.schema) }
        } else if (k === 'parameters' && d.parameters) {
          normalized.parameters = normalizeJsonSchema(d.parameters)
        } else {
          normalized[k] = d[k]
        }
      }
      return normalized
    },
    registerTool: function (c, d) { return c.tools.register(d) },
    handle: function (name, handler) {
      const ws = ctx.get('webServer')
      if (!ws) return function () {}
      return ws.register({
        kind: 'prefix',
        path: '/guide-dog/api/' + name,
        handler: async function (req, res) {
          try {
            let args = {}
            if (req.method === 'POST') {
              const chunks = []
              for await (const c of req) chunks.push(c)
              const raw = Buffer.concat(chunks).toString('utf8')
              if (raw) { try { args = JSON.parse(raw) } catch (e) { args = {} } }
            }
            const out = await handler(args)
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify(out === undefined ? { ok: true } : out))
          } catch (e) {
            res.writeHead(500, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }))
          }
        },
      })
    },
  }

  const plugin = (() => {
"""

HOST_TAIL = """
  })()
  return plugin.apply(ctx)
}
"""

CLIENT_HEAD = """window.__ModuleLoader__.load({
  id: 'dsh-guide-dog',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require('react');
    // Compatibility layer: the dynamic client half ran inside the
    // cordis-client-runner sandbox, which injected `styles` and `host`
    // (package-private RPC). In the static bundle `styles.insert` manages a
    // <style> tag itself (returning a disposer, like the sandbox one) and
    // `host.call` becomes a same-origin fetch against the JSON routes the
    // host half registers under /guide-dog/api/.
    const styles = {
      insert: function (css) {
        const el = document.createElement('style');
        el.setAttribute('data-guide-dog', '');
        el.textContent = css;
        document.head.appendChild(el);
        return function () { if (el.parentNode) el.parentNode.removeChild(el) };
      },
    };
    const host = {
      call: function (name, args) {
        return fetch('/guide-dog/api/' + name, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(args === undefined ? {} : args),
        }).then(function (r) {
          if (!r.ok) return { ok: false, error: 'http ' + r.status };
          return r.json().catch(function () { return { ok: false, error: 'bad json' } });
        }).catch(function (e) {
          return { ok: false, error: String((e && e.message) || e) };
        });
      },
    };
    const plugin = (() => {
"""

CLIENT_TAIL = """
    })();
    exports.name = plugin.name || 'dsh-guide-dog';
    exports.apply = plugin.apply;
    return module.exports;
  }
});
"""


def convert():
    os.makedirs(OUT_DIR, exist_ok=True)
    host = open(os.path.join(REPO, 'plugin-host.js'), encoding='utf-8').read()
    # Replace the per-workspace sandbox-root resolver with the global root.
    # Old shape (dynamic): let guideRoot='' / async function guideDogRoot() {
    #   ...sandboxPolicy.workspaceRoot... }  ->  return GLOBAL_ROOT
    pat = re.compile(
        r"let guideRoot = ''\n"
        r"    async function guideDogRoot\(\) \{.*?return root\n    \}\n",
        re.S)
    new_host, n = pat.subn(
        "let guideRoot = ''\n"
        "    async function guideDogRoot() { return GLOBAL_ROOT }\n",
        host)
    if n != 1:
        raise SystemExit('guideDogRoot replacement matched %d times (expected 1)' % n)

    # ensureMediaDir keeps its own sandbox-root resolution; pin it to the
    # global root as well (without this it fell back to `pwd`, which needs the
    # shell service, and produced "/.guide-dog/media").
    pat2 = re.compile(
        r"    async function ensureMediaDir\(\) \{\n"
        r"      if \(mediaDir\) return mediaDir\n"
        r"      let root = ''\n"
        r"      if \(sandboxPolicy && sandboxPolicy\.workspaceRoot\) root = sandboxPolicy\.workspaceRoot\n"
        r"      if \(!root\) \{\n"
        r"        const p = await runRaw\('pwd', \{ timeoutMs: 10000 \}\)\n"
        r"        root = \(p\.stdout \|\| ''\)\.trim\(\)\n"
        r"      \}\n"
        r"      const dir = root \+ '/\.guide-dog/media'\n",
        re.S)
    new_host, n2 = pat2.subn(
        "    async function ensureMediaDir() {\n"
        "      if (mediaDir) return mediaDir\n"
        "      const dir = GLOBAL_ROOT + '/.guide-dog/media'\n",
        new_host)
    if n2 != 1:
        raise SystemExit('ensureMediaDir replacement matched %d times (expected 1)' % n2)

    with open(os.path.join(OUT_DIR, 'index.js'), 'w', encoding='utf-8') as f:
        f.write(HOST_HEAD + new_host + HOST_TAIL)

    client = open(os.path.join(REPO, 'plugin-client.js'), encoding='utf-8').read()
    # Client plugin-level inject: wait for the `slots` service before apply
    # (the static client Loader honours plugin inject like the host one; the
    # dynamic sandbox provided services differently).
    # R17 (2026-08-17): the client source now carries `inject: ['slots']`
    # itself (added in ae2c71c), so the insertion must be idempotent — match
    # with or without the line and always emit it.
    pat3 = re.compile(r"return \{\n(?:  inject: \['slots'\],\n)?  async apply\(ctx\) \{")
    client, n3 = pat3.subn("return {\n  inject: ['slots'],\n  async apply(ctx) {", client)
    if n3 != 1:
        raise SystemExit('client apply header matched %d times (expected 1)' % n3)
    with open(os.path.join(OUT_DIR, 'client.js'), 'w', encoding='utf-8') as f:
        f.write(CLIENT_HEAD + client + CLIENT_TAIL)

    print('wrote %s (%d bytes) and %s (%d bytes)' % (
        os.path.join(OUT_DIR, 'index.js'), len(HOST_HEAD) + len(new_host) + len(HOST_TAIL),
        os.path.join(OUT_DIR, 'client.js'), len(CLIENT_HEAD) + len(client) + len(CLIENT_TAIL)))


if __name__ == '__main__':
    convert()
