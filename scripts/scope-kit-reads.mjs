#!/usr/bin/env node
// Keeps the kit's development material out of a deployed team's searches and reads
// (two-root instance, decisions/0009-kit-instance-separation.md): `.ignore` in the team root,
// read by ripgrep and so by the session's search tools, and a deny rule in `.claude/settings.json`.
// Only what is missing is added; every other line and setting is kept. bootstrap-team.sh and pin-kit.sh run it.
//
// Usage: node kit/scripts/scope-kit-reads.mjs [--check] ROOT
//   --check  writes nothing; exit 1 and one line per gap when something is missing.
import { readFileSync, writeFileSync, renameSync, lstatSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

const IGNORED = ['kit/tests/', 'kit/.github/']
const DENIED = 'Read(./kit/tests/**)'
const IGNORE = '.ignore', SETTINGS = '.claude/settings.json'
const HEADER = '# Kit development material, kept out of the team\'s searches (kit/scripts/scope-kit-reads.mjs)\n'

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function readText(root, file) {
  const stat = lstatSync(join(root, file), { throwIfNoEntry: false })
  if (!stat) return null
  if (!stat.isFile()) throw new Error(`${file} is not a regular file (a symbolic link is not followed): replace the link with the file it points to, then run this again`)
  return readFileSync(join(root, file), 'utf8')
}

function readSettings(root) {
  const text = readText(root, SETTINGS)
  if (text === null) return {}
  let settings
  try { settings = JSON.parse(text) } catch { settings = null }
  if (!plain(settings) || (settings.permissions !== undefined && !plain(settings.permissions))
    || (settings.permissions?.deny !== undefined && !Array.isArray(settings.permissions.deny)))
    throw new Error(`${SETTINGS} is not a JSON object whose permissions.deny is a list; fix it by hand, then run this again`)
  return settings
}

function gaps(root) {
  const ignoreText = readText(root, IGNORE) ?? ''
  const lines = new Set(ignoreText.split(/\r?\n/).map(line => line.trim()))
  const settings = readSettings(root)
  return {
    ignoreText, settings,
    ignore: IGNORED.filter(path => !lines.has(path)),
    deny: (settings.permissions?.deny ?? []).includes(DENIED) ? [] : [DENIED],
  }
}

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.scope-tmp.${process.pid}`
  writeFileSync(tmp, text)
  renameSync(tmp, path)
}

function scope(root) {
  const found = gaps(root), done = []
  if (found.ignore.length) {
    const base = found.ignoreText === '' ? HEADER : found.ignoreText.endsWith('\n') ? found.ignoreText : `${found.ignoreText}\n`
    writeAtomic(join(root, IGNORE), base + found.ignore.map(path => `${path}\n`).join(''))
    done.push(`${IGNORE}: added ${found.ignore.join(', ')}`)
  }
  if (found.deny.length) {
    const { settings } = found
    const next = { ...settings, permissions: { ...settings.permissions, deny: [...(settings.permissions?.deny ?? []), DENIED] } }
    writeAtomic(join(root, SETTINGS), JSON.stringify(next, null, 2) + '\n')
    done.push(`${SETTINGS}: added permissions.deny ${DENIED}`)
  }
  return done
}

function main(args) {
  const check = args[0] === '--check', rest = check ? args.slice(1) : args
  if (rest.length !== 1 || rest[0].startsWith('-')) {
    console.log('FAIL - args: usage: scope-kit-reads.mjs [--check] ROOT')
    return 1
  }
  const root = rest[0]
  try {
    if (check) {
      const found = gaps(root)
      for (const path of found.ignore) console.log(`MISSING - ${IGNORE}: ${path}`)
      for (const rule of found.deny) console.log(`MISSING - ${SETTINGS}: permissions.deny ${rule}`)
      return found.ignore.length + found.deny.length ? 1 : 0
    }
    const done = scope(root)
    for (const line of done) console.log(`DONE - ${line}`)
    if (!done.length) console.log(`SKIP - ${IGNORE}, ${SETTINGS}: kit development material already kept out of reads`)
    return 0
  } catch (error) {
    console.log(`FAIL - scope: ${error.message}`)
    return 1
  }
}

process.exitCode = main(process.argv.slice(2))
