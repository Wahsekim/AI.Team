#!/usr/bin/env node
// Writes a read-only, self-contained HTML dashboard of one team instance to stdout.
// Usage: node scripts/dashboard.mjs --instance <root> [--transcripts <session-dir>]
//                                   [--quota <quota.json>] [--now <iso>] > dashboard.html
// Reads only; nothing is written into the instance. Contract: docs/dashboard.md.
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { collect } from '../src/dashboard/collect.mjs'
import { render } from '../src/dashboard/render.mjs'

const USAGE = 'usage: node scripts/dashboard.mjs --instance <root> [--transcripts <session-dir>] [--quota <quota.json>] [--now <iso>]'
const FLAGS = { '--instance': 'instance', '--transcripts': 'transcripts', '--quota': 'quota', '--now': 'now' }

function die(message) {
  console.error(`dashboard: ${message}`)
  process.exit(2)
}

function parseArgs(argv) {
  const opts = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = FLAGS[argv[i]]
    if (!key) die(`unknown argument ${argv[i]}\n${USAGE}`)
    if (argv[i + 1] === undefined) die(`${argv[i]} needs a value\n${USAGE}`)
    opts[key] = argv[i + 1]
  }
  if (!opts.instance) die(`--instance is required\n${USAGE}`)
  opts.instance = resolve(opts.instance)
  if (!existsSync(opts.instance) || !statSync(opts.instance).isDirectory()) die(`instance root not found: ${opts.instance}`)
  if (opts.now) {
    const now = new Date(opts.now)
    if (Number.isNaN(now.getTime())) die(`--now is not a date: ${opts.now}`)
    opts.now = now
  }
  return opts
}

const { instance, ...opts } = parseArgs(process.argv.slice(2))
process.stdout.write(render(collect(instance, opts)))
