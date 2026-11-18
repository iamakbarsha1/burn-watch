import { MongoClient, type Db } from 'mongodb'

// One client per process. Kept on globalThis so dev hot reload reuses it.
const g = globalThis as typeof globalThis & { _bwMongo?: MongoClient }

export function getMongoClient(): MongoClient {
  if (!g._bwMongo) {
    const uri = process.env.MONGODB_URI
    if (!uri) throw new Error('MONGODB_URI not configured')
    g._bwMongo = new MongoClient(uri)
  }
  return g._bwMongo
}

// The database named in MONGODB_URI.
export function getDb(): Db {
  return getMongoClient().db()
}
