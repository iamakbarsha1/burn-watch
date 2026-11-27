import { getDb } from '@burn-watch/db'

/**
 * Deletes one person's login: better-auth's user, password account and
 * sessions. The dashboard writes these to the same database as the store, but
 * they are not store collections, so they are reached by name here.
 * Returns how many documents went.
 */
export async function deleteLogin(email: string): Promise<number> {
  const db = getDb()
  const user = await db.collection<{ _id: unknown; email: string }>('user').findOne({ email })
  if (!user) return 0
  const sessions = await db.collection('session').deleteMany({ userId: user._id })
  const accounts = await db.collection('account').deleteMany({ userId: user._id })
  const users = await db.collection('user').deleteOne({ _id: user._id })
  return sessions.deletedCount + accounts.deletedCount + users.deletedCount
}
