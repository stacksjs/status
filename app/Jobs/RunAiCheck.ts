import { ask } from '@stacksjs/ai'
import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
import AiCheck from '../Models/AiCheck'
import Incident from '../Models/Incident'
import Monitor from '../Models/Monitor'

const MAX_PAGE_TEXT_CHARS = 6000

/** Strips a page down to its visible text, via Bun's native HTMLRewriter. */
function extractText(html: string): string {
  let text = ''
  new HTMLRewriter()
    .on('script, style, noscript', {
      element(el) {
        el.remove()
      },
    })
    .on('body', {
      text(chunk) {
        text += chunk.text
      },
    })
    .transform(new Response(html))
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_PAGE_TEXT_CHARS)
}

/**
 * Natural-language monitoring: fetches the monitor's page, strips it to
 * visible text, and asks the configured AI model whether the user's
 * plain-English assertion holds — "the pricing page shows a 'Buy now'
 * button and no error text", "the page is in English", etc. Requires AI to
 * be configured (see stacks-ai / config/ai.ts); degrades gracefully (logs,
 * doesn't crash the check queue) when it isn't, same pattern as
 * RunLighthouseAudit's missing-Chrome path.
 */
export default new Job({
  name: 'RunAiCheck',
  description: 'Run a natural-language AI check for a monitor',
  queue: 'checks',
  tries: 1,
  timeout: 60,

  async handle(payload: { monitorId: number, aiCheckId: number }) {
    const monitor = await Monitor.find(payload.monitorId)
    const aiCheck = await AiCheck.find(payload.aiCheckId)
    if (!monitor || !aiCheck) {
      log.warn(`[job] RunAiCheck: monitor ${payload.monitorId} or check ${payload.aiCheckId} not found`)
      return
    }

    const checkedAt = new Date().toISOString()

    let pageText: string
    try {
      const response = await fetch(monitor.url, { signal: AbortSignal.timeout(15_000) })
      pageText = extractText(await response.text())
    }
    catch (error) {
      log.warn(`[job] RunAiCheck: could not fetch ${monitor.url}: ${error instanceof Error ? error.message : String(error)}`)
      return
    }

    const question = [
      'You are checking a live webpage against a monitoring assertion.',
      `Page content (truncated): """${pageText}"""`,
      `Assertion to verify: "${aiCheck.prompt}"`,
      'Respond with exactly one line starting with PASS or FAIL, followed by a one-sentence reason.',
    ].join('\n\n')

    let answer: string
    try {
      answer = await ask(question)
    }
    catch (error) {
      log.warn(`[job] RunAiCheck: AI provider unavailable or unconfigured — ${error instanceof Error ? error.message : String(error)}`)
      return
    }

    const passed = /^PASS/i.test(answer.trim())

    await aiCheck.update({
      last_result: answer.trim().slice(0, 2000),
      last_passed: passed,
      last_checked_at: checkedAt,
    })

    if (!passed) {
      await Incident.create({
        monitor_id: monitor.id,
        started_at: checkedAt,
        cause: `AI check failed: ${aiCheck.prompt} — ${answer.trim()}`,
        status: 'investigating',
        impacted_checks: JSON.stringify([{ type: 'ai_check', prompt: aiCheck.prompt, answer }]),
      })
      log.warn(`[job] RunAiCheck: ${monitor.name} — assertion failed: ${aiCheck.prompt}`)
    }
  },
})
