import type { ControlPlaneDataMigration } from '../ports/data-migration';
import {
  CAPABILITY_MIGRATION_ID,
  CapabilityMigration,
} from './capability-migration';
import {
  POLICY_LAYERS_MIGRATION_ID,
  PolicyLayersMigration,
} from './policy-layers-migration';

type DataMigrationClass = abstract new (
  ...args: never[]
) => ControlPlaneDataMigration<unknown>;

/**
 * Every control-plane data migration by id (C-15's data half): a class that
 * rewrites stored documents is registered here, reports before it writes and
 * reverts from its own ledger.
 */
export const CONTROL_PLANE_DATA_MIGRATIONS: Readonly<
  Record<string, DataMigrationClass>
> = {
  [POLICY_LAYERS_MIGRATION_ID]: PolicyLayersMigration,
  [CAPABILITY_MIGRATION_ID]: CapabilityMigration,
};
