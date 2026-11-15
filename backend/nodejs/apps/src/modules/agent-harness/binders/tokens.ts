/** The container tokens the harness binds; other modules read them through `composition`. */
export const AGENT_HARNESS_EXECUTION_SERVICE = 'AgentHarnessExecutionService';
export const AGENT_HARNESS_SESSION_RUN_SERVICE =
  'AgentHarnessSessionRunService';
export const AGENT_HARNESS_SESSION_INTERACTIONS =
  'AgentHarnessSessionInteractions';
export const AGENT_HARNESS_RUN_ADMISSION_SERVICE =
  'AgentHarnessRunAdmissionService';
export const AGENT_HARNESS_RUN_SWEEPER = 'AgentHarnessRunSweeper';
export const AGENT_HARNESS_NEXT_RUNS = 'AgentHarnessNextRuns';
export const AGENT_HARNESS_AUTHORITY = 'AgentHarnessAuthority';
/** ADR-KEY-02: seals each sandbox-plane component's document (its credential, digests, egress keys). */
export const AGENT_HARNESS_COMPONENT_PUBLISHER = 'AgentHarnessComponentPublisher';
/** G-41: who may use the harness, each engine and each model, by the org's groups. */
export const AGENT_HARNESS_GROUP_ACCESS = 'AgentHarnessGroupAccess';
/** G-41: the model groups on turns today's loop serves (classic chat, agents, Slack, MCP). */
export const AGENT_HARNESS_CHAT_MODEL_GROUPS = 'AgentHarnessChatModelGroups';
export const AGENT_HARNESS_SANDBOX_REAPER = 'AgentHarnessSandboxReaper';
export const AGENT_HARNESS_CAPABILITIES = 'AgentHarnessCapabilities';
/** Which features live workers advertise (DUR2: the deploy-order guard for `agent_code`). */
export const AGENT_HARNESS_WORKER_FEATURES = 'AgentHarnessWorkerFeatures';
export const AGENT_HARNESS_RUN_STREAMS = 'AgentHarnessRunStreams';
/** U3: a run's timeline and the session workspace's versions, for the session's owner. */
export const AGENT_HARNESS_RUN_TIMELINES = 'AgentHarnessRunTimelines';
export const AGENT_HARNESS_SESSION_WORKSPACES = 'AgentHarnessSessionWorkspaces';
export const AGENT_HARNESS_SESSION_SANDBOX = 'AgentHarnessSessionSandbox';
/** UX5: the activity panel's stream and command logs, for the run's owner. */
export const AGENT_HARNESS_RUN_ACTIVITY = 'AgentHarnessRunActivity';
export const AGENT_HARNESS_RUN_FOLLOWUPS = 'AgentHarnessRunFollowups';
export const AGENT_HARNESS_DATA_KEYS = 'AgentHarnessDataKeys';
export const AGENT_HARNESS_AUDIT_ANCHORING = 'AgentHarnessAuditAnchoring';
export const AGENT_HARNESS_AUDIT_LINK_WATCH = 'AgentHarnessAuditLinkWatch';
export const AGENT_HARNESS_RUN_CONTENT = 'AgentHarnessRunContent';
export const AGENT_HARNESS_WORKSPACES = 'AgentHarnessWorkspaces';
export const AGENT_HARNESS_SHARED_CITATIONS = 'AgentHarnessSharedCitations';
export const AGENT_HARNESS_SHARED_ARTIFACTS = 'AgentHarnessSharedArtifacts';
export const AGENT_HARNESS_SESSION_PARTICIPANTS =
  'AgentHarnessSessionParticipants';
