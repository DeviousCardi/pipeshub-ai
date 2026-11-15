/** A1 test support: model access over in-memory configured models and an in-memory policy document. */
import { InMemoryConfigDocumentStore } from '../../../../src/modules/agent-harness/adapters/in-memory-config-document-store';
import { ConfigModelAccessPolicies } from '../../../../src/modules/agent-harness/application/model-access-policies';
import {
  ModelAccessService,
  ModelAccessServiceOptions,
} from '../../../../src/modules/agent-harness/application/model-access-service';
import { ModelAccessDocument } from '../../../../src/modules/agent-harness/domain/model-access';
import {
  ConfiguredModel,
  ConfiguredModels,
} from '../../../../src/modules/agent-harness/ports/model-access';
import { testControlPlane } from '../../control-plane/support/in-memory';

export interface TestModel extends ConfiguredModel {
  isDefault?: boolean;
}

/** The org's default model in these tests: an OpenAI model reached with the org's key. */
export const DEFAULT_MODEL: TestModel = {
  provider: 'openAI',
  modelKey: 'm-default',
  modelNames: ['gpt-5', 'gpt-5-mini'],
  isDefault: true,
};

/** The models `support/agent-definition.ts`'s agent grants, as the org configured them. */
export const AGENT_MODELS: TestModel[] = [
  { provider: 'openAI', modelKey: 'model-1', modelNames: ['gpt-x'] },
  { provider: 'anthropic', modelKey: 'model-2', modelNames: ['claude-x'] },
];

/** `aiModels` as `AiModelsConfiguredModels` reads it: by key, or the entry marked default. */
export class InMemoryConfiguredModels implements ConfiguredModels {
  down = false;

  constructor(public entries: TestModel[] = [DEFAULT_MODEL, ...AGENT_MODELS]) {}

  async find(
    _orgId: string,
    modelKey: string | undefined,
  ): Promise<ConfiguredModel | null> {
    if (this.down) throw new Error('kv down');
    const found = this.entries.find((entry) =>
      modelKey === undefined
        ? entry.isDefault === true
        : entry.modelKey === modelKey,
    );
    return found === undefined
      ? null
      : {
          provider: found.provider,
          modelKey: found.modelKey,
          modelNames: [...found.modelNames],
        };
  }

  async list(_orgId: string): Promise<ConfiguredModel[]> {
    if (this.down) throw new Error('kv down');
    return this.entries.map((entry) => ({
      provider: entry.provider,
      modelKey: entry.modelKey,
      modelNames: [...entry.modelNames],
      ...(entry.location !== undefined ? { location: { ...entry.location } } : {}),
    }));
  }

  /** MG-15: the embedding model in use; set only by the tests that read it. */
  embedding?: (orgId: string) => Promise<ConfiguredModel>;
}

export function testModelAccess(
  overrides: Partial<ModelAccessServiceOptions> = {},
): ModelAccessService {
  return new ModelAccessService({
    offering: 'oss',
    policies: new ConfigModelAccessPolicies(
      new InMemoryConfigDocumentStore<ModelAccessDocument>(), testControlPlane(),
      () => 7,
    ),
    models: new InMemoryConfiguredModels(),
    ...overrides,
  });
}
