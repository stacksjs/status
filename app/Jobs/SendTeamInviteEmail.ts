import process from 'node:process'
import { config } from '@stacksjs/config'
import { mail } from '@stacksjs/email'
import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
import Team from '../../storage/framework/defaults/app/Models/Team'

/** Absolute base URL for links in emails, from APP_URL (scheme optional). */
function appBaseUrl(): string {
  const raw = String(process.env.APP_URL || 'uptime-status.org').replace(/\/$/, '')
  return /^https?:\/\//.test(raw) ? raw : `https://${raw}`
}

/**
 * Emails a team invite to the invited address. The invite `uuid` is the
 * acceptance capability, delivered as a link to the browser accept page
 * (resources/views/invite/[uuid].stx -> AcceptInviteFormAction), which
 * links or registers the user, activates the membership, and signs them
 * in. The link is also printed as plain text so it survives text-only
 * clients.
 */
export default new Job({
  name: 'SendTeamInviteEmail',
  description: 'Email a team invite with its acceptance token',
  queue: 'emails',
  tries: 3,
  backoff: 60,
  timeout: 30,

  async handle(payload: { email: string, teamId: number, role: string, inviteUuid: string }) {
    const { email, teamId, role, inviteUuid } = payload

    if (!email || !inviteUuid) {
      log.warn('[job] SendTeamInviteEmail: missing email or invite uuid')
      return
    }

    const team = await Team.find(teamId)
    const teamName = team?.name || 'a team'
    const appName = config.app.name || 'Status'
    const acceptUrl = `${appBaseUrl()}/invite/${inviteUuid}`

    // mail.send never throws on transport failure — drivers catch
    // internally and resolve { success: false } — so without this check a
    // failed send would complete the job "successfully", `tries: 3` would
    // never engage, and the invite link (whose only delivery channel is
    // this email) would be silently lost. Throwing hands the failure to
    // the queue layer for retry; the dispatching actions catch it so an
    // invite request never 500s over a mail hiccup on the sync driver.
    const result = await mail.send({
      to: email,
      subject: `You've been invited to join ${teamName} on ${appName}`,
      text: [
        `You've been invited to join ${teamName} on ${appName} as ${role}.`,
        '',
        `Accept your invite and view the dashboard:`,
        acceptUrl,
        '',
        `If you weren't expecting this invite, you can ignore this email.`,
      ].join('\n'),
      html: [
        `<p>You've been invited to join <strong>${teamName}</strong> on ${appName} as <strong>${role}</strong>.</p>`,
        `<p><a href="${acceptUrl}" style="display:inline-block;padding:10px 18px;border-radius:10px;background:#2563eb;color:#ffffff;font-weight:600;text-decoration:none">Accept invite</a></p>`,
        `<p style="color:#5c6864;font-size:13px">Or paste this link into your browser:<br><a href="${acceptUrl}">${acceptUrl}</a></p>`,
        `<p style="color:#5c6864;font-size:13px">If you weren't expecting this invite, you can ignore this email.</p>`,
      ].join('\n'),
    })

    if (!result.success)
      throw new Error(`[job] SendTeamInviteEmail: send to ${email} failed: ${result.message}`)

    log.debug(`[job] SendTeamInviteEmail: invite for team ${teamId} sent to ${email}`)
  },
})
