import { homedir } from 'os'
import { join } from 'path'
import { writeFileSync, existsSync, unlinkSync, mkdirSync } from 'fs'
import { execFileSync } from 'child_process'
import type { ScheduleBackend } from './cron.js'

const TASK_NAME = 'BurnWatchSync'
const TASK_DIR = join(homedir(), '.burnwatch')
const TASK_XML_PATH = join(TASK_DIR, 'task-scheduler.xml')

// Duplicated from cron.ts rather than imported: cron.ts imports windowsBackend
// from this file for its platform registry, so importing anything back would
// make the two files a load-order-dependent cycle. Four lines twice beats a
// third shared module for one function, or TDZ crashes at import time.
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function quoteArg(arg: string): string {
  return /\s/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg
}

export function buildTaskXml(programArguments: string[]): string {
  const [command, ...args] = programArguments
  const argumentsLine = args.map(quoteArg).join(' ')
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>2024-01-01T18:00:00</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
    </Principal>
  </Principals>
  <Settings>
    <Enabled>true</Enabled>
    <StartWhenAvailable>true</StartWhenAvailable>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(command)}</Command>
      <Arguments>${xmlEscape(argumentsLine)}</Arguments>
    </Exec>
  </Actions>
</Task>`
}

// schtasks rejects a BOM-less file with "(1,2)::ERROR: one root element" — it
// reads the UTF-16 bytes as some single-byte encoding and the parse dies on the
// first NUL. Node's 'utf16le' writes no BOM, so prepend one. Returned as bytes
// rather than a string so a test can assert the encoding, not just the markup.
export function buildTaskXmlBuffer(programArguments: string[]): Buffer {
  return Buffer.from('\uFEFF' + buildTaskXml(programArguments), 'utf16le')
}

export const windowsBackend: ScheduleBackend = {
  install(programArguments) {
    mkdirSync(TASK_DIR, { recursive: true })
    writeFileSync(TASK_XML_PATH, buildTaskXmlBuffer(programArguments))
    // Unlike launchd/systemd, the XML alone does nothing until schtasks
    // imports it — a failure here means nothing was actually scheduled, so
    // it is left to propagate rather than swallowed.
    execFileSync('schtasks', ['/create', '/tn', TASK_NAME, '/xml', TASK_XML_PATH, '/f'], {
      stdio: 'pipe',
    })
  },
  uninstall() {
    if (!existsSync(TASK_XML_PATH)) return
    try {
      execFileSync('schtasks', ['/delete', '/tn', TASK_NAME, '/f'], { stdio: 'pipe' })
    } catch {}
    unlinkSync(TASK_XML_PATH)
  },
  isInstalled() {
    return existsSync(TASK_XML_PATH)
  },
}
