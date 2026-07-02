import { Action } from '@stacksjs/actions'
import { mail } from '@stacksjs/email'
import { response } from '@stacksjs/router'
import StatusPage from '../../Models/StatusPage'
import StatusPageSubscriber from '../../Models/StatusPageSubscriber'

/**
 * Public, unauthenticated endpoint: POST /status/{slug}/subscribe. No
 * confirmation email flow (double opt-in) yet — subscribes immediately.
 * Revisit if this ships to real users; email subscription without
 * confirmation is a spam vector.
 */
export default new Action({
  name: 'SubscribeAction',
  description: 'Subscribe an email address to a status page\'s incident notifications',

  async handle(request) {
    const slug = request.get('slug')
    const email = request.get('email')

    if (!email || typeof email !== 'string' || !email.includes('@'))
      return response.json({ success: false, message: 'A valid email address is required' }, { status: 422 })

    const statusPage = await StatusPage.where('slug', slug).where('is_public', true).first()
    if (!statusPage)
      return response.json({ success: false, message: 'Status page not found' }, { status: 404 })

    const existing = await StatusPageSubscriber.where('status_page_id', statusPage.id).where('email', email).first()
    if (existing)
      return { success: true, message: 'Already subscribed' }

    const subscriber = await StatusPageSubscriber.create({
      status_page_id: statusPage.id,
      email,
      confirmed_at: new Date().toISOString(),
    })

    await mail.send({
      to: email,
      subject: `Subscribed to ${statusPage.title}`,
      text: `You'll now be emailed about incidents on ${statusPage.title}. Unsubscribe: /status/${slug}/unsubscribe/${subscriber.unsubscribe_token}`,
      html: `<p>You'll now be emailed about incidents on ${statusPage.title}.</p><p><a href="/status/${slug}/unsubscribe/${subscriber.unsubscribe_token}">Unsubscribe</a></p>`,
    }).catch(() => {
      // Best-effort confirmation email — the subscription itself already
      // succeeded, don't fail the request over a mail-delivery hiccup.
    })

    return { success: true, message: 'Subscribed' }
  },
})
