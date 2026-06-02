import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeProviderId } from './registry.js'

const HERE = dirname(fileURLToPath(import.meta.url))

const KNOWN_PROVIDER_DEFAULTS = {
  'amazon-bedrock': {
    type: 'bedrock',
    apiKeyEnv: 'AWS_ACCESS_KEY_ID',
    defaultModel: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    unsupportedReason: 'requires AWS SigV4/OpenClaw Bedrock plugin runtime',
  },
  'amazon-bedrock-mantle': {
    type: 'bedrock',
    apiKeyEnv: 'AWS_ACCESS_KEY_ID',
    defaultModel: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    unsupportedReason: 'requires AWS SigV4/OpenClaw Bedrock Mantle plugin runtime',
  },
  openai: {
    type: 'openai-compatible',
    baseURL: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    endpoint: 'responses',
    defaultModel: 'gpt-4.1',
  },
  'openai-codex': {
    type: 'openai-compatible',
    baseURL: 'https://chatgpt.com/backend-api/codex',
    endpoint: 'codex-responses',
    defaultModel: 'gpt-5.4-pro',
  },
  anthropic: {
    type: 'anthropic',
    baseURL: 'https://api.anthropic.com',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    defaultModel: 'claude-sonnet-4-5',
  },
  'anthropic-vertex': {
    type: 'anthropic',
    baseURL: 'https://aiplatform.googleapis.com',
    apiKeyEnv: 'GOOGLE_APPLICATION_CREDENTIALS',
    defaultModel: 'claude-sonnet-4-6',
  },
  google: {
    type: 'google',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    apiKeyEnv: 'GOOGLE_API_KEY',
    defaultModel: 'gemini-3.1-pro-preview',
  },
  'google-vertex': {
    type: 'google-vertex',
    apiKeyEnv: 'GOOGLE_API_KEY',
    defaultModel: 'gemini-3.1-pro-preview',
    unsupportedReason: 'requires Google Vertex project/location credentials',
  },
  'cloudflare-ai-gateway': {
    type: 'openai-compatible',
    apiKeyEnv: 'CLOUDFLARE_AI_GATEWAY_API_KEY',
    defaultModel: 'openai/gpt-4.1',
    unsupportedReason: 'requires a user-specific Cloudflare AI Gateway base URL',
  },
  codex: {
    type: 'openclaw-plugin',
    defaultModel: 'codex',
    unsupportedReason: 'requires OpenClaw Codex harness/auth integration',
  },
  comfy: {
    type: 'openclaw-plugin',
    apiKeyEnv: 'COMFY_API_KEY',
    unsupportedReason: 'image/music/video provider; not a Lannr text model provider',
  },
  'copilot-proxy': {
    type: 'openai-compatible',
    defaultModel: 'gpt-4.1',
    unsupportedReason: 'requires a configured Copilot proxy base URL',
  },
  fal: {
    type: 'openclaw-plugin',
    apiKeyEnv: 'FAL_KEY',
    unsupportedReason: 'image/video provider; not a Lannr text model provider',
  },
  'google-gemini-cli': {
    type: 'openclaw-plugin',
    defaultModel: 'gemini-3.1-pro-preview',
    unsupportedReason: 'requires Gemini CLI auth/backend integration',
  },
  arcee: {
    type: 'openai-compatible',
    baseURL: 'https://conductor.arcee.ai/v1',
    apiKeyEnv: 'ARCEE_API_KEY',
    defaultModel: 'auto',
  },
  byteplus: {
    type: 'openai-compatible',
    baseURL: 'https://ark.ap-southeast.bytepluses.com/api/v3',
    apiKeyEnv: 'ARK_API_KEY',
    defaultModel: 'seed-1-8-251228',
  },
  'byteplus-plan': {
    type: 'openai-compatible',
    baseURL: 'https://ark.ap-southeast.bytepluses.com/api/coding/v3',
    apiKeyEnv: 'ARK_API_KEY',
    defaultModel: 'ark-code-latest',
  },
  cerebras: {
    type: 'openai-compatible',
    baseURL: 'https://api.cerebras.ai/v1',
    apiKeyEnv: 'CEREBRAS_API_KEY',
    defaultModel: 'zai-glm-4.7',
  },
  chutes: {
    type: 'openai-compatible',
    baseURL: 'https://llm.chutes.ai/v1',
    apiKeyEnv: 'CHUTES_API_TOKEN',
    defaultModel: 'Qwen/Qwen3-32B',
  },
  deepinfra: {
    type: 'openai-compatible',
    baseURL: 'https://api.deepinfra.com/v1/openai',
    apiKeyEnv: 'DEEPINFRA_API_KEY',
    defaultModel: 'deepseek-ai/DeepSeek-V3.2',
  },
  deepseek: {
    type: 'openai-compatible',
    baseURL: 'https://api.deepseek.com',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek-v4-flash',
  },
  fireworks: {
    type: 'openai-compatible',
    baseURL: 'https://api.fireworks.ai/inference/v1',
    apiKeyEnv: 'FIREWORKS_API_KEY',
    defaultModel: 'accounts/fireworks/routers/kimi-k2p5-turbo',
  },
  groq: {
    type: 'openai-compatible',
    baseURL: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    defaultModel: 'deepseek-r1-distill-llama-70b',
  },
  huggingface: {
    type: 'openai-compatible',
    baseURL: 'https://router.huggingface.co/v1',
    apiKeyEnv: 'HF_TOKEN',
    defaultModel: 'openai/gpt-oss-120b',
  },
  kilocode: {
    type: 'openai-compatible',
    baseURL: 'https://api.kilo.ai/api/gateway',
    apiKeyEnv: 'KILOCODE_API_KEY',
    defaultModel: 'kilo/auto',
  },
  'kimi-coding': {
    type: 'anthropic',
    baseURL: 'https://api.kimi.com/coding',
    apiKeyEnv: 'KIMI_API_KEY',
    defaultModel: 'kimi-for-coding',
  },
  kimi: {
    type: 'openai-compatible',
    baseURL: 'https://api.moonshot.ai/v1',
    apiKeyEnv: 'MOONSHOT_API_KEY',
    defaultModel: 'kimi-k2.6',
  },
  litellm: {
    type: 'openai-compatible',
    baseURL: 'http://127.0.0.1:4000/v1',
    apiKeyEnv: 'LITELLM_API_KEY',
    defaultModel: 'gpt-4.1',
  },
  lmstudio: {
    type: 'openai-compatible',
    baseURL: 'http://127.0.0.1:1234/v1',
    apiKey: 'lmstudio-local',
    defaultModel: 'local-model',
  },
  minimax: {
    type: 'anthropic',
    baseURL: 'https://api.minimax.io/anthropic',
    apiKeyEnv: 'MINIMAX_API_KEY',
    defaultModel: 'MiniMax-M2.7',
  },
  'minimax-portal': {
    type: 'anthropic',
    baseURL: 'https://api.minimax.io/anthropic',
    apiKeyEnv: 'MINIMAX_OAUTH_TOKEN',
    defaultModel: 'MiniMax-M2.7',
  },
  mistral: {
    type: 'openai-compatible',
    baseURL: 'https://api.mistral.ai/v1',
    apiKeyEnv: 'MISTRAL_API_KEY',
    defaultModel: 'mistral-large-latest',
  },
  moonshot: {
    type: 'openai-compatible',
    baseURL: 'https://api.moonshot.ai/v1',
    apiKeyEnv: 'MOONSHOT_API_KEY',
    defaultModel: 'kimi-k2.6',
  },
  nvidia: {
    type: 'openai-compatible',
    baseURL: 'https://integrate.api.nvidia.com/v1',
    apiKeyEnv: 'NVIDIA_API_KEY',
    defaultModel: 'nvidia/nemotron-3-super-120b-a12b',
  },
  'microsoft-foundry': {
    type: 'openai-compatible',
    apiKeyEnv: 'AZURE_OPENAI_API_KEY',
    defaultModel: 'gpt-4.1',
    unsupportedReason: 'requires a user-specific Azure AI Foundry/OpenAI base URL',
  },
  opencode: {
    type: 'openai-compatible',
    baseURL: 'https://opencode.ai/zen/v1',
    apiKeyEnv: 'OPENCODE_API_KEY',
    defaultModel: 'claude-opus-4-6',
  },
  'opencode-go': {
    type: 'openai-compatible',
    baseURL: 'https://opencode.ai/zen/go/v1',
    apiKeyEnv: 'OPENCODE_API_KEY',
    defaultModel: 'deepseek-v4-pro',
  },
  openrouter: {
    type: 'openai-compatible',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    defaultModel: 'openrouter/auto',
  },
  qianfan: {
    type: 'openai-compatible',
    baseURL: 'https://qianfan.baidubce.com/v2',
    apiKeyEnv: 'QIANFAN_API_KEY',
    defaultModel: 'deepseek-v3.2',
  },
  xai: {
    type: 'openai-compatible',
    baseURL: 'https://api.x.ai/v1',
    apiKeyEnv: 'XAI_API_KEY',
    defaultModel: 'grok-4.3',
  },
  ollama: {
    type: 'openai-compatible',
    baseURL: 'http://127.0.0.1:11434/v1',
    apiKey: 'ollama-local',
    defaultModel: 'llama3.2',
  },
  stepfun: {
    type: 'openai-compatible',
    baseURL: 'https://api.stepfun.ai/v1',
    apiKeyEnv: 'STEPFUN_API_KEY',
    defaultModel: 'step-3.5-flash',
  },
  'stepfun-plan': {
    type: 'openai-compatible',
    baseURL: 'https://api.stepfun.ai/step_plan/v1',
    apiKeyEnv: 'STEPFUN_API_KEY',
    defaultModel: 'step-3.5-flash',
  },
  synthetic: {
    type: 'anthropic',
    baseURL: 'https://api.synthetic.new/anthropic',
    apiKeyEnv: 'SYNTHETIC_API_KEY',
    defaultModel: 'claude-sonnet-4-5',
  },
  'tencent-tokenhub': {
    type: 'openai-compatible',
    baseURL: 'https://tokenhub.tencentmaas.com/v1',
    apiKeyEnv: 'TENCENT_TOKENHUB_API_KEY',
    defaultModel: 'hy3-preview',
  },
  together: {
    type: 'openai-compatible',
    baseURL: 'https://api.together.xyz/v1',
    apiKeyEnv: 'TOGETHER_API_KEY',
    defaultModel: 'zai-org/GLM-4.7',
  },
  venice: {
    type: 'openai-compatible',
    baseURL: 'https://api.venice.ai/api/v1',
    apiKeyEnv: 'VENICE_API_KEY',
    defaultModel: 'llama-3.3-70b',
  },
  'vercel-ai-gateway': {
    type: 'anthropic',
    baseURL: 'https://ai-gateway.vercel.sh/v1',
    apiKeyEnv: 'AI_GATEWAY_API_KEY',
    defaultModel: 'anthropic/claude-sonnet-4-5',
  },
  vllm: {
    type: 'openai-compatible',
    baseURL: 'http://127.0.0.1:8000/v1',
    apiKey: 'vllm-local',
    defaultModel: 'local-model',
  },
  sglang: {
    type: 'openai-compatible',
    baseURL: 'http://127.0.0.1:30000/v1',
    apiKey: 'sglang-local',
    defaultModel: 'local-model',
  },
  volcengine: {
    type: 'openai-compatible',
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKeyEnv: 'ARK_API_KEY',
    defaultModel: 'doubao-seed-code-preview-251028',
  },
  'volcengine-plan': {
    type: 'openai-compatible',
    baseURL: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    apiKeyEnv: 'ARK_API_KEY',
    defaultModel: 'ark-code-latest',
  },
  xiaomi: {
    type: 'openai-compatible',
    baseURL: 'https://api.xiaomimimo.com/v1',
    apiKeyEnv: 'XIAOMI_API_KEY',
    defaultModel: 'mimo-v2-flash',
  },
  zai: {
    type: 'openai-compatible',
    baseURL: 'https://api.z.ai/api/paas/v4',
    apiKeyEnv: 'ZAI_API_KEY',
    defaultModel: 'glm-5.1',
  },
  qwen: {
    type: 'openai-compatible',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
    defaultModel: 'qwen-max',
  },
  qwencloud: {
    type: 'openai-compatible',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
    defaultModel: 'qwen-max',
  },
  modelstudio: {
    type: 'openai-compatible',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
    defaultModel: 'qwen-max',
  },
  dashscope: {
    type: 'openai-compatible',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
    defaultModel: 'qwen-max',
  },
  vydra: {
    type: 'openclaw-plugin',
    apiKeyEnv: 'VYDRA_API_KEY',
    unsupportedReason: 'speech/image/video provider; not a Lannr text model provider',
  },
}

