import { ulid } from '../../libs/utils/ulid';
import type {
  SecretCipher,
  VaultKeyValueStore,
} from '../../libs/vault/versioned-secret-documents';
import {
  KvBindingVault,
  KvOAuthStateStore,
} from './adapters/kv/kv-binding-vault';
import { createBindingStore } from '../../libs/repositories/control-plane/bindings';
import { BindingService } from './application/binding-service';
import { createPolicyStore } from '../../libs/repositories/control-plane/policy';
import { createOrgRoles } from '../../libs/repositories/control-plane/user-directory';
import { UnreadableDirectory } from './adapters/unreadable-directory';
import { PolicyStoreDelegation } from './application/policy-store-delegation';
import { RoleAuthorizer } from './application/role-authorizer';
import type { PolicyResolver } from './domain/policy-alias';
import type { ControlPlaneTransaction } from './ports/transaction';
import { ExtensionRegistry } from './application/extension-registry';
import { VaultCredentialBinder } from './application/vault-credential-binder';
import type { BindingStore } from './ports/binding-store';
import { harnessModule } from './modules/harness';
import { mcpModule } from './modules/mcp';
import { skillsModule } from './modules/skills';
import { toolsetsModule } from './modules/toolsets';
import type { DomainModule } from './ports/extension-points';
import { CompositeCatalogStore } from './adapters/composite-catalog-store';
import { ReleaseCatalogStore } from './adapters/release-catalog-store';
import { createOrgCatalogStore } from '../../libs/repositories/control-plane/catalog';
import { createGrantStore } from '../../libs/repositories/control-plane/grant-store';
import { createInstallationStore } from '../../libs/repositories/control-plane/installations';
import { GrantAdmin, type AdminPinServices } from './application/grant-admin';
import { InstallationAdmin } from './application/installation-admin';
import { PolicyAdmin, type PolicyAdminDeps } from './application/policy-admin';
import { buildReleaseCatalog } from './application/release-catalog';
import type { ConfigAuditPages } from './ports/config-audit-log';
import type { AgentDirectory, MembershipPort } from './ports/directory';
import {
  CONTROL_PLANE_AUDIT_READER,
  CONTROL_PLANE_AUTHORIZER,
  CONTROL_PLANE_CATALOG,
  CONTROL_PLANE_GRANT_ADMIN,
  CONTROL_PLANE_INSTALLATION_ADMIN,
  CONTROL_PLANE_MEMBERSHIP,
  CONTROL_PLANE_PIN_SERVICES,
  CONTROL_PLANE_POLICY_ADMIN,
} from './transport/admin-keys';

/** The production domain modules; a new domain is one more entry (03-interfaces §3.3). */
export const CONTROL_PLANE_MODULES: readonly DomainModule[] = [
  toolsetsModule,
  mcpModule,
  skillsModule,
  harnessModule,
];

export function createExtensionRegistry(
  modules: readonly DomainModule[] = CONTROL_PLANE_MODULES,
): ExtensionRegistry {
  const registry = new ExtensionRegistry();
  for (const module of modules) registry.register(module);
  return registry;
}

export interface BindingServiceDependencies {
  /** The deployment's control-plane write transaction (CPD-1). */
  transaction: ControlPlaneTransaction;
  /** The KV store the vault lives in. */
  kv: VaultKeyValueStore;
  /** The platform cipher (`SECRET_KEY`), looked up at first use. */
  cipher: () => SecretCipher;
  /** The binding store; absent: `cpBindings` in MongoDB. */
  bindings?: BindingStore;
}

/**
 * CPD-8: bindings and credentials — the Mongo binding store, the vault binder
 * and the service the "My connections" and internal binding routes use. The
 * agent harness binds it (`binders/credential-bindings.ts`).
 */
export function createBindingService(
  deps: BindingServiceDependencies,
): BindingService {
  const cipher: SecretCipher = {
    encrypt: (text) => deps.cipher().encrypt(text),
    decrypt: (text) => deps.cipher().decrypt(text),
  };
  const bindings = deps.bindings ?? createBindingStore();
  return new BindingService(
    bindings,
    new VaultCredentialBinder({
      transaction: deps.transaction,
      bindings,
      vault: new KvBindingVault(deps.kv, cipher),
      states: new KvOAuthStateStore(deps.kv),
      oauthStarts: [],
      newId: () => ulid(),
      now: () => Date.now(),
    }),
  );
}

export interface ControlPlaneAdminOptions {
  readonly transaction: ControlPlaneTransaction;
  /** CPD-3's resolver (agent-harness `domain/policy`), passed in. */
  readonly resolver: PolicyResolver;
  readonly registry?: ExtensionRegistry;
  /** Team membership and agent edit rights; absent, their rules deny (fail closed). */
  readonly membership?: MembershipPort;
  readonly agents?: AgentDirectory;
  /** CPD-4's policy layers and the check of a layer against those above it; absent, the policy routes are `CP_UNAVAILABLE`. */
  readonly policy?: Pick<
    PolicyAdminDeps,
    'layers' | 'narrows' | 'context' | 'websites' | 'repositories' | 'deployment' | 'accessGroups' | 'sections' | 'dimensions'
  >;
  readonly audit?: ConfigAuditPages;
  /** Bound unless `CONTROL_PLANE_PIN=off`. */
  readonly pin?: AdminPinServices;
}

/**
 * CPD-11: what the admin routes resolve, by container key, over the Mongo
 * stores. The agent harness binds each pair (`binders/control-plane-admin.ts`).
 */
export function controlPlaneAdminBindings(
  options: ControlPlaneAdminOptions,
): ReadonlyArray<readonly [string, unknown]> {
  const now = (): number => Date.now();
  const registry = options.registry ?? createExtensionRegistry();
  const installations = createInstallationStore();
  const grants = createGrantStore();
  const catalog = new CompositeCatalogStore(
    new ReleaseCatalogStore(buildReleaseCatalog(registry)),
    createOrgCatalogStore(),
  );
  const unreadable = new UnreadableDirectory();
  const roles = createOrgRoles();
  const authorizer = new RoleAuthorizer(
    roles,
    options.membership ?? unreadable,
    options.agents ?? unreadable,
    new PolicyStoreDelegation(createPolicyStore()),
    (options.policy?.sections ?? [])
      .filter((rule) => rule.adminOnly === true)
      .map((rule) => rule.section),
  );
  const bindings: Array<readonly [string, unknown]> = [
    [CONTROL_PLANE_AUTHORIZER, authorizer],
    [CONTROL_PLANE_CATALOG, catalog],
    [
      CONTROL_PLANE_INSTALLATION_ADMIN,
      new InstallationAdmin({
        catalog,
        installations,
        grants,
        transaction: options.transaction,
        validator: (kind) => registry.validator(kind),
        newId: () => `inst_${ulid()}`,
        now,
      }),
    ],
    [
      CONTROL_PLANE_GRANT_ADMIN,
      new GrantAdmin({
        grants,
        installations,
        transaction: options.transaction,
      }),
    ],
  ];
  if (options.membership !== undefined)
    bindings.push([CONTROL_PLANE_MEMBERSHIP, options.membership]);
  if (options.pin !== undefined)
    bindings.push([CONTROL_PLANE_PIN_SERVICES, options.pin]);
  if (options.audit !== undefined)
    bindings.push([CONTROL_PLANE_AUDIT_READER, options.audit]);
  if (options.policy !== undefined) {
    bindings.push([
      CONTROL_PLANE_POLICY_ADMIN,
      new PolicyAdmin({
        ...options.policy,
        transaction: options.transaction,
        now,
      }),
    ]);
  }
  return bindings;
}
