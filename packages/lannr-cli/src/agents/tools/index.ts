import { loadAgentPlugins } from '../../plugins/loader.js'
import { loadMcpTools } from '../../plugins/mcp/bridge.js'
import { createAgentTools } from './agents.js'
import { createBashTools } from './bash.js'
import { createBrowserTools } from './browser.js'
import { createCheckpointTools } from './checkpoint.js'
import { createClarifyTools } from './clarify.js'
import { createEditTools } from './edit.js'
import { createFileTools } from './files.js'
import { createMemoryTools } from './memory.js'
import { createRoutineTools } from './routines.js'
import { createScheduleTools } from './schedule.js'
import { createTodoTools } from './todo.js'
import { createWebTools } from './web.js'

export async function createWorkspaceTools(ctx) {
  return [
    ...createFileTools(ctx),
    ...createEditTools(ctx),
    ...createBashTools(ctx),
    ...createWebTools(ctx),
    ...createBrowserTools(ctx),
    ...createAgentTools(ctx),
    ...createScheduleTools(ctx),
    ...createMemoryTools(ctx),
    ...createRoutineTools(ctx),
    ...createTodoTools(ctx),
    ...createCheckpointTools(ctx),
    ...createClarifyTools(ctx),
    ...(await loadAgentPlugins(ctx)),
    ...(await loadMcpTools(ctx)),
  ]
}
