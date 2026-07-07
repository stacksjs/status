import { Action } from '@stacksjs/actions'
import { resolveAuthenticatedTeamId } from '@stacksjs/auth'
import { randomUUIDv7 } from 'bun'
import { db } from '@stacksjs/database'
import { encryptSecret } from './cloudCrypto'

/**
 * `POST /cloud-credential-forms/aws` — dashboard settings form to store the
 * team's AWS credentials for platform automation (EC2 metrics-agent
 * provisioning via Instance Connect). Upserts the single (team, 'aws') row.
 *
 * The secret access key is encrypted at rest (AES-256-GCM under APP_KEY); the
 * access key id and region are non-secret. A blank secret field on resubmit
 * means "keep the existing secret" — so the operator can change the region or
 * key id without re-pasting the secret every time (and the page never has to
 * echo the secret back into an input to preserve it).
 */
export default new Action({
  name: 'SaveAwsCredentialsAction',
  description: 'Save AWS credentials for platform automation',
  method: 'POST',

  async handle(request: RequestInstance) {
    const teamId = await resolveAuthenticatedTeamId(request)
    if (!teamId)
      return new Response(null, { status: 302, headers: { Location: '/login' } })

    const accessKeyId = String(request.get('access_key_id') ?? '').trim()
    const secret = String(request.get('secret_access_key') ?? '').trim()
    const region = String(request.get('region') ?? '').trim() || 'us-east-1'

    const back = (q: string) => new Response(null, { status: 302, headers: { Location: `/dashboard/settings/cloud${q}` } })

    if (!accessKeyId)
      return back('?error=access_key_required')

    const existing = await db.selectFrom('cloud_credentials')
      .where('team_id', '=', teamId).where('provider', '=', 'aws').selectAll().execute()
    const current = existing[0]

    // Blank secret on an existing row => keep the stored secret.
    if (!secret && !current)
      return back('?error=secret_required')

    const now = new Date().toISOString()
    if (current) {
      const patch: Record<string, unknown> = { access_key_id: accessKeyId, region, updated_at: now }
      if (secret)
        patch.secret_access_key_encrypted = encryptSecret(secret)
      await db.updateTable('cloud_credentials').set(patch).where('id', '=', current.id).execute()
    }
    else {
      await db.insertInto('cloud_credentials').values({
        team_id: teamId,
        provider: 'aws',
        access_key_id: accessKeyId,
        secret_access_key_encrypted: encryptSecret(secret),
        region,
        created_at: now,
        updated_at: now,
        uuid: randomUUIDv7(),
      }).execute()
    }

    return back('?saved=1')
  },
})