export const AGENT_HARNESS_SESSION_ERASURES = 'AgentHarnessSessionErasures';
/** SS3: "continue privately". */
export const AGENT_HARNESS_SESSION_FORKS = 'AgentHarnessSessionForks';
export const AGENT_HARNESS_ERASURE_WORKER = 'AgentHarnessErasureWorker';
export const AGENT_HARNESS_RETENTION_SWEEPER = 'AgentHarnessRetentionSweeper';
export const AGENT_HARNESS_SESSION_RETENTION = 'AgentHarnessSessionRetention';
/** A retention pass after the orgs' own periods (`RetentionPass`); unbound: none. */
export const AGENT_HARNESS_RETENTION_PASS = 'AgentHarnessRetentionPass';
/** What an org's model choices show beyond the view's own members (`ModelPlacementSource`); unbound: nothing more. */
export const AGENT_HARNESS_MODEL_PLACEMENT = 'AgentHarnessModelPlacement';
/** OWD-12: where an org's runs may be placed (`RunPlacement`); unbound: every run is placed here. */
export const AGENT_HARNESS_RUN_PLACEMENT = 'AgentHarnessRunPlacement';
export const AGENT_HARNESS_AGENT_ERASURES = 'AgentHarnessAgentErasures';
export const AGENT_HARNESS_GATEWAY_TOKENS = 'AgentHarnessGatewayTokens';
/** The gateway keyring: one per process, shared by every signer of its documents. */
export const AGENT_HARNESS_GATEWAY_KEYRING = 'AgentHarnessGatewayKeyring';
export const AGENT_HARNESS_GATEWAY_AUTHORITY = 'AgentHarnessGatewayAuthority';
/** CPD-10: signs `X-PipesHub-Resolved` with the gateway keyring. */
export const AGENT_HARNESS_RESOLVED_TURNS = 'AgentHarnessResolvedTurns';
/** CPD-10: a legacy turn's header (pin, projection, signature); bound only under `CONTROL_PLANE_PIN=on`. */
export const AGENT_HARNESS_LEGACY_TURN_HEADER = 'AgentHarnessLegacyTurnHeader';
export const AGENT_HARNESS_CHILD_RUNS = 'AgentHarnessChildRuns';
export const AGENT_HARNESS_ENGINE_PROFILES = 'AgentHarnessEngineProfiles';
export const AGENT_HARNESS_BUDGET_LEDGER = 'AgentHarnessBudgetLedger';
/** Budgets runs share, at each reservation (`SharedBudgetGuard`); unbound: none. */
export const AGENT_HARNESS_SHARED_BUDGET_GUARD =
  'AgentHarnessSharedBudgetGuard';
/** The most a schedule's run may budget (`RunBudgetCeiling`); unbound: the release ceiling only. */
export const AGENT_HARNESS_RUN_BUDGET_CEILING = 'AgentHarnessRunBudgetCeiling';
/** The sweep and a person's erasure of the spend records (`CostEraser`); unbound: none kept. */
export const AGENT_HARNESS_COST_ERASER = 'AgentHarnessCostEraser';
export const AGENT_HARNESS_MODEL_ACCOUNTS = 'AgentHarnessModelAccounts';
export const AGENT_HARNESS_MODEL_ACCESS = 'AgentHarnessModelAccess';
/** ENGPICK: the default chat's coding engine and the engine checks its pickers share. */
export const AGENT_HARNESS_CODING_ENGINES = 'AgentHarnessCodingEngines';
/** GIT-FLOW (WP-26): the GitHub repository a chat's coding engine works on. */
export const AGENT_HARNESS_SESSION_REPOSITORIES =
  'AgentHarnessSessionRepositories';
/** SIGNIN: people's own Claude accounts in Claude Code. */
export const AGENT_HARNESS_ENGINE_SIGNINS = 'AgentHarnessEngineSignIns';
/** Who belongs to an org (QA-26): a route naming another user finds them in the caller's org first. */
export const AGENT_HARNESS_ORG_MEMBERS = 'AgentHarnessOrgMembers';
/** P2.11e: the org's approval policy (admins) and the approvals waiting on a viewer (anyone who may decide). */
export const AGENT_HARNESS_APPROVAL_SETTINGS = 'AgentHarnessApprovalSettings';
export const AGENT_HARNESS_APPROVAL_QUEUE = 'AgentHarnessApprovalQueue';
/** ADR-UI-03: names for the agents and groups an admin answer holds, one batched lookup per kind. */
export const AGENT_HARNESS_ADMIN_LIST_NAMES = 'AgentHarnessAdminListNames';
/** Whose runs the approvals waiting on a viewer are read from (`ApprovalQueueReach`); unbound: the viewer's own. */
export const AGENT_HARNESS_APPROVAL_QUEUE_REACH =
  'AgentHarnessApprovalQueueReach';
