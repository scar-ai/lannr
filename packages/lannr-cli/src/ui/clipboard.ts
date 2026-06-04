// Copy text to the system clipboard without pulling in a dependency. Tries the
// platform-native tool and falls back across the common Linux options.
import { spawn } from 'node:child_process'

function pipeTo(cmd: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] })
    } catch {
      resolve(false)
      return
    }
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
    try {
      child.stdin.end(text)
    } catch {
      resolve(false)
    }
  })
}

// Returns the name of the tool that succeeded, or null if none worked.
export async function copyToClipboard(text: string): Promise<string | null> {
  const platform = process.platform
  const candidates: [string, string[]][] =
    platform === 'darwin'
      ? [['pbcopy', []]]
      : platform === 'win32'
        ? [['clip', []]]
        : [
            ['wl-copy', []],
            ['xclip', ['-selection', 'clipboard']],
            ['xsel', ['--clipboard', '--input']],
          ]
  for (const [cmd, args] of candidates) {
    if (await pipeTo(cmd, args, text)) return cmd
  }
  return null
}
