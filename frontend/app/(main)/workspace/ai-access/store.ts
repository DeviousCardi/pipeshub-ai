'use client';

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { ModelAccountsApi, isAccountsError, toAccountsError } from '../ai-accounts/api';
import type { Load } from '../ai-accounts/components/load-state';
import type {
  AccountsError,
  CloudAccountInput,
  EngineProfileNarrowing,
  EngineProfileSettings,
  ModelAccessView,
  ModelAccount,
  OrgAccessPolicy,
} from '../ai-accounts/types';

const failed = (error: unknown): { status: 'error'; error: AccountsError } => ({
  status: 'error',
  error: isAccountsError(error) ? error : toAccountsError(error),
});

interface OrgAccessState {
  cloud: Load<ModelAccount[]>;
  access: Load<ModelAccessView>;
  engine: Load<EngineProfileSettings>;
  loadCloud: (quiet?: boolean) => Promise<void>;
  loadAccess: (quiet?: boolean) => Promise<void>;
  loadEngine: (quiet?: boolean) => Promise<void>;
  /** The writes reject with an `AccountsError` and leave the shown state as it was. */
  createCloud: (input: CloudAccountInput) => Promise<void>;
  rotateCloud: (accountId: string, input: Omit<CloudAccountInput, 'provider'>) => Promise<void>;
  removeCloud: (accountId: string) => Promise<void>;
  saveAccess: (policy: OrgAccessPolicy) => Promise<void>;
  saveEngine: (ceiling: EngineProfileNarrowing | null) => Promise<void>;
  reset: () => void;
}

const initial = {
  cloud: { status: 'loading' } as Load<ModelAccount[]>,
  access: { status: 'loading' } as Load<ModelAccessView>,
  engine: { status: 'loading' } as Load<EngineProfileSettings>,
};

/** "Organization AI accounts and access": three independent sections, so one outage hides only its own. */
export const useOrgAccessStore = create<OrgAccessState>()(
  devtools(
    (set, get) => ({
      ...initial,

      loadCloud: async (quiet = false) => {
        if (!quiet) set({ cloud: { status: 'loading' } });
        try {
          set({ cloud: { status: 'ready', data: await ModelAccountsApi.listOrg() } });
        } catch (error) {
          set({ cloud: failed(error) });
        }
      },

      loadAccess: async (quiet = false) => {
        if (!quiet) set({ access: { status: 'loading' } });
        try {
          set({ access: { status: 'ready', data: await ModelAccountsApi.adminAccess() } });
        } catch (error) {
          set({ access: failed(error) });
        }
      },

      loadEngine: async (quiet = false) => {
        if (!quiet) set({ engine: { status: 'loading' } });
        try {
          set({ engine: { status: 'ready', data: await ModelAccountsApi.engineProfile() } });
        } catch (error) {
          set({ engine: failed(error) });
        }
      },

      createCloud: async (input) => {
        await ModelAccountsApi.createOrg(input);
        await get().loadCloud(true);
      },

      rotateCloud: async (accountId, input) => {
        await ModelAccountsApi.rotateOrg(accountId, input);
        await get().loadCloud(true);
      },

      removeCloud: async (accountId) => {
        try {
          await ModelAccountsApi.removeOrg(accountId);
        } catch (error) {
          if (!isAccountsError(error) || error.kind !== 'not_found') throw error;
        }
        await get().loadCloud(true);
      },

      // Each save names the revision it was edited from; a newer save by someone else rejects with `conflict`.
      saveAccess: async (policy) => {
        const read = get().access;
        const revision = read.status === 'ready' ? read.data.revision : null;
        set({ access: { status: 'ready', data: await ModelAccountsApi.putAdminAccess(policy, revision) } });
      },

      saveEngine: async (ceiling) => {
        const read = get().engine;
        const revision = read.status === 'ready' ? read.data.revision : null;
        set({ engine: { status: 'ready', data: await ModelAccountsApi.putEngineProfile(ceiling, revision) } });
      },

      reset: () => set(initial),
    }),
    { name: 'org-ai-access' },
  ),
);
