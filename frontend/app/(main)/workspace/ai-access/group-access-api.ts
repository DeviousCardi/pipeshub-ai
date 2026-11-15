import { apiClient } from '@/lib/api';

export interface ModelChoice {
  modelKey: string;
  name: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** What the group access editor reads besides its section: the org's chat models and the admin's own groups. */
export const GroupAccessApi = {
  /** The org's configured chat models, by key, with the name the AI models page shows. */
  async chatModels(): Promise<ModelChoice[]> {
    const { data } = await apiClient.get<{ models?: unknown[] }>('/api/v1/configurationManager/ai-models/llm', {
      suppressErrorToast: true,
    });
    return (data.models ?? []).filter(isObject).flatMap((model) => {
      const key = typeof model.modelKey === 'string' ? model.modelKey : null;
      if (key === null) return [];
      const configuration = isObject(model.configuration) ? model.configuration : {};
      const name =
        (typeof model.modelFriendlyName === 'string' && model.modelFriendlyName) ||
        (typeof configuration.model === 'string' && configuration.model) ||
        (typeof model.provider === 'string' && model.provider) ||
        key;
      return [{ modelKey: key, name }];
    });
  },

  /** The groups `userId` is in, by id with their names. */
  async groupsOf(userId: string): Promise<Record<string, string>> {
    const { data } = await apiClient.get<unknown[]>(`/api/v1/userGroups/users/${encodeURIComponent(userId)}`, {
      suppressErrorToast: true,
    });
    return Object.fromEntries(
      (Array.isArray(data) ? data : [])
        .filter(isObject)
        .filter((group) => typeof group._id === 'string')
        .map((group) => [group._id as string, typeof group.name === 'string' ? group.name : '']),
    );
  },
};
