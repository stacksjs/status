import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { Auth } from '@stacksjs/auth'
import { awaitConfig, config } from '@stacksjs/config'
import { db } from '@stacksjs/database'
import { CaptureEmailDriver } from '@stacksjs/email/drivers/capture.ts'
import DashboardInviteTeamMemberAction from '../../app/Actions/Teams/DashboardInviteTeamMemberAction'
import InviteTeamMemberAction from '../../app/Actions/Teams/InviteTeamMemberAction'
import TeamMember from '../../app/Models/TeamMember'

// See monitor-crud.test.ts's TEAM_ID comment — each feature test file
// isolates its fixtures under its own team_id.
const TEAM_ID = 90005
const OWNER_EMAIL = 'team-invite-owner-90005@example.com'

describe('Team invite email delivery (stacksjs/status#1 Phase 9 follow-up)', () => {
  // Real user/team/owner-membership fixtures for the dashboard-form
  // action, which derives the team from the requester's credential
  // (@stacksjs/auth's team resolution) rather than trusting the route's id field.
  // Mirrors billing-checkout.test.ts's beforeAll/afterAll pattern;
  // `teams.id` is autoincrement, not TEAM_ID itself.
  let ownerUserId: number
  let realTeamId: number
  let ownerToken: string
  // Swap the mail driver for the in-memory capture driver (the pattern
  // its own docblock documents) — QUEUE_DRIVER=sync runs the dispatched
  // SendTeamInviteEmail inline, so the capture store fills synchronously
  // and no SMTP socket is ever opened. Two timing rules make this safe:
  // the write must happen AFTER awaitConfig() (project config files load
  // asynchronously and replace overrides.email wholesale, so a
  // module-evaluation-time write lands on the defaults layer and gets
  // shadowed by config/email.ts's MAIL_MAILER=smtp once the loader
  // finishes), and it is deliberately never restored (the Mail singleton
  // latches whatever driver name config.email.default holds at its FIRST
  // send; 'capture' is the safe terminal state for a test process).
  beforeAll(async () => {
    await awaitConfig()
    ;(config.email as { default: string }).default = 'capture'

    await db.insertInto('teams').values({ name: `Team Invite Test Team ${TEAM_ID}` }).execute()
    const team = await db.selectFrom('teams').where('name', '=', `Team Invite Test Team ${TEAM_ID}`).select(['id']).executeTakeFirst()
    realTeamId = Number(team!.id)

    await db.insertInto('users').values({ name: 'Team Invite Owner', email: OWNER_EMAIL, password: 'x'.repeat(10) }).execute()
    const user = await db.selectFrom('users').where('email', '=', OWNER_EMAIL).select(['id']).executeTakeFirst()
    ownerUserId = Number(user!.id)

    await db.insertInto('team_members').values({
      team_id: realTeamId,
      user_id: ownerUserId,
      role: 'owner',
      status: 'active',
      invited_email: OWNER_EMAIL,
    }).execute()

    // No refresh token: keeps cleanup to the single access-token row.
    const login = await Auth.loginUsingId(ownerUserId, { withRefreshToken: false })
    ownerToken = String(login!.token)
  })

  afterAll(async () => {
    await db.deleteFrom('oauth_access_tokens').where('user_id', '=', ownerUserId).execute()
    await db.deleteFrom('team_members').where('team_id', '=', realTeamId).execute()
    await db.deleteFrom('teams').where('id', '=', realTeamId).execute()
    await db.deleteFrom('users').where('id', '=', ownerUserId).execute()
  })

  const createdIds: number[] = []

  afterEach(async () => {
    CaptureEmailDriver.clear()
    for (const id of createdIds.splice(0)) {
      const member = await TeamMember.find(id)
      if (member) await member.delete()
    }
  })

  test('a new invite emails the invited address its acceptance token', async () => {
    const request = { get: (key: string) => ({ id: String(TEAM_ID), email: 'Invitee@Example.com', role: 'admin' } as Record<string, string>)[key] }
    const response = await InviteTeamMemberAction.handle(request as any)
    expect(response.status).toBe(201)

    const member = await response.json() as { id: number, uuid: string, invited_email: string }
    createdIds.push(member.id)
    expect(member.uuid).toBeTruthy()

    const sent = CaptureEmailDriver.all()
    expect(sent).toHaveLength(1)
    // The action lowercases the address before persisting and emailing.
    expect(sent[0]!.to).toBe('invitee@example.com')
    expect(sent[0]!.subject).toContain('invited')
    expect(String(sent[0]!.text)).toContain(member.uuid)
  })

  test('re-inviting an already-invited address does not re-send the email', async () => {
    const request = { get: (key: string) => ({ id: String(TEAM_ID), email: 'repeat@example.com', role: 'member' } as Record<string, string>)[key] }

    const first = await InviteTeamMemberAction.handle(request as any)
    expect(first.status).toBe(201)
    createdIds.push(((await first.json()) as { id: number }).id)
    expect(CaptureEmailDriver.all()).toHaveLength(1)

    const second = await InviteTeamMemberAction.handle(request as any)
    expect(second.status).toBe(200)
    expect(CaptureEmailDriver.all()).toHaveLength(1)
  })

  test('an authed dashboard form invite emails the token and redirects back to the authed team', async () => {
    // The dashboard action derives the team from the bearer credential;
    // the route's id field is only checked for parity with it, so the
    // request authenticates as the owner and posts the matching id.
    const request = {
      get: (key: string) => ({ id: String(realTeamId), email: 'form-invitee@example.com', role: 'member' } as Record<string, string>)[key],
      bearerToken: () => ownerToken,
      cookies: { get: () => undefined },
    }

    const response = await DashboardInviteTeamMemberAction.handle(request as any)
    expect(response.status).toBe(302)
    // The redirect must carry the AUTHED team's context (a bare Location
    // here was the bug fixed alongside this feature; team.stx defaults
    // TEAM_ID to 1), and the id is now the credential's team, never the
    // posted field.
    expect(response.headers.get('Location')).toBe(`/dashboard/settings/team?team_id=${realTeamId}`)

    const member = await TeamMember.where('team_id', realTeamId).where('invited_email', 'form-invitee@example.com').first()
    expect(member).toBeTruthy()
    createdIds.push(member!.id)

    const sent = CaptureEmailDriver.all()
    expect(sent).toHaveLength(1)
    expect(sent[0]!.to).toBe('form-invitee@example.com')
    expect(String(sent[0]!.text)).toContain(member!.uuid)

    // Re-submitting the form neither duplicates the row nor re-sends.
    const again = await DashboardInviteTeamMemberAction.handle(request as any)
    expect(again.status).toBe(302)
    expect((await TeamMember.where('team_id', realTeamId).where('invited_email', 'form-invitee@example.com').get()).length).toBe(1)
    expect(CaptureEmailDriver.all()).toHaveLength(1)
  })
})