export function listOpenClawProviderCatalog() {
  const catalog = new Map()

  for (const manifest of readOpenClawProviderManifests()) {
    const authEnvVars = manifest.providerAuthEnvVars ?? {}
    const catalogProviders = manifest.modelCatalog?.providers ?? {}
    const requestProviders = manifest.providerRequest?.providers ?? {}
    const ids = new Set([
      ...normalizeProviderList(manifest.providers),
      ...Object.keys(catalogProviders),
      ...Object.keys(requestProviders),
    ])

    for (const rawId of ids) {
      const id = normalizeProviderId(rawId)
      if (!id) continue
      const modelCatalog = catalogProviders[id]
      const request = requestProviders[id]
      const known = KNOWN_PROVIDER_DEFAULTS[id] ?? {}
      const api = modelCatalog?.api
      const type = known.type ?? typeFromOpenClawApi(api, request?.family)
      const models = modelCatalog?.models?.map((model) => model.id).filter(Boolean) ?? []
      catalog.set(id, {
        id,
        name: titleFromId(id),
        type,
        baseURL: known.baseURL ?? modelCatalog?.baseUrl,
        apiKey: known.apiKey,
        apiKeyEnv: known.apiKeyEnv ?? authEnvVars[id]?.[0] ?? defaultEnvFor(id),
        endpoint: endpointFromOpenClawApi(api),
        defaultModel: known.defaultModel ?? models[0],
        models: [...new Set([known.defaultModel, ...models].filter(Boolean))],
        aliases: [],
        unsupportedReason: known.unsupportedReason,
        openClaw: {
          plugin: manifest.id,
          api,
          family: request?.family,
        },
      })
    }
  }

  for (const [id, defaults] of Object.entries(KNOWN_PROVIDER_DEFAULTS)) {
    if (!catalog.has(id)) {
      catalog.set(id, {
        id,
        name: titleFromId(id),
        endpoint: 'chat-completions',
        aliases: [],
        ...defaults,
      })
    }
  }

  return [...catalog.values()].sort((left, right) => left.id.localeCompare(right.id))
}

