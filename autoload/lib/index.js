import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

/**
 * Host-level auto-deployer for the Guide Dog dynamic Cordis plugin.
 *
 * Why this exists: dynamic Cordis plugin definitions (gdog-*) live only in the
 * current DSH process. After a restart every plugin is gone, so without this
 * row the user must re-run cordis_define + cordis_run by hand in every new
 * session. This plugin listens for `agent/created` and deploys Guide Dog from
 * the repo sources (plugin-host.js / plugin-client.js) through the dynamic
 * Cordis runner, once per session, automatically.
 *
 * Approval note: the first client activation per process requires one human
 * approval (the browser executes the client half). The approval card appears
 * in the UI when the first session of a restarted DSH starts; afterwards the
 * grant covers future versions until the next restart.
 */
export const name = 'dsh-guide-dog-autoload'

// Guide Dog source repo (edit here if the checkout moves).
const SRC_DIR = '/home/tt-wsl-ubuntu/skills-repo/guide-dog-dsh'

export function apply(ctx) {
  const runner = ctx.get('dynamicCordisRunner')
  const agents = ctx.get('agents')
  if (!runner || !agents) {
    console.log('[gd-autoload] runner/agents unavailable, skipping')
    return
  }

  // Sessions we already attempted in this process (avoid duplicate deploys
  // from roots() + agent/created racing).
  const attempted = new Set()

  async function deploy(agent) {
    if (!agent || !agent.id || attempted.has(agent.id)) return
    attempted.add(agent.id) // mark before async work so racing events skip
    try {
      // Skip when this session already owns a guide-dog plugin (e.g. a
      // previous run of this deployer, or a manual deploy in the same process).
      let list = []
      try {
        if (typeof runner.inventory === 'function') list = runner.inventory()
      } catch (e) { list = [] }
      const owns = list.some((p) => p && p.sessionId === agent.id && String(p.pluginId || '').indexOf('gdog') === 0)
      if (owns) return

      const [hostSrc, clientSrc] = await Promise.all([
        readFile(pathToFileURL(SRC_DIR + '/plugin-host.js'), 'utf8'),
        readFile(pathToFileURL(SRC_DIR + '/plugin-client.js'), 'utf8'),
      ])
      const receipt = runner.define({
        sessionId: agent.id,
        plugin: { kind: 'new', idPrefix: 'gdog' },
        name: 'guide-dog (autoloaded)',
        purpose: '自动恢复（DSH 重启）：Guide Dog 多模态插件 — 视觉检查/生成/TTS/语音输入',
        code: { host: hostSrc, client: clientSrc },
      })
      const r = await runner.run(agent, receipt.pluginId, receipt.packageId, 'run')
      console.log('[gd-autoload] deployed ' + String(receipt.pluginId) + '/' + String(receipt.packageId) + ' status=' + String(r && r.status))
    } catch (e) {
      // Do NOT keep the failed session in `attempted` permanently: allow a
      // later agent/created to retry, but debounce within this tick.
      attempted.delete(agent.id)
      console.log('[gd-autoload] deploy failed for ' + String(agent && agent.id) + ': ' + String((e && e.message) || e))
    }
  }

  // New sessions: agents service announces each agent after registration.
  ctx.on('agent/created', (carrier, name, payload) => {
    const agent = (payload && payload.agent) || (carrier && carrier.agent) || carrier
    deploy(agent).catch(() => {})
  })

  // Sessions already live when this plugin activates (host starts after some
  // sessions exist, e.g. the web UI reconnects).
  try {
    const roots = typeof agents.roots === 'function' ? agents.roots() : []
    for (const a of roots) deploy(a).catch(() => {})
  } catch (e) { /* ignore */ }
}
