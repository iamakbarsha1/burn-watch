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
      seal(plaintext: string): SealedCredential
      open(sealed: SealedCredential): string
    }
  | { available: false; reason: 'missing-key' | 'malformed-key' }

const VERSION = 'v1'
const KEY_BYTES = 32
const IV_BYTES = 12

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
  const configured = env.COPILOT_ENCRYPTION_KEY
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

    seal(plaintext: string): SealedCredential {
      // A fresh IV per call. Repeating one under GCM is not a weakening, it is
      // a break. Two messages sharing a key and a nonce leak the keystream and
      // the authentication key with it.
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
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
    open(sealed: SealedCredential): string {
      const parts = sealed.split('.')
      if (parts.length !== 4 || parts[0] !== VERSION) {
        throw new Error('Not a v1 sealed credential')
      }
      // No length checks on the IV or the tag. A wrong-sized one throws out of
      // node's own constructor, and a flipped byte anywhere throws out of
      // `final()`, so a check here would only restate those in a worse message.
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64url'))
      decipher.setAuthTag(Buffer.from(parts[2], 'base64url'))
      return Buffer.concat([
        decipher.update(Buffer.from(parts[3], 'base64url')),
        decipher.final(),
      ]).toString('utf8')
    },
  }
}
