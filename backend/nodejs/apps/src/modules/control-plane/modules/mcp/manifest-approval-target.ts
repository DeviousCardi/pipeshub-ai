import type { ApprovalRequest, ChangeKind } from '../../domain/objects';
import type {
  ApprovalTargetHandler,
  ApprovalTargetState,
  ApprovalVerdict,
} from '../../ports/approval-targets';
import type { Applied, CpTx } from '../../ports/transaction';

/** What applying an approved manifest does: the MCP hub's own write (today's Python route, as a driver). */
export type ManifestApprovalEffect = (
  request: ApprovalRequest,
  subset: readonly string[] | null,
) => Promise<unknown>;

const DESCRIPTOR_CHANGE: ReadonlySet<ChangeKind> = new Set<ChangeKind>([
  'descriptor_change',
]);

/**
 * An MCP instance's tool manifest as an approval target until its instances
 * are control-plane installations (CPD-7). The instance is the org's and the
 * hub holds no revision the control plane can compare: the hub's own check
 * (an approved digest that is not the live one is refused) is what keeps an
 * approval to what the approver saw.
 */
export class McpManifestApprovalTarget implements ApprovalTargetHandler {
  readonly type = 'installation' as const;
  readonly changes = DESCRIPTOR_CHANGE;

  constructor(private readonly approveManifest: ManifestApprovalEffect) {}

  current(_orgId: string, _id: string): Promise<ApprovalTargetState> {
    return Promise.resolve({ revision: 0, owner: 'org', kind: 'mcp' });
  }

  apply(
    tx: CpTx,
    request: ApprovalRequest,
    verdict: ApprovalVerdict,
  ): Promise<Applied<unknown> | null> {
    if (verdict.state === 'rejected') return Promise.resolve(null);
    return Promise.resolve(
      tx.external(() => this.approveManifest(request, verdict.subset)),
    );
  }
}