/** Who besides a run's actor may decide its approvals (`ApproverDirectory`); bound from the dependencies' directory. */
export const AGENT_HARNESS_APPROVERS = 'AgentHarnessApprovers';
/** What checks and names an edition's approval-policy sections on a save (`ApprovalPolicySectionHandler[]`); unbound: none. */
export const AGENT_HARNESS_APPROVAL_POLICY_HANDLERS =
  'AgentHarnessApprovalPolicyHandlers';
/** Rules beyond the usual one an ask may carry (`ApprovalRules`); unbound: the usual rule decides every ask. */
export const AGENT_HARNESS_APPROVAL_RULES = 'AgentHarnessApprovalRules';
/** AP-10: what a scheduled run's actor is sent besides the Inbox when it waits on them (`ScheduledWaitNotices`); unbound: none. */
export const AGENT_HARNESS_SCHEDULED_WAIT_NOTICES = 'AgentHarnessScheduledWaitNotices';
/** AP-08: what is sent when a run starts waiting on a person (`WaitingRunNotices`); unbound: nothing beyond the Inbox. */
export const AGENT_HARNESS_APPROVER_LINK_NOTICES =
  'AgentHarnessApproverLinkNotices';
/** WP56-OUTBOX: written in the commit that makes a run wait (`ApproverNoticeOutbox`); unbound: nothing is written. */
export const AGENT_HARNESS_APPROVER_NOTICE_OUTBOX =
  'AgentHarnessApproverNoticeOutbox';
/** G-13: the questions waiting on the viewer. */
export const AGENT_HARNESS_QUESTION_INBOX = 'AgentHarnessQuestionInbox';
/** G-15: feedback linked to its run and agent version. */
export const AGENT_HARNESS_RUN_FEEDBACK = 'AgentHarnessRunFeedback';
/** Told of every rating (`RatedAnswerSink`); unbound: nothing is kept. */
export const AGENT_HARNESS_RATED_ANSWER_SINK = 'AgentHarnessRatedAnswerSink';
/** AUDITUI: the admin page of an org's workspace downloads. */
export const AGENT_HARNESS_DOWNLOAD_AUDIT = 'AgentHarnessDownloadAudit';
/** J-18: the admin audit search over the org's chain. */
export const AGENT_HARNESS_AUDIT_SEARCH = 'AgentHarnessAuditSearch';
/** Each listed audit record's standing on the chain (`AuditRecordStatusProvider`); unbound: none is shown. */
export const AGENT_HARNESS_AUDIT_RECORD_STATUSES =
  'AgentHarnessAuditRecordStatuses';
/** P2.9: the operator console for unknown effects (admins). */
export const AGENT_HARNESS_UNKNOWN_EFFECTS = 'AgentHarnessUnknownEffects';
export const AGENT_HARNESS_SCHEDULES = 'AgentHarnessSchedules';
export const AGENT_HARNESS_SCHEDULE_FIRER = 'AgentHarnessScheduleFirer';
/** P2.13: knowledge publications at the gateway (the Labs flag, then the query service). */
export const AGENT_HARNESS_PUBLICATIONS = 'AgentHarnessPublications';
/** P7.3: governed memory (the service and the store it keeps memories in). */
export const AGENT_HARNESS_MEMORIES = 'AgentHarnessMemories';
export const AGENT_HARNESS_MEMORY_STORE = 'AgentHarnessMemoryStore';
/** CPD-1: the control-plane write transaction every audited config write goes through. */
export const CONTROL_PLANE_TRANSACTION = 'ControlPlaneTransaction';
/** WP-8: the one execution store every run reader shares. */
export const AGENT_HARNESS_EXECUTION_STORE = 'AgentHarnessExecutionStore';
/** QA-15F: how a run's idempotency key is stored; admission, child runs, erasure and cancel share it. */
export const AGENT_HARNESS_RUN_KEYS = 'AgentHarnessRunKeys';
/** CPD-7: the agent authority as admission asks it, with the control plane's shadow (and, `on`, its visibility rule). */
export const AGENT_HARNESS_AGENT_ACCESS = 'AgentHarnessAgentAccess';
/** CPD-7: the dual write's Node side (the sync route's capability migration). */
export const CONTROL_PLANE_CAPABILITY_SYNC = 'ControlPlaneCapabilitySync';
/**
 * A `ConfigChangeApprovalsFactory` (control-plane `ports/config-approvals`): bound, the MCP manifest and skill
 * candidate routes send each change through it; nothing in this build binds it.
 */
