import { getStore, type OrgId, type UserId } from '@burn-watch/db'

/** Active people in an org: the whole-org group for the size check and for view audit rows. */
export async function orgPeople(orgId: OrgId): Promise<UserId[]> {
  const users = await getStore().users.find({ orgId, isActive: true }, { projection: { _id: 1 } })
  return users.map((u) => u._id)
}
