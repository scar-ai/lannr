export function extractProgram(response: string): string | null {
  const match = response.match(/<program>\s*([\s\S]*?)\s*<\/program>/)
  return match ? match[1].trim() : null
}

export function stripTypeScript(program: string): string {
  return program
    .replace(/^\s*import\s.+$/gm, '')
    .replace(/^\s*export\s+/gm, '')
    .replace(/\b(const|let|var)\s+([A-Za-z_$][\w$]*)\s*:\s*[^=;\n]+(?=\s*=)/g, '$1 $2')
    .replace(/(\(\s*[A-Za-z_$][\w$]*)\s*:\s*(?!\s*(?:['"`0-9{[\]$]|true\b|false\b|null\b|await\b))[^,)=\n]+(?=\s*[,)=])/g, '$1')
    .replace(/\)\s*:\s*[A-Za-z_$][\w$<>,\s|&[\]{}'".?:-]*(?=\s*(?:=>|[{]))/g, ')')
    .replace(/\s+as\s+[A-Za-z_$][\w$<>,\s|&[\]{}'".?:-]*/g, '')
}
