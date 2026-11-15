import type { CodingEnginePreferences } from '../../../../modules/agent-harness/ports/coding-engines';
import { pickHarnessStore } from '../stores';
import { MongoCodingEnginePreferences } from './mongo';
import { PgCodingEnginePreferences } from './pg';

export const createCodingEnginePreferences = (): CodingEnginePreferences =>
  pickHarnessStore<CodingEnginePreferences>(
    'agent-harness/coding-engine-preferences',
    {
      mongo: () => new MongoCodingEnginePreferences(),
      postgres: () => new PgCodingEnginePreferences(),
    },
  );
