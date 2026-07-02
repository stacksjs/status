import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import StatusPageSubscriber from '../../Models/StatusPageSubscriber'

/** Public, unauthenticated: GET /status/{slug}/unsubscribe/{token}. */
export default new Action({
  name: 'UnsubscribeAction',
  description: 'Remove a status page subscriber via their unsubscribe token',

  async handle(request) {
    const token = request.get('token')
    const subscriber = await StatusPageSubscriber.where('unsubscribe_token', token).first()

    if (!subscriber)
      return response.json({ success: false, message: 'Invalid unsubscribe link' }, { status: 404 })

    await subscriber.delete()
    return { success: true, message: 'Unsubscribed' }
  },
})
