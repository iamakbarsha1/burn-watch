import { randomInt } from 'crypto'
import { betterAuth } from 'better-auth'
import { mongodbAdapter } from 'better-auth/adapters/mongodb'
import { getDb, getMongoClient } from './mongo'

const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

export const auth = betterAuth({
  database: mongodbAdapter(getDb(), { client: getMongoClient() }),
  advanced: {
    database: {
      // A function keeps ids as plain strings. The default would store new ids
      // as ObjectIds, and the rows copied from Postgres use 32-char string ids.
      generateId: () => Array.from({ length: 32 }, () => ID_CHARS[randomInt(ID_CHARS.length)]).join(''),
    },
  },
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
  },
  session: {
    expiresIn: 7 * 24 * 60 * 60, // 7 days
  },
})
