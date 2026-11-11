import type { Document } from 'mongodb'
import type { IsoDate, OrgId } from '@burn-watch/db'

export interface EnrichmentRange {
  orgId: OrgId
  from: IsoDate
  to: IsoDate
}

/**
 * The `claudeEnrichment` documents one org wrote between two dates, as the
 * opening `$match` of both aggregates that read enrichment blobs.
 *
 * Postgres had to reach `org_id` by joining `users`, because `claude_enrichment`
 * carried no org column — and getting that join written once, with both table
 * prefixes intact, is the entire reason the CTE this replaces existed.
 * `ClaudeEnrichmentDoc` denormalises `orgId`, so the scoping is now an equality
 * on an indexed field (`claudeEnrichment_org_date`) and there is no join left to
 * render wrong.
 *
 * Inclusive at both ends, as the `>=`/`<=` pair was. `date` is a YYYY-MM-DD
 * string whose lexicographic order is date order, so the comparison never
 * consults a timezone.
 */
export function enrichmentMatch({ orgId, from, to }: EnrichmentRange): Document {
  return { $match: { orgId, date: { $gte: from, $lte: to } } }
}
