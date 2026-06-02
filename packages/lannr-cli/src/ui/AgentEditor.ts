// Interactive editor opened by `lannr agents edit <name>`. Lets the user change
// an agent's provider, name, description, instructions, allowed skills, and a
// couple of flags, then persists via updateAgent(). Arrow keys move between
// fields; the control on the active row depends on the field type.

import React, { useState } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import TextInput from 'ink-text-input'

const h = React.createElement

export function AgentEditor({ agent, providers, skills, onSave }) {
  const { exit } = useApp()

  const allowedInit = {}
  for (const skill of skills) allowedInit[skill.name] = !(agent.deniedSkills ?? []).includes(skill.name)

  const [draft, setDraft] = useState(() => ({
    name: agent.name ?? '',
    description: agent.description ?? '',
    instructions: agent.instructions ?? '',
    providerId: agent.providerConfig?.id ?? agent.provider ?? 'default',
    model: agent.providerConfig?.model ?? '',
    globalReach: Boolean(agent.globalReach),
    default: Boolean(agent.default),
    allowed: allowedInit,
  }))

  const [index, setIndex] = useState(0)
  const [editing, setEditing] = useState(false)
  const [skillsOpen, setSkillsOpen] = useState(false)
  const [skillIdx, setSkillIdx] = useState(0)
  const [status, setStatus] = useState(null)
  const [error, setError] = useState(null)

  const providerIds = providers.length ? providers.map((p) => p.id) : [draft.providerId]

  const fields = [
    { key: 'name', label: 'Name', type: 'text' },
    { key: 'description', label: 'Description', type: 'text' },
    { key: 'instructions', label: 'Instructions', type: 'text' },
    { key: 'providerId', label: 'Provider', type: 'choice' },
    { key: 'model', label: 'Model', type: 'text' },
    { key: 'allowed', label: 'Allowed skills', type: 'skills' },
    { key: 'globalReach', label: 'Global reach', type: 'boolean' },
    { key: 'default', label: 'Default agent', type: 'boolean' },
    { key: '__save', label: 'Save changes', type: 'action' },
  ]

  function cycleProvider(dir) {
    const pos = Math.max(0, providerIds.indexOf(draft.providerId))
    const next = providerIds[(pos + dir + providerIds.length) % providerIds.length]
    setDraft((d) => ({ ...d, providerId: next }))
  }

  async function save() {
    const deniedSkills = skills.filter((s) => !draft.allowed[s.name]).map((s) => s.name)
    const patch = {
      name: draft.name.trim() || agent.name,
      description: draft.description,
      instructions: draft.instructions,
      providerConfig: {
        id: draft.providerId,
        ...(draft.model.trim() ? { model: draft.model.trim() } : {}),
        ...(agent.providerConfig?.params ? { params: agent.providerConfig.params } : {}),
      },
      deniedSkills,
      globalReach: draft.globalReach,
      default: draft.default,
    }
    try {
      await onSave(patch)
      setStatus('saved')
      setTimeout(() => exit(), 500)
    } catch (err) {
      setError(err?.message ?? String(err))
    }
  }

  useInput((input, key) => {
    if (status) return

    // Skill picker sub-screen.
    if (skillsOpen) {
      if (key.escape) { setSkillsOpen(false); return }
      if (key.upArrow) { setSkillIdx((i) => (i - 1 + skills.length) % skills.length); return }
      if (key.downArrow) { setSkillIdx((i) => (i + 1) % skills.length); return }
      if (input === ' ') {
        const name = skills[skillIdx]?.name
        if (name) setDraft((d) => ({ ...d, allowed: { ...d.allowed, [name]: !d.allowed[name] } }))
        return
      }
      if (input === 'a') {
        const allOn = skills.every((s) => draft.allowed[s.name])
        setDraft((d) => ({ ...d, allowed: Object.fromEntries(skills.map((s) => [s.name, !allOn])) }))
        return
      }
      return
    }

    const field = fields[index]

    // Inline text editing mode (handled by TextInput onSubmit otherwise).
    if (editing) {
      if (key.escape) setEditing(false)
      return
    }

    if (key.escape) { exit(); return }
    if (key.upArrow) { setIndex((i) => (i - 1 + fields.length) % fields.length); return }
    if (key.downArrow) { setIndex((i) => (i + 1) % fields.length); return }

    if (field.type === 'text' && (key.return || input === ' ')) { setEditing(true); return }
    if (field.type === 'choice') {
      if (key.leftArrow) { cycleProvider(-1); return }
      if (key.rightArrow || key.return) { cycleProvider(1); return }
    }
    if (field.type === 'boolean' && (input === ' ' || key.return)) {
      setDraft((d) => ({ ...d, [field.key]: !d[field.key] }))
      return
    }
    if (field.type === 'skills' && key.return) { setSkillsOpen(true); return }
    if (field.type === 'action' && key.return) { void save(); return }
  })

  if (error) {
    return h(Box, { flexDirection: 'column', paddingY: 1, paddingX: 2 },
      h(Text, { color: 'red' }, `edit error: ${error}`)
    )
  }

  if (skillsOpen) {
    return h(Box, { flexDirection: 'column', paddingY: 1, paddingX: 2 },
      h(Box, { marginBottom: 1 },
        h(Text, { color: 'cyan', bold: true }, '⬡ Allowed skills')
      ),
      skills.length === 0
        ? h(Text, { color: 'gray', dimColor: true }, 'No skills installed.')
        : h(Box, { flexDirection: 'column' },
          ...skills.map((s, i) => {
            const active = i === skillIdx
            const on = draft.allowed[s.name]
            return h(Box, { key: s.name },
              h(Text, { color: active ? 'cyan' : 'gray' }, active ? '❯ ' : '  '),
              h(Text, { color: on ? 'green' : 'gray' }, on ? '[x] ' : '[ ] '),
              h(Text, { color: active ? 'white' : 'gray', bold: active }, s.name),
              s.description ? h(Text, { color: 'gray', dimColor: true }, `  ${s.description}`) : null
            )
          })
        ),
      h(Box, { marginTop: 1 },
        h(Text, { color: 'gray', dimColor: true }, '↑↓ navigate  space toggle  a toggle all  esc back')
      )
    )
  }

  const activeField = fields[index]
  let hint
  if (status) hint = 'saved'
  else if (editing) hint = '↵ confirm  esc cancel'
  else if (activeField?.type === 'choice') hint = '↑↓ navigate  ←→ change provider  ↵ save row'
  else if (activeField?.type === 'boolean') hint = '↑↓ navigate  space toggle'
  else if (activeField?.type === 'skills') hint = '↑↓ navigate  ↵ edit skills'
  else if (activeField?.type === 'action') hint = '↑↓ navigate  ↵ save & exit  esc cancel'
  else hint = '↑↓ navigate  ↵ edit  esc cancel'

  return h(Box, { flexDirection: 'column', paddingY: 1, paddingX: 2 },
    h(Box, { marginBottom: 1 },
      h(Text, { color: 'cyan', bold: true }, `⬡ Edit agent  `),
      h(Text, { color: 'gray', dimColor: true }, agent.id)
    ),
    ...fields.map((field, i) => {
      const active = i === index
      return h(Box, { key: field.key },
        h(Text, { color: active ? 'cyan' : 'gray' }, active ? '❯ ' : '  '),
        field.type === 'action'
          ? h(Text, { color: active ? 'green' : 'gray', bold: active }, field.label)
          : h(React.Fragment, null,
            h(Text, { color: active ? 'white' : 'gray', bold: active }, field.label.padEnd(16)),
            renderValue(field, draft, active, editing, setDraft, setEditing)
          )
      )
    }),
    h(Box, { marginTop: 1 },
      h(Text, { color: status ? 'green' : 'gray', dimColor: !status }, hint)
    )
  )
}

