'use client';

export {
  useAuthStore,
  type User,
  logoutAndRedirect,
  logoutFromWorkspaceMenu,
  switchToSignedInWorkspace,
  ELECTRON_SERVER_URL_NAVIGATION_EVENT,
} from '@/lib/store/auth-store';
export { useInitializeUserProfile } from '@/lib/hooks/use-initialize-user-profile';
export { useInitializeOrgProfile } from '@/lib/hooks/use-initialize-org-profile';

export {
  useOrgStore,
  selectIsOrgInitialized,
  type OrgStore,
} from '@/lib/store/org-store';

// API (axios instance — consumed via the `@/lib/api` barrel)
export { apiClient, default as apiClientDefault } from '@/lib/api/axios-instance';

// UI Components
export { SettingsSection } from '@/app/components/workspace-menu/settings-section';
export { WorkspaceMenu } from '@/app/components/workspace-menu/menu';
export { GuestGuard } from '@/app/components/ui/guest-guard';
// Sign-in answers and notices a build adds (OSS: none; a refused sign-in shows its ordinary error)
export { takeSignInRefusal } from '@/lib/auth/sign-in-refusal';
export { SignInNotices } from '@/app/(public)/components/sign-in-notices';
export { AgentBuilder } from '@/app/(main)/agents/agent-builder/agent-builder';
export { CreateAgentDialog } from '@/app/(main)/agents/components/create-agent-dialog';
export { AgentSidebarListRow } from '@/app/(main)/chat/sidebar/agent-sidebar-list-row';
export { ChatSidebarFooter } from '@/app/(main)/chat/sidebar/footer';
export { AgentChatHeader } from '@/app/(main)/chat/components/agent-chat-header';
export { OAuthAppSelector } from '@/app/(main)/workspace/connectors/components/authenticate-tab/oauth-app-selector';
// Users page header — Requests + Blocked Users (Admin Org) between search and Invite
export { UsersPageHeaderActions } from '@/app/(main)/workspace/users/components/users-page-header-actions';
export { isMcpInstanceReadOnly, McpInheritedBadge, McpInheritedCallout, McpInstanceBadges } from '@/app/(main)/workspace/mcp-servers/team/components/mcp-inheritance-guards';
export { useUserPermission } from '@/lib/hooks/use-user-permission';
export { PermissionLockIcon } from '@/app/components/ui/permission-lock-icon';
export { PermissionDeniedDialog, usePermissionDeniedDialog } from '@/app/components/ui/permission-denied-dialog';
export { InheritedConfigNotice } from '@/app/(main)/workspace/components/inherited-config-notice';
export { KbListView } from '@/app/(main)/knowledge-base/components/kb-list-view';
export { KbGridView } from '@/app/(main)/knowledge-base/components/kb-grid-view';
export { FolderTreeItem } from '@/app/(main)/knowledge-base/sidebar/section-element/folder-tree-item';
export type { FolderTreeItemProps } from '@/app/(main)/knowledge-base/sidebar/section-element/folder-tree-item';
export { SelectionActionBar } from '@/app/(main)/knowledge-base/components/selection-action-bar';
export { useShouldPollServiceHealth } from '@/lib/hooks/use-should-poll-service-health';
// Brand context; pass loadBrand to read the brand from somewhere (OSS: PipesHub defaults)
export { BrandProvider } from '@/lib/branding';
export { BrandMark } from '@/app/components/ui/brand-mark';
export { BrandWordmark } from '@/app/components/ui/brand-wordmark';
// App-shell extras and the invite-users sidebar (OSS: nothing / the OSS sidebar)
export { AppLayoutExtras } from '@/app/(main)/components/app-layout-extras';
export { InviteUsersSidebar } from '@/app/(main)/workspace/users/components/invite-users-sidebar';
// Extra content on a person's profile panel (OSS: nothing)
export { PersonPanelExtras } from '@/app/(main)/workspace/users/components/person-panel-extras';
// Extra details editions can show in chat, search, knowledge-base and connector views (OSS: nothing)
export { ChatMessageExtras } from '@/app/(main)/chat/components/message-area/message-extras';
// More of the thumbs-down popover, adding fields to the rating (OSS: nothing)
export { FeedbackDislikeExtras } from '@/app/(main)/chat/components/message-area/feedback-dislike-extras';
export type { FeedbackDislikeExtrasProps } from '@/app/(main)/chat/components/message-area/feedback-dislike-extras';
export { ConversationHeaderOverlay } from '@/app/(main)/chat/components/conversation-header-overlay';
export { SearchResultsExtras } from '@/app/(main)/chat/components/search-results/search-results-extras';
export { useKbListExtraColumns } from '@/app/(main)/knowledge-base/hooks/use-kb-list-extra-columns';
export { ConnectorOverviewExtras } from '@/app/(main)/workspace/connectors/components/instance-panel/connector-overview-extras';
export { ConnectorConfigureExtras } from '@/app/(main)/workspace/connectors/components/configure-tab/connector-configure-extras';
// Team connectors to warn about before setup: their data is searchable by the whole organization (OSS: no source permissions applied)
export { TEAM_CONNECTOR_VISIBILITY_WARNINGS } from '@/app/(main)/workspace/connectors/utils/team-visibility-warning';
// A toolset's "Tool approvals" (OSS: what its tools do by default; organization rules aren't set here)
export { ToolsetToolRulesNotice as ToolsetToolRulesDialog } from '@/app/(main)/workspace/actions/components/toolset-tool-rules-notice';
// Notices for features this edition does not include (OSS: shown)
export { EnterpriseFeatureNotice } from '@/app/components/ui/enterprise-badge';
export { McpAgentApprovalsNotice } from '@/app/(main)/agents/agent-builder/components/mcp-agent-approvals-notice';
// Rules beyond the usual one that decide who approves an ask, and the card's note for one (OSS: none; nothing shown)
export { approvalAskRules } from '@/app/(main)/chat/approval-ask-rules';
export type { ApprovalAskRules } from '@/app/(main)/chat/approval-ask-rules';
export { ApprovalAskNote } from '@/app/(main)/chat/components/message-area/approval-ask-note';
export type { ApprovalAskNoteProps } from '@/app/(main)/chat/components/message-area/approval-ask-note';
// What an answer stopped by a budget beyond the run's own says (OSS: nothing; the spending-limit notice shows)
export { budgetStopLines } from '@/app/(main)/chat/budget-stop-lines';
// Run endings an edition's own rules end runs with, worded, with their next step (OSS: none)
export { runErrorExtras } from '@/app/(main)/chat/run-error-extras';
export type { RunErrorExtras } from '@/app/(main)/chat/run-error-extras';
// More settings cards at the end of the AI Access page (OSS: none)
export { AiAccessExtras } from '@/app/(main)/workspace/ai-access/components/ai-access-extras';
// Rows the Services page adds after its own (OSS: none)
export { serviceRowExtras } from '@/app/(main)/workspace/services/service-row-extras';
export type { ServiceRowExtra } from '@/app/(main)/workspace/services/service-row-extras';
// More settings cards on the general page (OSS: none)
export { GeneralSettingsExtras } from '@/app/(main)/workspace/general/components/general-settings-extras';
// The general page's delete-the-organization section (OSS: deleted at once behind the typed name)
export { DeleteOrgSection } from '@/app/(main)/workspace/general/components/delete-org-section';
// Header actions and the record checks of the audit pages (OSS: none)
export { AuditPageActions, AuditChainCheck } from '@/app/(main)/workspace/file-downloads/components/audit-page-extras';
// Extra settings in the agent card's "How it runs" group (OSS: none)
export { AgentRuntimeExtras } from '@/app/(main)/agents/agent-builder/components/agent-runtime-extras';
// More of the agent's environment in the builder's "Environment" section (OSS: none)
export { AgentEnvironmentExtras } from '@/app/(main)/agents/agent-builder/components/agent-environment-extras';
export type { AgentEnvironmentExtrasProps } from '@/app/(main)/agents/agent-builder/components/agent-environment-extras';
// Who an agent's external writes are from, on AI access (OSS: the user's own account with the AI disclosure, read only)
export { AiDisclosureSection as AiAccessWriteIdentity } from '@/app/(main)/workspace/ai-access/components/ai-disclosure-section';
// More engine settings on AI Access, after the coding sandbox caches (OSS: none)
export { AiAccessEnginesExtras } from '@/app/(main)/workspace/ai-access/components/ai-access-engines-extras';
// The action types a dry run says go from a bot account (OSS: none)
export { dryRunBotActions } from '@/app/(main)/agents/agent-builder/dry-run-bot-actions';
// Chat model menu entries and AI model form settings (OSS: none)
export { chatModelOptions } from '@/app/(main)/chat/utils/chat-model-options';
export { modelUnavailableReasons } from '@/app/(main)/chat/utils/model-unavailable-reasons';
export type { ModelUnavailableReasons } from '@/app/(main)/chat/utils/model-unavailable-reasons';
export { ModelSelectorExtraOptions } from '@/app/(main)/chat/components/chat-panel/expansion-panels/model-selector/model-selector-extra-options';
export { aiModelFormOptions } from '@/app/(main)/workspace/ai-models/ai-model-form-options';
export { PickedModelExtraFields } from '@/app/(main)/workspace/ai-models/components/picked-model-extra-fields';
// The Run settings page's list of running agent work (OSS: the list, each run with Cancel)
export { RunningNow as RunSettingsRunningNow } from '@/app/(main)/workspace/run-settings/components/running-now';
// The Run settings page's safety stops: an engine version and sandbox internet for the org (OSS: both, with resume)
export { SafetyStops as RunSettingsSafetyStops } from '@/app/(main)/workspace/run-settings/components/safety-stops';
// Entries an edition adds to the workspace sidebar (OSS: none)
export { workspaceNavExtras } from '@/app/(main)/workspace/sidebar/workspace-nav-extras';
export type { WorkspaceNavExtra, WorkspaceNavSection } from '@/app/(main)/workspace/sidebar/workspace-nav';
// An edition's sections of the approval policy and what it shows above the editor (OSS: none; the run's actor
// approves, org admins and the session owner may deny)
export { ApprovalPolicyExtras, ApprovalPolicySections } from '@/app/(main)/workspace/approval-policy/components/approval-policy-extras';
export type { ApprovalPolicySectionsProps } from '@/app/(main)/workspace/approval-policy/components/approval-policy-extras';
