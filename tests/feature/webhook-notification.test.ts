import type { Server } from 'bun'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { awaitConfig } from '@stacksjs/config'
import SendNotification from '../../app/Jobs/SendNotification'
import NotificationChannel from '../../app/Models/NotificationChannel'

// See monitor-crud.test.ts's TEAM_ID comment — each feature test file
// isolates its fixtures under its own team_id.
const TEAM_ID = 90011

/**
 * Pins the generic Webhook channel's POST body against the shape documented
 * in docs/operate/notifications.md: an incident notification carries the
 * structured { event, monitor, incident } context, while a standalone notice
 * omits them and sends just severity/subject/message. Drives the real
 * SendNotification job against a throwaway localhost endpoint so the fetch
 * path (JSON body + config.headers) is exercised end to end.
 */
describe('Webhook notification payload (stacksjs/status#1)', () => {
  let server: Server
  const received: Array<{ body: any, headers: Record<string, string> }> = []
  const cleanup: { delete: () => Promise<unknown> }[] = []

  beforeAll(async () => {
    await awaitConfig()
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        received.push({ body: await req.json(), headers: Object.fromEntries(req.headers) })
        return new Response('ok')
      },
    })
  })

  afterAll(() => {
    server.stop(true)
  })

  afterEach(async () => {
    received.length = 0
    for (const record of cleanup.splice(0).reverse())
      await record.delete()
  })

  async function makeWebhookChannel(extraConfig: Record<string, unknown> = {}) {
    const channel = await NotificationChannel.create({
      team_id: TEAM_ID,
      name: 'Webhook test',
      type: 'webhook',
      config: JSON.stringify({ url: `http://localhost:${server.port}/hook`, ...extraConfig }),
      enabled: true,
    })
    cleanup.push(channel)
    return channel
  }

  test('an incident notification posts the documented structured body', async () => {
    const channel = await makeWebhookChannel()

    await SendNotification.handle({
      channelId: channel.id,
      subject: '🔴 API is down',
      message: 'A uptime check failed for https://api.example.com/health.',
      severity: 'critical',
      event: 'incident.opened',
      monitor: { id: 42, name: 'API', url: 'https://api.example.com/health' },
      incident: { id: 1087, status: 'investigating', started_at: '2026-07-06T14:22:05Z' },
    })

    expect(received).toHaveLength(1)
    expect(received[0]!.body).toEqual({
      event: 'incident.opened',
      severity: 'critical',
      subject: '🔴 API is down',
      message: 'A uptime check failed for https://api.example.com/health.',
      monitor: { id: 42, name: 'API', url: 'https://api.example.com/health' },
      incident: { id: 1087, status: 'investigating', started_at: '2026-07-06T14:22:05Z' },
    })
  })

  test('a standalone notice omits event/monitor/incident', async () => {
    const channel = await makeWebhookChannel()

    await SendNotification.handle({
      channelId: channel.id,
      subject: 'SSL certificate expiring',
      message: 'The certificate for example.com expires in 7 days.',
      severity: 'warning',
    })

    expect(received).toHaveLength(1)
    expect(received[0]!.body).toEqual({
      severity: 'warning',
      subject: 'SSL certificate expiring',
      message: 'The certificate for example.com expires in 7 days.',
    })
    // JSON.stringify drops the undefined structured fields entirely.
    expect(received[0]!.body).not.toHaveProperty('event')
    expect(received[0]!.body).not.toHaveProperty('monitor')
    expect(received[0]!.body).not.toHaveProperty('incident')
  })

  test('configured custom headers are forwarded with the POST', async () => {
    const channel = await makeWebhookChannel({ headers: { 'X-Webhook-Token': 'secret-123' } })

    await SendNotification.handle({
      channelId: channel.id,
      subject: 'Recovered',
      message: 'All clear.',
      severity: 'info',
      event: 'incident.resolved',
      monitor: { id: 7, name: 'Site', url: 'https://example.com' },
      incident: { id: 3, status: 'resolved', started_at: '2026-07-06T14:22:05Z' },
    })

    expect(received).toHaveLength(1)
    expect(received[0]!.headers['x-webhook-token']).toBe('secret-123')
    expect(received[0]!.headers['content-type']).toContain('application/json')
    expect(received[0]!.body.event).toBe('incident.resolved')
  })
})
