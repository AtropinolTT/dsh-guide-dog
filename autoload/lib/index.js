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
  const runner = ctx.get('dynamicCordisRunner')
  const agents = ctx.get('agents')
  if (!runner || !agents) {
    console.log('[gd-autoload] runner/agents unavailable, skipping')
    return
  }

  // sessionId -> last attempt timestamp (success or failure); cooldown gates
  // re-attempts so a persistent failure cannot spam define/run/approval.
  const attempted = new Map()

  async function deploy(agent) {
    if (!agent || typeof agent.id !== 'string' || !agent.id) return
    const now = Date.now()
    const last = attempted.get(agent.id)
    if (last !== undefined && now - last < RETRY_COOLDOWN_MS) return
    attempted.set(agent.id, now) // reserve before async work (racing events)

    try {
      // Skip when this session already owns a guide-dog plugin.
      let list = []
      try {
        if (typeof runner.inventory === 'function') list = runner.inventory()
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

      const receipt = runner.define({
        sessionId: agent.id,
        plugin: { kind: 'new', idPrefix: 'gdog' },
        name: 'guide-dog (autoloaded)',
        purpose: '自动恢复（DSH 重启）：Guide Dog 多模态插件 — 视觉检查/生成/TTS/语音输入',
        code,
      })
      const r = await runner.run(agent, receipt.pluginId, receipt.packageId, 'run')
      console.log('[gd-autoload] deployed ' + String(receipt.pluginId) + '/' + String(receipt.packageId) + ' status=' + String(r && r.status))
    } catch (e) {
      console.log('[gd-autoload] deploy failed for ' + String(agent && agent.id) + ': ' + String((e && e.message) || e))
      // `attempted` keeps the timestamp: cooldown, not infinite retry.
    }
  }

  // New sessions: agents service announces each agent after registration.
  // MEDIUM fix: trust only the payload's agent and verify it is the exact
  // live registry instance — never fall back to carrier fields.
  ctx.on('agent/created', (carrier, name, payload) => {
    const candidate = payload && payload.agent
    if (!candidate || typeof candidate.id !== 'string') return
    let live = null
    try { live = agents.get(candidate.id) } catch (e) { live = null }
    if (live !== candidate) {
      console.log('[gd-autoload] ignored agent/created for ' + candidate.id + ': not the live registry instance')
      return
    }
    deploy(candidate).catch(() => {})
  })

  // Sessions already live when this plugin activates (host starts after some
  // sessions exist, e.g. the web UI reconnects). roots() returns live agents.
  try {
    const roots = typeof agents.roots === 'function' ? agents.roots() : []
    for (const a of roots) {
      if (!a || typeof a.id !== 'string') continue
      const live = agents.get(a.id)
      if (live === a) deploy(a).catch(() => {})
    }
  } catch (e) { /* ignore */ }
}
