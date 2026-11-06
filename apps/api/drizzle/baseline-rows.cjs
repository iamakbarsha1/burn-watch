// Prints the rows drizzle would have written to drizzle.__drizzle_migrations
// had every migration been applied through `drizzle-kit migrate`.
//
// The hash is sha256 over the raw .sql file and `created_at` is the journal
// entry's `when`, both taken straight from drizzle-orm's own readMigrationFiles.
// Only `created_at` decides what gets applied -- the migrator compares each
// migration's folderMillis against the single latest recorded row -- but the
// hashes are written truthfully so the table describes what actually ran.
//
// Throwaway: this exists to baseline a database that was built with `push`
// and never migrated. See BW-37.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const dir = path.join(__dirname, 'migrations')
const journal = JSON.parse(fs.readFileSync(path.join(dir, 'meta', '_journal.json'), 'utf8'))

const rows = journal.entries.map((entry) => {
  const sql = fs.readFileSync(path.join(dir, entry.tag + '.sql'), 'utf8')
  return {
    tag: entry.tag,
    when: entry.when,
    hash: crypto.createHash('sha256').update(sql).digest('hex'),
  }
})

for (const r of rows) console.log(r.when, r.hash, r.tag)
console.log('\n--- VALUES ---')
console.log(rows.map((r) => "('" + r.hash + "', " + r.when + ")").join(',\n'))
