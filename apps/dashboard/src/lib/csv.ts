export type InviteRow = { email: string; role?: string; team?: string }

/** One CSV line, with "quoted, fields" and "" as an escaped quote. */
export function splitCsvLine(line: string): string[] {
  const cells: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quoted && c === '"' && line[i + 1] === '"') (cell += '"'), i++
    else if (c === '"') quoted = !quoted
    else if (c === ',' && !quoted) cells.push(cell), (cell = '')
    else cell += c
  }
  cells.push(cell)
  return cells.map((s) => s.trim())
}

/**
 * Columns email, role, team. With a header row they may come in any order;
 * without one they are read in that order. Role and team may be blank.
 */
export function parseInviteCsv(text: string): InviteRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
  if (lines.length === 0) return []
  const first = splitCsvLine(lines[0]).map((h) => h.toLowerCase())
  const hasHeader = first.includes('email')
  const col = (name: string, fallback: number) => (hasHeader ? first.indexOf(name) : fallback)
  const [e, r, t] = [col('email', 0), col('role', 1), col('team', 2)]
  return (hasHeader ? lines.slice(1) : lines).map((line) => {
    const cells = splitCsvLine(line)
    const at = (i: number) => (i >= 0 ? cells[i] || undefined : undefined)
    return { email: cells[e] ?? '', role: at(r), team: at(t) }
  })
}
