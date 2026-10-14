import type { WorkflowClient } from '@temporalio/client'
import type { Logger } from '@comprova/observability'

export interface DeepTriggerConfig {
  readonly enabled: boolean
  readonly address: string
  readonly namespace: string
  readonly taskQueue: string
}

export interface DeepTriggerDeps {
  readonly config: DeepTriggerConfig
  readonly logger: Logger
}

interface LazyClient {
  readonly client: WorkflowClient
}

const getClient = async (deps: DeepTriggerDeps): Promise<LazyClient | null> => {
  if (!deps.config.enabled) return null
  try {
    const { Connection, WorkflowClient } = await import('@temporalio/client')
    const connection = await Connection.connect({
      address: deps.config.address,
      connectTimeout: 3_000,
    })
    return {
      client: new WorkflowClient({ connection, namespace: deps.config.namespace }),
    }
  } catch (err) {
    deps.logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'temporal unavailable, deep path stays partial',
    )
    return null
  }
}

export interface DeepWorkflowInput {
  readonly tenantId: string
  readonly validationId: string
}

export const startDeepWorkflow = async (
  deps: DeepTriggerDeps,
  input: DeepWorkflowInput,
): Promise<string | null> => {
  const lazy = await getClient(deps)
  if (lazy === null) return null
  try {
    const handle = await lazy.client.start('deepValidationWorkflow', {
      args: [input],
      taskQueue: deps.config.taskQueue,
      workflowId: `deep-${input.validationId}`,
    })
    return handle.workflowId
  } catch (err) {
    deps.logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        validation_id: input.validationId,
      },
      'failed to start deep workflow; validation stays queued/partial',
    )
    return null
  }
}
