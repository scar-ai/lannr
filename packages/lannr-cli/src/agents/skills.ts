import { access, cp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const seededRoots = new Set()

export function skillsHome() {
  return join(homedir(), '.lannr', 'skills')
}

export function agentSkillsHome(agent) {
  if (!agent?.agentDir) throw new Error('Agent state directory is required for agent-bound skills.')
  return join(agent.agentDir, 'skills')
}

// Skills bundled with the lannr-cli package and seeded into skillsHome() on
// first use. Resolves to `<packageRoot>/skills` from both dist/ and src/.
export function bundledSkillsDir() {
  return resolve(HERE, '..', '..', 'skills')
}

export function normalizeSkillName(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
}

export function parseSkillList(value) {
  const values = Array.isArray(value) ? value : [value]
  return [...new Set(values.flatMap((entry) => String(entry ?? '').split(','))
    .map(normalizeSkillName)
    .filter(Boolean))].sort()
}

// Copy package-bundled skills into the shared skills root so every agent has
// them available without an explicit install step. Existing skills are left
// untouched unless the bundled copy declares a newer `version` frontmatter.
export async function seedDefaultSkills(options: Record<string, any> = {}) {
  const root = options.root ?? skillsHome()
  if (!options.force && seededRoots.has(root)) return []
  const bundledRoot = options.bundledRoot ?? bundledSkillsDir()
  const sources = await discoverSkillDirs(bundledRoot)
  const installed = []
  for (const source of sources) {
    const bundled = await loadSkill(source)
    if (!bundled) continue
    const target = join(root, bundled.name)
    const current = await loadSkill(target)
    if (current && !shouldReseed(current, bundled)) continue
    await mkdir(dirname(target), { recursive: true })
    await rm(target, { recursive: true, force: true })
    await cp(source, target, {
      recursive: true,
      filter: (src) => {
        const name = basename(src)
        return name !== '.git' && name !== 'node_modules'
      },
    })
    installed.push({ ...bundled, baseDir: target, filePath: join(target, 'SKILL.md') })
  }
  seededRoots.add(root)
  return installed
}

function shouldReseed(current, bundled) {
  const next = bundled.frontmatter?.version
  if (!next) return false
  return current.frontmatter?.version !== next
}

export async function listSkills(options: Record<string, any> = {}) {
  const root = options.root ?? skillsHome()
  if (options.seed !== false) {
    try {
      await seedDefaultSkills({ root })
    } catch {
      // Seeding is best-effort; never block listing on a bad bundle.
    }
  }
  const denied = new Set(parseSkillList(options.deniedSkills ?? []))
  const candidates = await discoverSkillDirs(root)
  const loaded = []
  for (const dir of candidates) {
    const skill = await loadSkill(dir)
    if (skill && !denied.has(skill.name)) loaded.push({ ...skill, scope: 'global' })
  }
  if (options.agent) {
    for (const dir of await discoverSkillDirs(agentSkillsHome(options.agent))) {
      const skill = await loadSkill(dir)
      if (skill) loaded.push({ ...skill, scope: 'agent', agentId: options.agent.id })
    }
  }
  return dedupeSkills(loaded).sort((left, right) => left.name.localeCompare(right.name))
}

export async function installSkill(sourcePath, options: Record<string, any> = {}) {
  const source = resolve(sourcePath)
  const skill = await loadSkill(source)
  if (!skill) throw new Error(`No SKILL.md found in ${source}`)
  const root = options.agent ? agentSkillsHome(options.agent) : (options.root ?? skillsHome())
  const target = join(root, skill.name)
  await mkdir(dirname(target), { recursive: true })
  if (!options.force && await pathExists(target)) {
    throw new Error(`Skill "${skill.name}" already exists. Re-run with --force to replace it.`)
  }
  await rm(target, { recursive: true, force: true })
  await cp(source, target, {
    recursive: true,
    filter: (src) => {
      const name = basename(src)
      return name !== '.git' && name !== 'node_modules'
    },
  })
  return {
    ...skill,
    baseDir: target,
    filePath: join(target, 'SKILL.md'),
    scope: options.agent ? 'agent' : 'global',
    ...(options.agent ? { agentId: options.agent.id } : {}),
  }
}

export async function buildSkillsPrompt(agent) {
  const skills = await listSkills({ agent, deniedSkills: agent?.deniedSkills ?? [] })
  if (!skills.length) return ''
  return [
    'Skills:',
    'The following shared skills provide specialized instructions. Their full instructions are not included here.',
    'When a task matches a skill, read its SKILL.md file before using it. Resolve relative paths against the skill directory.',
    '<available_skills>',
    ...skills.flatMap((skill) => [
      '  <skill>',
      `    <name>${escapeXml(skill.name)}</name>`,
      `    <description>${escapeXml(skill.description)}</description>`,
      `    <location>${escapeXml(skill.filePath)}</location>`,
      '  </skill>',
    ]),
    '</available_skills>',
  ].join('\n')
}

async function discoverSkillDirs(root) {
  if (!await pathExists(root)) return []
  const rootSkill = join(root, 'SKILL.md')
  if (await pathExists(rootSkill)) return [root]
  const firstLevel = await childDirs(root)
  const candidates = []
  for (const dir of firstLevel) {
    if (await pathExists(join(dir, 'SKILL.md'))) {
      candidates.push(dir)
      continue
    }
    for (const nested of await childDirs(dir)) {
      if (await pathExists(join(nested, 'SKILL.md'))) candidates.push(nested)
    }
  }
  return candidates
}

async function childDirs(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
      .map((entry) => join(dir, entry.name))
      .sort((left, right) => left.localeCompare(right))
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

async function loadSkill(dir): Promise<any | null> {
  const filePath = join(dir, 'SKILL.md')
  try {
    const info = await stat(filePath)
    if (!info.isFile()) return null
    const raw = await readFile(filePath, 'utf8')
    const frontmatter = parseFrontmatter(raw)
    const name = normalizeSkillName(frontmatter.name ?? basename(dir))
    const description = String(frontmatter.description ?? frontmatter.desc ?? '').trim()
    if (!name || !description) return null
    return { name, description, baseDir: resolve(dir), filePath: resolve(filePath), frontmatter }
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function parseFrontmatter(raw): Record<string, string> {
  if (!raw.startsWith('---')) return {}
  const end = raw.indexOf('\n---', 3)
  if (end === -1) return {}
  const block = raw.slice(3, end).trim()
  const out = {}
  for (const line of block.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!match) continue
    out[match[1]] = match[2].replace(/^['"]|['"]$/g, '').trim()
  }
  return out
}

function dedupeSkills(skills): any[] {
  const byName = new Map()
  for (const skill of skills) byName.set(skill.name, skill)
  return [...byName.values()]
}

async function pathExists(path) {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
