import { config } from '@stacksjs/config'
import { mail } from '@stacksjs/email'
import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
import Team from '../../storage/framework/defaults/app/Models/Team'

/**
 * Emails a team invite to the invited address (stacksjs/status#1 Phase 9
 * follow-up — invites used to be created silently and the acceptance
 * token had to be shared manually). The invite `uuid` IS the acceptance
 * token: acceptance is `POST /team-invites/{uuid}/accept` (see
 * AcceptTeamInviteAction). There is no browser-facing accept page yet —
 * that's gated on real dashboard auth (the deferred Phase 9 item), so
 * the email carries the token itself rather than a link that would 404
 * today.
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

    // mail.send never throws on transport failure — drivers catch
    // internally and resolve { success: false } — so without this check a
    // failed send would complete the job "successfully", `tries: 3` would
    // never engage, and the acceptance token (whose only delivery channel
    // is this email) would be silently lost. Throwing hands the failure to
    // the queue layer for retry; the dispatching actions catch it so an
    // invite request never 500s over a mail hiccup on the sync driver.
    const result = await mail.send({
      to: email,
      subject: `You've been invited to join ${teamName} on ${appName}`,
      text: [
        `You've been invited to join ${teamName} on ${appName} as ${role}.`,
        '',
        `Your acceptance token: ${inviteUuid}`,
        '',
        `To accept, an authenticated API client POSTs to /team-invites/${inviteUuid}/accept with your user id.`,
        `If you weren't expecting this invite, you can ignore this email.`,
      ].join('\n'),
      html: [
        `<p>You've been invited to join <strong>${teamName}</strong> on ${appName} as <strong>${role}</strong>.</p>`,
        `<p>Your acceptance token: <code>${inviteUuid}</code></p>`,
        `<p>To accept, an authenticated API client POSTs to <code>/team-invites/${inviteUuid}/accept</code> with your user id.</p>`,
        `<p>If you weren't expecting this invite, you can ignore this email.</p>`,
      ].join('\n'),
    })

    if (!result.success)
      throw new Error(`[job] SendTeamInviteEmail: send to ${email} failed: ${result.message}`)

    log.debug(`[job] SendTeamInviteEmail: invite for team ${teamId} sent to ${email}`)
  },
})
