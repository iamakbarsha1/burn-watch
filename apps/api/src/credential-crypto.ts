import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * `v1.<iv>.<tag>.<ciphertext>`, each segment base64url.
 *
 * The version sits in the value rather than in a separate column because the
 * envelope travels as one `text` field and has to be self-describing wherever
 * it is read back from.
 */
export type SealedCredential = string

export type CredentialCrypto =
  | {
      available: true
      seal(plaintext: string, context: string): SealedCredential
      open(sealed: SealedCredential, context: string): string
    }
  | { available: false; reason: 'missing-key' | 'malformed-key' }

const VERSION = 'v1'
const KEY_BYTES = 32
const IV_BYTES = 12

/**
 * Pinned, because node does not pin it for you.
 *
 * `createDecipheriv('aes-256-gcm', ...)` without this accepts any tag from 4
 * to 16 bytes, and a 4-byte tag verifies a real ciphertext perfectly well.
 * Measured on this project's node: tags truncated to 8 and to 4 bytes both
 * decrypted a sealed credential and returned the plaintext. That turns a
 * forger's odds from one in 2^128 into one in 2^32 for anyone who can write
 * `encrypted_token`, which a restored backup or a future injection elsewhere
 * could. Pinning the length makes a short tag a thrown error instead.
 */
const TAG_BYTES = 16

/**
 * Seals and opens an org credential with AES-256-GCM, when a key is configured.
 *
 * BW-21 puts a GitHub Copilot org token in `org_integrations.encrypted_token`,
 * and a deployment may not have `COPILOT_ENCRYPTION_KEY` set. The answer to a
 * missing key is that the integration stays off, not that the API fails to
 * boot. So the environment is read here, on call, the way `plugins/db.ts`
 * defers building its pool. Importing this file with an empty environment does
 * nothing and throws nothing, which is what keeps an unconfigured deployment
 * serving every route that has no business knowing about Copilot.
 *
 * The result is a union rather than an object plus a nullable field, so a
 * caller that forgets the absent-key branch does not compile. `seal` and `open`
 * exist only on the `available: true` side. There is no shape in which reaching
 * for them skips the check.
 *
 * `env` is a parameter so a test supplies a key by passing one, instead of
 * writing to `process.env` and leaving it there for whatever runs next.
 */
export function credentialCrypto(env: NodeJS.ProcessEnv = process.env): CredentialCrypto {
  // Trimmed because `openssl rand -base64 32`, the documented way to produce
  // this value, ends its output with a newline. Piping that straight into a
  // secret store carries the newline along, and an untrimmed read would then
  // reject a key the operator generated correctly. Whitespace means nothing in
  // base64, so there is no input this accepts that it should have refused.
  const configured = env.COPILOT_ENCRYPTION_KEY?.trim()
  if (!configured) return { available: false, reason: 'missing-key' }

  const key = Buffer.from(configured, 'base64')
  // `Buffer.from(s, 'base64')` drops characters outside the alphabet rather
  // than refusing them, so a length check on its own is not a base64 check.
  // Insert one `!` into a real 32-byte key and the mangled string still decodes
  // to 32 bytes, which would hand every seal a key the operator never set.
  // Encoding the bytes back and demanding the original proves the input was the
  // canonical base64 of what came out, and no mangled string survives that.
  if (key.length !== KEY_BYTES || key.toString('base64') !== configured) {
    return { available: false, reason: 'malformed-key' }
  }

  return {
    available: true,

    /**
     * `context` binds the envelope to where it is stored, as additional
     * authenticated data. Callers pass `${orgId}:${provider}`.
     *
     * Without it the tag proves only that the ciphertext was not altered, not
     * that it belongs to the row it was read from. A credential copied
     * between `org_integrations` rows by a careless migration, a restore from
     * another environment, or manual surgery would then decrypt without
     * complaint and hand one organization another organization's token. With
     * it, the same mistake throws.
     */
    seal(plaintext: string, context: string): SealedCredential {
      // A fresh IV per call. Repeating one under GCM is not a weakening, it is
      // a break. Two messages sharing a key and a nonce leak the keystream and
      // the authentication key with it.
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
      cipher.setAAD(Buffer.from(context, 'utf8'))
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      const tag = cipher.getAuthTag()
      return `${VERSION}.${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`
    },

    /**
     * Returns the plaintext, and throws on anything it cannot verify.
     *
     * A tampered ciphertext, a tampered tag, a malformed envelope, and an
     * unknown version prefix are all real errors for the caller to catch. None
     * of them is a degrade case. An absent key is the only condition this
     * module reads as "the feature is off". Anything that gets as far as `open`
     * is a credential that was written once and no longer verifies, and the
     * caller needs to hear about that rather than be handed a plausible wrong
     * answer.
     */
    open(sealed: SealedCredential, context: string): string {
      const parts = sealed.split('.')
      if (parts.length !== 4 || parts[0] !== VERSION) {
        throw new Error('Not a v1 sealed credential')
      }
      // No explicit length checks here, but only because the options below
      // make node do them. `authTagLength` is what rejects a short tag;
      // without it `setAuthTag` accepts anything from 4 bytes up and a
      // truncated tag verifies a real ciphertext. A wrong-sized IV is caught
      // too, though not always where you would expect: an empty one throws
      // from the constructor while a 16-byte one survives it and fails at
      // `final()`. Either way the caller gets a throw.
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(parts[1], 'base64url'),
        { authTagLength: TAG_BYTES },
      )
      decipher.setAuthTag(Buffer.from(parts[2], 'base64url'))
      // Must match the `seal` context exactly, and must be set before any
      // `update`, or the tag will not verify.
      decipher.setAAD(Buffer.from(context, 'utf8'))
      return Buffer.concat([
        decipher.update(Buffer.from(parts[3], 'base64url')),
        decipher.final(),
      ]).toString('utf8')
    },
  }
}
