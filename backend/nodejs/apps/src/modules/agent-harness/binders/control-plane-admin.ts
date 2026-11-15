import { fixedDimensions } from '../domain/policy/fixed';
import {
  CachingAgentDirectory,
  CONTROL_PLANE_AUTHORIZER,
  CONTROL_PLANE_PIN_SERVICES,
  controlPlaneAdminBindings,
  orgScope,
  type AdminPinServices,
  type PolicyLayer,
  type PolicyRefusal,
  type PolicySectionRule,
  type SectionContext,
  configuredRoutes,
} from '../../control-plane';
import { ChainConfigAuditLog } from '../adapters/chain-config-audit-log';
import { flowSettings } from '../config';
import { deploymentFlow, deploymentLayers } from '../domain/deployment-policy';
import { releaseLayers } from '../domain/pin-shadow';
import {
  deploymentRepositoryCap,
  deploymentWebsiteCap,
  releaseRepositoryDefault,
  repositoryPresets,
  websiteHostRules,
} from '../domain/website-settings';
import { sectionDeployment } from '../application/section-deployment';
import { PolicyResolver, scoped, type ScopedLayer } from '../domain/policy';
import type { interfaces } from 'inversify';
import { boundOrNull, HarnessBinder } from './context';
import { directoryMembership } from './control-plane-pin';
import { policyBackingOf } from './policy-store';
import {
  CONTROL_PLANE_AGENT_DIRECTORY,
  CONTROL_PLANE_POLICY_EDITION_DIMENSIONS,
  CONTROL_PLANE_POLICY_SECTION_RULES,
} from './tokens';

/**
 * Every list of policy section rules bound to `CONTROL_PLANE_POLICY_SECTION_RULES`, in binding order: each
 * feature that offers a section binds its own list, so they compose. A section two rules offer is refused at boot.
 */
export function policySectionRulesOf(
  container: interfaces.Container,
): readonly PolicySectionRule[] {
  if (!container.isBound(CONTROL_PLANE_POLICY_SECTION_RULES)) return [];
  const rules = container
    .getAll<readonly PolicySectionRule[]>(CONTROL_PLANE_POLICY_SECTION_RULES)
    .flat();
  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.section)) {
      throw new Error(
        `Policy section "${rule.section}" is offered by two rules`,
      );
    }
    seen.add(rule.section);
  }
  return rules;
}

/**
 * CPD-11: the admin API's services (`/api/v1/control-plane`). Binds after
 * the pinner, the policy backing and the directory caches, and takes whichever
 * of them this deployment composed: a part that is absent answers
 * `CP_UNAVAILABLE`.
 */
export const bindControlPlaneAdmin: HarnessBinder = ({
  container,
  dependencies,
  controlPlane,
  journal,
}) => {
  if (container.isBound(CONTROL_PLANE_AUTHORIZER)) return;
  const resolver = new PolicyResolver();
  // Read once at start: a cap that cannot be read stops Node rather than capping less (WP-63).
  const websiteCap = deploymentWebsiteCap();
  const repositoryCap = deploymentRepositoryCap();
  const backing = policyBackingOf(container);
  const approvalsDocument = dependencies.approvalSettings?.document;
  const release: ScopedLayer = { kind: 'release', values: releaseLayers()[0] };
  /** The layers a scope's layer must narrow: the release, the deployment's, and for an agent the org's. */
  const above = async (
    orgId: string,
    agent: boolean,
  ): Promise<ScopedLayer[]> => {
    const deployment =
      approvalsDocument === undefined
        ? new Map<string, PolicyLayer>()
        : deploymentLayers(
            (await approvalsDocument.read()).value,
            deploymentFlow(flowSettings()).rule,
          );
    const layers = [release, ...[...deployment.values()].map(scoped)];
    if (agent && backing !== undefined) {
      const org = (await backing.layers.read(orgId, orgScope(orgId))).layer;
      if (org !== null) layers.push(scoped(org));
    }
    return layers;
  };
  const narrows = async (
    orgId: string,
    layer: PolicyLayer,
  ): Promise<PolicyRefusal | null> =>
    resolver.assertNarrows(
      scoped(layer),
      await above(orgId, layer.scope.kind === 'agent'),
    );
  /** What the editor of a section shows: each dimension's ceiling above it, and the configured models for `models.routes`. */
  const context = async (
    orgId: string,
    scope: string,
    section: string,
  ): Promise<SectionContext> => {
    const resolved = resolver.resolve(
      await above(orgId, scope.startsWith('agent:')),
    );
    const inSection = Object.entries(resolved.config?.dimensions ?? {}).filter(
      ([path]) => path.startsWith(`${section}.`),
    );
    const ceilings = Object.fromEntries(
      inSection.map(([path, dimension]) => [path, dimension.value]),
    );
    const locked = fixedDimensions(resolved.config?.dimensions ?? {}, section);
    const models = dependencies.pin?.models;
    const options: Record<string, readonly string[]> =
      section === 'models' && models !== undefined
        ? { 'models.routes': configuredRoutes((await models.read(orgId)).llms) }
        : {};
    return { ceilings, options, locked };
  };
  const membership = directoryMembership(container, dependencies);
  const agents = boundOrNull<CachingAgentDirectory>(
    container,
    CONTROL_PLANE_AGENT_DIRECTORY,
  );
  const pin = boundOrNull<AdminPinServices>(
    container,
    CONTROL_PLANE_PIN_SERVICES,
  );
  for (const [key, value] of controlPlaneAdminBindings({
    transaction: controlPlane,
    resolver,
    audit: new ChainConfigAuditLog(journal.audit),
    ...(membership !== null ? { membership } : {}),
    ...(agents !== null ? { agents } : {}),
    ...(backing !== undefined
      ? {
          policy: {
            layers: backing.layers,
            narrows,
            context,
            websites: {
              rules: () => websiteHostRules(),
              deploymentCap: () => websiteCap,
            },
            repositories: {
              presets: () => repositoryPresets(),
              deploymentCap: () => repositoryCap,
              orgDefault: () => releaseRepositoryDefault(),
            },
            deployment: sectionDeployment(dependencies.repositoryCache),
            sections: policySectionRulesOf(container),
            dimensions:
              boundOrNull<readonly string[]>(
                container,
                CONTROL_PLANE_POLICY_EDITION_DIMENSIONS,
              ) ?? [],
            ...(dependencies.groupMembership !== undefined
              ? { accessGroups: dependencies.groupMembership }
              : {}),
          },
        }
      : {}),
    ...(pin !== null ? { pin } : {}),
  })) {
    if (!container.isBound(key)) container.bind(key).toConstantValue(value);
  }
};