export const CONTROL_PLANE_APPROVALS_FACTORY = 'ControlPlaneApprovalsFactory';
/** CPD-9: the directory caches (team membership, agents) the authorizer reads, and their event subscriber. */
export { CONTROL_PLANE_MEMBERSHIP } from '../../control-plane';
export const CONTROL_PLANE_AGENT_DIRECTORY = 'ControlPlaneAgentDirectory';
/** The policy sections an edition offers beyond the resolver's dimensions (`PolicySectionRule[]`); unbound: none. */
export const CONTROL_PLANE_POLICY_SECTION_RULES =
  'ControlPlanePolicySectionRules';
/** The `EDITION_DIMENSIONS` an edition lets an admin set (`string[]`); unbound: none. */
export const CONTROL_PLANE_POLICY_EDITION_DIMENSIONS =
  'ControlPlanePolicyEditionDimensions';
export const CONTROL_PLANE_DIRECTORY_EVENTS = 'ControlPlaneDirectoryEvents';
/** G-40: each org's external policy webhook settings. */
export const AGENT_HARNESS_POLICY_WEBHOOK = 'AgentHarnessPolicyWebhook';
/** The features an edition's bound services let this Node name to workers (`ClaimFeatureSource`); unbound: none. */
export const AGENT_HARNESS_CLAIM_FEATURES = 'AgentHarnessClaimFeatures';
/** C9.04: where the control-plane metrics route scrapes (`MetricsTargets`); unbound, the deployment's environment. */
export const AGENT_HARNESS_METRICS_TARGETS = 'AgentHarnessMetricsTargets';
/** C9.04: Node's own part of that route (`LocalMetrics`: its harness families, the run store's state); unbound, none. */
export const AGENT_HARNESS_LOCAL_METRICS = 'AgentHarnessLocalMetrics';
/** ADR-OPS-01: the operator controls (stops by scope). */
export const AGENT_HARNESS_OPERATOR_CONTROLS = 'AgentHarnessOperatorControls';
/** ADR-OPS-01 D9: an org admin's list of the org's open runs and the cancel of one. */
export const AGENT_HARNESS_ADMIN_RUNS = 'AgentHarnessAdminRuns';
/** ADR-UI-01 D1, D2 (UI-B1 G1): a person's runs and jobs, their chat list's run state and seen marks. */
export const AGENT_HARNESS_RUN_LISTS = 'AgentHarnessRunLists';
/** ADR-UI-01 D3 (UI-B1 G4): a job's brief. */
export const AGENT_HARNESS_JOB_BRIEFS = 'AgentHarnessJobBriefs';
/** ADR-GRANT-01 D8 (UI-B1 G5): a conversation's grants, listed and revoked by its owner. */
export const AGENT_HARNESS_CONVERSATION_GRANTS =
  'AgentHarnessConversationGrants';

/** G2 (ADR-INBOX-01): a person's Inbox settings, run-notice claims and watch leases. */
export const AGENT_HARNESS_INBOX_STORE = 'AgentHarnessInboxStore';
/** G2: the merged Inbox feed. */
export const AGENT_HARNESS_INBOX = 'AgentHarnessInbox';
/** G2: who is watching which conversation, for the stream routes. */
export const AGENT_HARNESS_RUN_WATCHERS = 'AgentHarnessRunWatchers';
/** G2: whether a person is an admin of their org (the approver directory's answer), for the Inbox. */
export const AGENT_HARNESS_ORG_ADMIN_CHECK = 'AgentHarnessOrgAdminCheck';
/** The query service's org-wide erase, where the user module composes it for an org's delete. */
export const ORG_QUERY_SERVICE_ERASER = 'OrgQueryServiceEraser';
