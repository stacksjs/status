import { ask } from '@stacksjs/ai'
import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
import AiCheck from '../Models/AiCheck'
import Incident from '../Models/Incident'
import { openIncident } from '../lib/maintenance'
import IncidentUpdate from '../Models/IncidentUpdate'
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

    // The AI check's own open incident, if any. Down paths dedup against it so
    // a persistently unreachable or failing target opens (and notifies) once
    // rather than every minute DispatchDueChecks fans the check out, and a
    // later pass resolves it. Scoped to this check type via impacted_checks so
    // it never touches an unrelated incident on the same monitor.
    const findOpenAiIncident = async () =>
      (await Incident.where('monitor_id', monitor.id).where('status', '!=', 'resolved').get())
        .find((incident) => {
          try {
            return JSON.parse(incident.impacted_checks || '[]')[0]?.type === 'ai_check'
          }
          catch {
            return false
          }
        })

    // Records a down verdict on the check and opens an incident, unless one is
    // already open (dedup). Used for both the unreachable and HTTP-error paths.
    const recordDown = async (result: string, impacted: Record<string, unknown>): Promise<void> => {
      await aiCheck.update({ last_result: result.slice(0, 2000), last_passed: false, last_checked_at: checkedAt })
      if (await findOpenAiIncident())
        return
      await openIncident({
        monitor_id: monitor.id,
        started_at: checkedAt,
        cause: result.slice(0, 500),
        status: 'investigating',
        impacted_checks: JSON.stringify([{ type: 'ai_check', prompt: aiCheck.prompt, ...impacted }]),
      })
    }

    // The AI evaluation only makes sense against a page we actually fetched:
    // a target that is unreachable, or that answers with an HTTP error, is
    // down BEFORE the model ever sees it, so alert on those instead of feeding
    // an error page (or nothing) to the model.
    let response: Response
    try {
      response = await fetch(monitor.url, { signal: AbortSignal.timeout(15_000) })
    }
    catch (error) {
      const message = `AI check target unreachable: ${monitor.url} - ${error instanceof Error ? error.message : String(error)}`
      log.warn(`[job] RunAiCheck: ${message}`)
      await recordDown(message, { error: error instanceof Error ? error.message : String(error) })
      return
    }

    if (!response.ok) {
      const message = `AI check target returned HTTP ${response.status}: ${monitor.url}`
      log.warn(`[job] RunAiCheck: ${monitor.name} - ${message}`)
      await recordDown(message, { status: response.status })
      return
    }

    const pageText = extractText(await response.text())

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
      if (!(await findOpenAiIncident())) {
        await openIncident({
          monitor_id: monitor.id,
          started_at: checkedAt,
          cause: `AI check failed: ${aiCheck.prompt} - ${answer.trim()}`.slice(0, 500),
          status: 'investigating',
          impacted_checks: JSON.stringify([{ type: 'ai_check', prompt: aiCheck.prompt, answer }]),
        })
      }
      log.warn(`[job] RunAiCheck: ${monitor.name} - assertion failed: ${aiCheck.prompt}`)
      return
    }

    // Passed: clear any open AI incident so the recovery notification fires.
    const open = await findOpenAiIncident()
    if (open) {
      await open.update({ status: 'resolved', resolved_at: checkedAt })
      await IncidentUpdate.create({
        incident_id: open.id,
        message: 'AI check is passing again.',
        status: 'resolved',
        posted_at: checkedAt,
      })
    }
  },
})
