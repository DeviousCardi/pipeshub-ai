import { orgScope } from '../domain/config-change';
import type { DelegationSource } from '../ports/org-roles';
import type { PolicyStore } from '../ports/policy-store';

/** The control-plane actions an org delegates to its team admins (`catalog.delegation`), from the org's policy layer. */
export class PolicyStoreDelegation implements DelegationSource {
  constructor(protected readonly layers: Pick<PolicyStore, 'readMany'>) {}

  async delegatedActions(orgId: string): Promise<readonly string[]> {
    const read = await this.layers.readMany(orgId, [orgScope(orgId)]);
    const org = read.get(orgScope(orgId));
    if (org?.status !== 'ok') return [];
    return org.layer?.catalog?.delegation ?? [];
  }
}
