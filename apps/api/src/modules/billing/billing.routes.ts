import type { ZodTypeProvider } from '@fastify/type-provider-zod'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'

export type BillingRoutesDeps = {
  readonly db: import('@comprova/db').Db
  readonly providerRegistry: import('@comprova/billing-core').ProviderRegistry
}

export const registerBillingRoutes = (
  instance: FastifyInstance,
  deps: {
    readonly db: import('@comprova/db').Db
    readonly providerRegistry: import('@comprova/billing-core').ProviderRegistry
  },
): void => {
  const app = instance.withTypeProvider<ZodTypeProvider>()

  // Stripe webhook endpoint — raw body needed for signature verification
  // fastify-raw-body plugin adds rawBody config
  app.post(
    '/billing/webhooks',
    {
      config: { rawBody: true } as any,
      schema: {
        body: z.string(),
        response: {
          200: z.object({ received: z.boolean() }),
          400: z.object({ type: z.string(), title: z.string(), status: z.number() }),
        },
      },
    },
    async (request: FastifyRequest<{ Body: string }>, reply) => {
      const { makeBillingController } = await import('./billing.controller.js')

      const controller = makeBillingController({ db: deps.db, providerRegistry: deps.providerRegistry })
      const rawBody = request.body
      const signature = request.headers['stripe-signature'] as string | undefined

      return controller.handleStripeWebhook(rawBody, signature, reply)
    },
  )
}