export function getOpenClawProviderPreset(id) {
  const normalized = normalizeProviderId(id)
  return listOpenClawProviderCatalog().find((provider) => provider.id === normalized)
}

function readOpenClawProviderManifests() {
  const extensionsDir = findOpenClawExtensionsDir()
  if (!extensionsDir) return []
  return readdirSync(extensionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(extensionsDir, entry.name, 'openclaw.plugin.json'))
    .filter((path) => existsSync(path))
    .map((path) => JSON.parse(readFileSync(path, 'utf8')))
    .filter((manifest) => {
      return (
        normalizeProviderList(manifest.providers).length > 0 ||
        Object.keys(manifest.modelCatalog?.providers ?? {}).length > 0 ||
        Object.keys(manifest.providerRequest?.providers ?? {}).length > 0
      )
    })
}

function findOpenClawExtensionsDir() {
  const candidates = [
    resolve(process.cwd(), 'tmp/openclaw/extensions'),
    resolve(HERE, '../../../tmp/openclaw/extensions'),
    resolve(HERE, '../../../../tmp/openclaw/extensions'),
  ]
  return candidates.find((candidate) => existsSync(candidate))
}

function normalizeProviderList(providers) {
  return Array.isArray(providers)
    ? providers.map((provider) => typeof provider === 'string' ? provider : provider?.id).filter(Boolean)
    : []
}

function typeFromOpenClawApi(api, family) {
  if (api === 'anthropic-messages' || family === 'anthropic') return 'anthropic'
  if (family === 'google') return 'google'
  if (family === 'bedrock') return 'bedrock'
  if (family === 'openai-family') return 'openai-compatible'
  return 'openai-compatible'
}

function endpointFromOpenClawApi(api) {
  if (api === 'openai-codex-responses') return 'codex-responses'
  if (api === 'openai-responses' || api === 'openai-codex-responses') return 'responses'
  if (api === 'openai-completions') return 'chat-completions'
  return 'chat-completions'
}

function defaultEnvFor(id) {
  return `${id.toUpperCase().replaceAll('-', '_')}_API_KEY`
}

function titleFromId(id) {
  return id.split('-').map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : part).join(' ')
}
