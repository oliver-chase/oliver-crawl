import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = process.cwd()
const failures = []
let trackedFileSet = null

function listFilesRecursive(dir, out = []) {
  let entries = []
  try { entries = readdirSync(dir) } catch { return out }
  for (const entry of entries) {
    const abs = join(dir, entry)
    let st
    try { st = statSync(abs) } catch { continue }
    if (st.isDirectory()) listFilesRecursive(abs, out)
    else out.push(abs)
  }
  return out
}

function getTrackedFileSet() {
  if (trackedFileSet) return trackedFileSet
  try {
    const out = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    trackedFileSet = new Set(out.split('\n').map((s) => s.trim()).filter(Boolean))
  } catch {
    trackedFileSet = new Set()
    failures.push('unable to determine git-tracked files for structure contract')
  }
  return trackedFileSet
}

function requireFile(path, message) {
  if (!existsSync(path)) failures.push(`${message}: ${relative(ROOT, path)}`)
}

function requireTrackedFile(path, message) {
  requireFile(path, message)
  if (!existsSync(path)) return
  const rel = relative(ROOT, path)
  if (!getTrackedFileSet().has(rel)) failures.push(`${message} must be git-tracked: ${rel}`)
}

function requireScriptReferenceTracked(ref, message) {
  if (!ref.startsWith('scripts/')) return
  requireTrackedFile(join(ROOT, ref), message)
}

const githubDir = join(ROOT, '.github')
if (!existsSync(githubDir)) failures.push('missing .github directory')

if (existsSync(githubDir)) {
  const allMarkdown = listFilesRecursive(githubDir).filter((f) => f.endsWith('.md'))
  const legacyBacklogs = allMarkdown.filter((file) => basename(file).toLowerCase() === 'backlog.md')
  for (const file of legacyBacklogs) failures.push(`legacy backlog.md should be retired: ${relative(ROOT, file)}`)
}

if (existsSync(join(ROOT, 'package.json'))) {
  try {
    const pkgRaw = readFileSync(join(ROOT, 'package.json'), 'utf8')
    const pkg = JSON.parse(pkgRaw)
    const scripts = pkg?.scripts && typeof pkg.scripts === 'object' ? Object.values(pkg.scripts) : []
    for (const command of scripts) {
      if (typeof command !== 'string') continue
      const matches = command.match(/scripts\/[A-Za-z0-9._/-]+\.(?:mjs|js|sql)/g) || []
      for (const match of matches) requireScriptReferenceTracked(match, 'package.json references missing build/runtime script')
    }
  } catch {
    failures.push('unable to parse package.json for script reference validation')
  }
}

if (failures.length > 0) {
  console.error('check-structure-contract: failed')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

console.log('check-structure-contract: clean')
