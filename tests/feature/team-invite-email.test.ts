import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { awaitConfig, config } from '@stacksjs/config'
import { CaptureEmailDriver } from '@stacksjs/email/drivers/capture.ts'
import DashboardInviteTeamMemberAction from '../../app/Actions/Teams/DashboardInviteTeamMemberAction'
import InviteTeamMemberAction from '../../app/Actions/Teams/InviteTeamMemberAction'
import TeamMember from '../../app/Models/TeamMember'

// See monitor-crud.test.ts's TEAM_ID comment — each feature test file
// isolates its fixtures under its own team_id.
const TEAM_ID = 90005

describe('Team invite email delivery (stacksjs/status#1 Phase 9 follow-up)', () => {
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

  test('a dashboard form invite emails the token and redirects back to the same team', async () => {
    const request = { get: (key: string) => ({ id: String(TEAM_ID), email: 'form-invitee@example.com', role: 'member' } as Record<string, string>)[key] }

    const response = await DashboardInviteTeamMemberAction.handle(request as any)
    expect(response.status).toBe(302)
    // The redirect must carry the team context — a bare Location here was
    // the bug fixed alongside this feature (team.stx defaults TEAM_ID to 1).
    expect(response.headers.get('Location')).toBe(`/dashboard/settings/team?team_id=${TEAM_ID}`)

    const member = await TeamMember.where('team_id', TEAM_ID).where('invited_email', 'form-invitee@example.com').first()
    expect(member).toBeTruthy()
    createdIds.push(member!.id)

    const sent = CaptureEmailDriver.all()
    expect(sent).toHaveLength(1)
    expect(sent[0]!.to).toBe('form-invitee@example.com')
    expect(String(sent[0]!.text)).toContain(member!.uuid)

    // Re-submitting the form neither duplicates the row nor re-sends.
    const again = await DashboardInviteTeamMemberAction.handle(request as any)
    expect(again.status).toBe(302)
    expect((await TeamMember.where('team_id', TEAM_ID).where('invited_email', 'form-invitee@example.com').get()).length).toBe(1)
    expect(CaptureEmailDriver.all()).toHaveLength(1)
  })
})
