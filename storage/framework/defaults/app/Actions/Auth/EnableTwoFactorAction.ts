import { Action } from '@stacksjs/actions'
import { enableTwoFactor } from '@stacksjs/auth'
import { response } from '@stacksjs/router'
import { schema } from '@stacksjs/validation'

export default new Action({
  name: 'EnableTwoFactorAction',
  description: 'Verify a TOTP setup code and, if valid, persist the secret and enable 2FA',
  method: 'POST',

  validations: {
    secret: {
      rule: schema.string().min(16),
      message: 'A valid TOTP secret is required.',
    },
    code: {
      rule: schema.string().min(6).max(6),
      message: 'Code must be a 6-digit TOTP code.',
    },
  },

  async handle(request: RequestInstance) {
    const user = await request.user()
    if (!user)
      return response.unauthorized('Unauthorized')

    const secret = request.get('secret')
    const code = request.get('code')

    const enabled = await enableTwoFactor(user.id as number, secret, code)
    if (!enabled)
      return response.unauthorized('Invalid code — please check your authenticator app and try again.')

    return response.json({ enabled: true })
  },
})
