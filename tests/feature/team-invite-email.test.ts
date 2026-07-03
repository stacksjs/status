import { afterEach, describe, expect, test } from 'bun:test'
import { config } from '@stacksjs/config'
import { CaptureEmailDriver } from '@stacksjs/email/drivers/capture.ts'
import InviteTeamMemberAction from '../../app/Actions/Teams/InviteTeamMemberAction'
import TeamMember from '../../app/Models/TeamMember'

// Swap the mail driver for the in-memory capture driver (the pattern its
// own docblock documents) — QUEUE_DRIVER=sync runs the dispatched
// SendTeamInviteEmail inline, so the capture store fills synchronously
// and no SMTP socket is ever opened. Set at module level and deliberately
// never restored: the Mail singleton latches whatever driver name
// config.email.default holds at its FIRST send, so an afterAll restore
// would open a window where another mail-sending test file's first send
// constructs the singleton against the real smtp driver (Bun runs test
// files concurrently — see the stacksjs/stacks fix serializing exactly
// this kind of process-wide config mutation across test files).
;(config.email as { default: string }).default = 'capture'

// See monitor-crud.test.ts's TEAM_ID comment — each feature test file
// isolates its fixtures under its own team_id since Bun runs test files
// concurrently by default.
const TEAM_ID = 90005

describe('Team invite email delivery (stacksjs/status#1 Phase 9 follow-up)', () => {
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
})