function renderValue(field, draft, active, editing, setDraft, setEditing) {
  if (field.type === 'boolean') {
    const on = draft[field.key]
    return h(Text, { color: on ? 'green' : 'gray' }, on ? '[x]' : '[ ]')
  }
  if (field.type === 'choice') {
    return h(Text, null,
      h(Text, { color: active ? 'cyan' : 'gray' }, '‹ '),
      h(Text, { color: active ? 'green' : 'gray', bold: active }, draft.providerId),
      h(Text, { color: active ? 'cyan' : 'gray' }, ' ›')
    )
  }
  if (field.type === 'skills') {
    const all = Object.values(draft.allowed)
    const on = all.filter(Boolean).length
    return h(Text, { color: 'gray' }, `${on}/${all.length} allowed`)
  }
  // text
  if (active && editing) {
    return h(Box, { borderStyle: 'round', borderColor: 'cyan', paddingX: 1 },
      h(TextInput, {
        value: draft[field.key],
        onChange: (v) => setDraft((d) => ({ ...d, [field.key]: v })),
        onSubmit: () => setEditing(false),
      })
    )
  }
  const value = draft[field.key]
  const display = value
    ? (value.length > 48 ? `${value.slice(0, 48)}…` : value)
    : '—'
  return h(Text, { color: value ? (active ? 'white' : 'gray') : 'gray', dimColor: !value, wrap: 'truncate-end' }, display)
}
