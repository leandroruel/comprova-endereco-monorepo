import { z } from 'zod'

export const CreateWebhookSchema = z.object({
  url: z.url(),
  events: z.array(z.string().min(3)).min(1).default(['validation.completed']),
  active: z.boolean().default(true),
})
export type CreateWebhookBody = z.infer<typeof CreateWebhookSchema>

export const WebhookEndpointDto = z.object({
  endpoint_id: z.uuid(),
  url: z.string(),
  events: z.array(z.string()),
  active: z.boolean(),
})

export const CreateWebhookResponse = z.object({ endpoint_id: z.uuid(), secret: z.string() })
export const ListWebhooksResponse = z.object({ endpoints: z.array(WebhookEndpointDto) })
export const DeleteWebhookResponse = z.object({ deleted: z.boolean() })
export const WebhookIdParams = z.object({ id: z.uuid() })
