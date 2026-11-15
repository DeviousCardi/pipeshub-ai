'use client';

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { ModelAccountsApi, toAccountsError, isAccountsError } from './api';
import type { Load } from './components/load-state';
import type { AccountsError, ModelAccessView, ModelAccount } from './types';

const failed = (error: unknown): { status: 'error'; error: AccountsError } => ({
  status: 'error',
  error: isAccountsError(error) ? error : toAccountsError(error),
});

interface MyAccountsState {
  accounts: Load<ModelAccount[]>;
  access: Load<ModelAccessView>;
  /** `quiet` keeps what is shown until the answer arrives (a refresh after a write). */
  loadAccounts: (quiet?: boolean) => Promise<void>;
  loadAccess: () => Promise<void>;
  /** Rejects with an `AccountsError`; the list is re-read from the server on success. */
  saveKey: (provider: string, apiKey: string, label: string | null) => Promise<void>;
  removeKey: (provider: string) => Promise<void>;
  reset: () => void;
}

const initial = {
  accounts: { status: 'loading' } as Load<ModelAccount[]>,
  access: { status: 'loading' } as Load<ModelAccessView>,
};

/** "My AI accounts": the caller's own keys (metadata only) and what the org lets them use. */
export const useMyAccountsStore = create<MyAccountsState>()(
  devtools(
    (set, get) => ({
      ...initial,

      loadAccounts: async (quiet = false) => {
        if (!quiet) set({ accounts: { status: 'loading' } });
        try {
          set({ accounts: { status: 'ready', data: await ModelAccountsApi.listOwn() } });
        } catch (error) {
          set({ accounts: failed(error) });
        }
      },

      loadAccess: async () => {
        set({ access: { status: 'loading' } });
        try {
          set({ access: { status: 'ready', data: await ModelAccountsApi.access() } });
        } catch (error) {
          set({ access: failed(error) });
        }
      },

      saveKey: async (provider, apiKey, label) => {
        await ModelAccountsApi.putOwn(provider, apiKey, label);
        await get().loadAccounts(true);
      },

      removeKey: async (provider) => {
        try {
          await ModelAccountsApi.removeOwn(provider);
        } catch (error) {
          // Removed elsewhere already: the list below shows the truth.
          if (!isAccountsError(error) || error.kind !== 'not_found') throw error;
        }
        await get().loadAccounts(true);
      },

      reset: () => set(initial),
    }),
    { name: 'my-ai-accounts' },
  ),
);
