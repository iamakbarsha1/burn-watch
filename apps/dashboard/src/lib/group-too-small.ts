/** The API refused a read over fewer than MIN_GROUP_SIZE people (v2 rule 2). */
export class GroupTooSmallError extends Error {}

/**
 * A page's reads, or null when the API refused them as a group too small.
 * Caught here, not in error.tsx: production strips a server error's message,
 * so the boundary could not tell this answer from an outage.
 */
export async function unlessTooSmall<T>(reads: Promise<T>): Promise<T | null> {
  try {
    return await reads
  } catch (error) {
    if (error instanceof GroupTooSmallError) return null
    throw error
  }
}

/** For a section that shows its own "could not read": null, except a group too small, which the page handles. */
export function nullUnlessTooSmall(error: unknown): null {
  if (error instanceof GroupTooSmallError) throw error
  return null
}
