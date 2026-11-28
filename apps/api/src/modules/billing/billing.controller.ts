import { PROBLEM_CONTENT_TYPE, problems } from '@comprova/contracts'
import type { FastifyReply } from 'fastify'
import { processStripeWebhook, type BillingServiceDeps } from './billing.service.js'

export interface BillingController {
  readonly handleStripeWebhook: (
    rawBody: string,
    stripeSignature: string | undefined,
    reply: FastifyReply,
  ) => Promise<FastifyReply | { received: boolean }>
}

export const makeBillingController = (deps: BillingServiceDeps) => ({
  handleStripeWebhook: async (rawBody: string, stripeSignature: string | undefined, reply: FastifyReply) => {
    if (!stripeSignature) {
      return reply
        .code(400)
        .type(PROBLEM_CONTENT_TYPE)
        .send(problems.unauthorized('Missing stripe-signature header'))
    }

    const stripeProvider = deps.providerRegistry.get('stripe')

    try {
      // 1. Constrói o evento validando a assinatura
      const providerEvent = stripeProvider.constructEvent(rawBody, stripeSignature)

      // 2. Normaliza para o formato interno
      const normalizedEvent = stripeProvider.parseWebhookEvent(providerEvent)

      // 3. Processa via SubscriptionService (idempotente, com tenant resolution)
      await processStripeWebhook(deps, normalizedEvent)

      return reply.code(200).send({ received: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Stripe recomenda não expor detalhes internos no erro do webhook
      reply.log.warn({ err: message }, 'Stripe webhook processing failed')
      return reply
        .code(400)
        .type(PROBLEM_CONTENT_TYPE)
        .send(problems.unauthorized('Webhook processing failed'))
    }
  },
})
