import { listAgents } from '../agents/registry.js'
import { agentSkillsHome, installSkill, listSkills, skillsHome } from '../agents/skills.js'
import { printTable, resolveAgentFromList } from '../cli/helpers.js'

export function register(program) {
  const skills = program.command('skills').description('Manage shared Lannr skills')

  skills.command('list')
    .alias('ls')
    .description('List installed shared skills')
    .option('--json', 'print JSON')
    .action(async (opts) => {
      const rows = await listSkills()
      if (opts.json) {
        console.log(JSON.stringify({ root: skillsHome(), skills: rows }, null, 2))
        return
      }
      console.log(`Skills root: ${skillsHome()}`)
      if (!rows.length) {
        console.log('No skills installed.')
        return
      }
      printTable(rows.map((skill) => ({
        name: skill.name,
        description: skill.description,
        location: skill.filePath,
      })))
    })

  skills.command('add')
    .alias('install')
    .description('Install a skill directory into the global skills root or one agent')
    .argument('<path>', 'path to a directory containing SKILL.md')
    .option('--agent <id>', 'install as an agent-bound skill for this agent')
    .option('--force', 'replace an existing skill with the same name')
    .option('--json', 'print JSON')
    .action(async (path, opts) => {
      let agent = null
      if (opts.agent) {
        agent = resolveAgentFromList(await listAgents(), opts.agent)
        if (!agent) {
          console.error(`Agent not found: ${opts.agent}`)
          process.exitCode = 1
          return
        }
      }
      const skill = await installSkill(path, { agent, force: opts.force })
      if (opts.json) {
        console.log(JSON.stringify({ ...skill, root: agent ? agentSkillsHome(agent) : skillsHome() }, null, 2))
        return
      }
      const scope = agent ? `agent "${agent.id}"` : 'global'
      console.log(`Installed ${scope} skill "${skill.name}" at ${skill.baseDir}`)
    })
}
