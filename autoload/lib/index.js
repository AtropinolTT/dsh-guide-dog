import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

/**
 * Host-level auto-deployer for the Guide Dog dynamic Cordis plugin.
 *
 * Why this exists: dynamic Cordis plugin definitions (gdog-*) live only in the
 * current DSH process. After a restart every plugin is gone, so without this
 * row the user must re-run cordis_define + cordis_run by hand in every new
 * session. This plugin listens for `agent/created` and deploys Guide Dog from
 * a trusted deployment directory through the dynamic Cordis runner, once per
 * session, automatically.
 *
 * Security model (2026-08-15 review findings):
 *  - HIGH fixed: sources are read from ${DEPLOY_DIR} under the user's home —
 *    OUTSIDE any session workspace — and every file is verified against the
 *    SHA-256 manifest shipped there by the publish script. A compromised
 *    workspace or repo cannot inject code into the deployment. Mismatches
 *    refuse deployment and log loudly.
 *  - MEDIUM fixed: `agent/created` handlers accept only the payload's `agent`
 *    AND verify it is the exact live registry instance (`agents.get(id) ===
 *    agent`). A forged event carrying a look-alike object is rejected.
 *  - LOW fixed: failed deploys stay in the per-process attempt set for a
 *    30s cooldown instead of retrying on every event, avoiding approval
 *    fatigue.
 *
 * Approval note: the first client activation per process requires one human
 * approval (the browser executes the client half). The approval card appears
 * in the UI when the first session of a restarted DSH starts; afterwards the
 * grant covers future versions until the next restart.
 */
export const name = 'dsh-guide-dog-autoload'

// Trusted deployment directory (user home, outside session workspaces).
// Populated by deploy/publish.py in the guide-dog-dsh repo; the autoloader
// never reads from the repo directory.
const DEPLOY_DIR = '/home/tt-wsl-ubuntu/.dsh/guide-dog-deploy'
const MANIFEST = 'manifest.json'
const SOURCES = ['plugin-host.js', 'plugin-client.js']
const RETRY_COOLDOWN_MS = 30_000

export function apply(ctx) {
  // Root cause #3 (2026-08-16): `dynamicCordisRunner` and `agents` are
  // registered on AGENT-SCOPED contexts, not on the global/profile context
  // this bundle applies in. `ctx.get(...)` here returns undefined, so the old
  // code bailed out at apply time and never registered the listener at all
  // ("[gd-autoload] runner/agents unavailable, skipping" on every start).
  // The fix resolves both services through the event payload's `agent.ctx`
  // (Agent has `readonly ctx: Context`), falling back to the global ctx for
  // hosts that register them globally.

  // sessionId -> last attempt timestamp (success or failure); cooldown gates
  // re-attempts so a persistent failure cannot spam define/run/approval.
  const attempted = new Map()

  // Resolve {runner, agents} from the agent's own context first, then the
  // global context. Returns null when neither is available.
  function resolveServices(agent) {
    const candidates = []
    if (agent && agent.ctx && typeof agent.ctx.get === 'function') candidates.push(agent.ctx)
    candidates.push(ctx)
    for (const c of candidates) {
      let runner = null
      let agents = null
      try { runner = c.get('dynamicCordisRunner') } catch (e) { runner = null }
      try { agents = c.get('agents') } catch (e) { agents = null }
      if (runner && agents) return { runner, agents }
    }
    return null
  }

  async function deploy(agent, services) {
    if (!agent || typeof agent.id !== 'string' || !agent.id) return
    const now = Date.now()
    const last = attempted.get(agent.id)
    if (last !== undefined && now - last < RETRY_COOLDOWN_MS) return
    attempted.set(agent.id, now) // reserve before async work (racing events)

    try {
      // Skip when this session already owns a guide-dog plugin.
      let list = []
      try {
        if (typeof services.runner.inventory === 'function') list = services.runner.inventory()
      } catch (e) { list = [] }
      const owns = list.some((p) => p && p.sessionId === agent.id && String(p.pluginId || '').indexOf('gdog') === 0)
      if (owns) return

      // Read + integrity-check every source against the manifest.
      let manifest
      try {
        manifest = JSON.parse(await readFile(DEPLOY_DIR + '/' + MANIFEST, 'utf8'))
      } catch (e) {
        throw new Error('deploy manifest missing/unreadable: ' + String((e && e.message) || e))
      }
      const code = {}
      for (const file of SOURCES) {
        const raw = await readFile(DEPLOY_DIR + '/' + file, 'utf8')
        const actual = createHash('sha256').update(raw).digest('hex')
        const expected = manifest[file]
        if (typeof expected !== 'string' || expected.length !== 64 || actual !== expected) {
          throw new Error('integrity mismatch for ' + file + ' (got ' + actual.slice(0, 12) + '…, expected ' + String(expected || 'none') + ')')
        }
        if (file === 'plugin-host.js') code.host = raw
        else code.client = raw
      }

      const receipt = services.runner.define({
        sessionId: agent.id,
        plugin: { kind: 'new', idPrefix: 'gdog' },
        name: 'guide-dog (autoloaded)',
        purpose: '自动恢复（DSH 重启）：Guide Dog 多模态插件 — 视觉检查/生成/TTS/语音输入',
        code,
      })
      const r = await services.runner.run(agent, receipt.pluginId, receipt.packageId, 'run')
      console.log('[gd-autoload] deployed ' + String(receipt.pluginId) + '/' + String(receipt.packageId) + ' status=' + String(r && r.status))
    } catch (e) {
      console.log('[gd-autoload] deploy failed for ' + String(agent && agent.id) + ': ' + String((e && e.message) || e))
      // `attempted` keeps the timestamp: cooldown, not infinite retry.
    }
  }

  // New sessions: agents service announces each agent after registration.
  // MEDIUM fix: trust only the payload's agent and verify it is the exact
  // live registry instance — never fall back to carrier fields.
  // Contract (verified via Event.listEvents): 'agent/created'(this:
  // Scoped<Agent>, payload: { agent: Agent }) — exactly ONE argument. A
  // (carrier, name, payload) triple signature made `payload` undefined and
  // silently skipped every deploy (root cause #2, 2026-08-15).
  ctx.on('agent/created', (payload) => {
    const candidate = payload && payload.agent
    if (!candidate || typeof candidate.id !== 'string') {
      console.log('[gd-autoload] agent/created without a valid payload.agent — payload shape: ' + JSON.stringify(Object.keys(payload || {})))
      return
    }
    const services = resolveServices(candidate)
    if (!services) {
      console.log('[gd-autoload] runner/agents unavailable for ' + candidate.id + ' (agent.ctx and global ctx both lack them), skipping')
      return
    }
    let live = null
    try { live = services.agents.get(candidate.id) } catch (e) { live = null }
    if (live !== candidate) {
      console.log('[gd-autoload] ignored agent/created for ' + candidate.id + ': not the live registry instance')
      return
    }
    deploy(candidate, services).catch(() => {})
  })

  // Sessions already live when this bundle activates — only possible when the
  // services ARE globally registered; otherwise the event path covers them.
  const globalServices = resolveServices(null)
  if (globalServices) {
    try {
      const roots = typeof globalServices.agents.roots === 'function' ? globalServices.agents.roots() : []
      for (const a of roots) {
        if (!a || typeof a.id !== 'string') continue
        const live = globalServices.agents.get(a.id)
        if (live === a) deploy(a, globalServices).catch(() => {})
      }
    } catch (e) { /* ignore */ }
  }
}
