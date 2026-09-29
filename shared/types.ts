// API types shared by the server and the web UI. Type-only: no runtime code in this file.

export type Theme = 'system' | 'light' | 'dark';

// ── Workspaces ────────────────────────────────────────────────────────────────
export interface SectionDto {
  id: string;
  slug: string;
  name: string;
  sortOrder: number;
}

export type WorkspaceKind = 'mission' | 'workspace';

export interface WorkspaceDto {
  id: string;
  sectionId: string;
  slug: string;
  name: string;
  kind: WorkspaceKind;
  description: string;
  hasGoals: boolean;
  sortOrder: number;
}

export type HistoryAccess = 'none' | 'search';
export type GeneralContext = 'none' | 'description' | 'description_and_focus';
export type CheckinFrequency = 'off' | 'weekly' | 'biweekly' | 'monthly';

export interface WorkspaceSettingsDto {
  workspaceId: string;
  memoryAutosave: boolean;
  memorySuggestions: boolean;
  historyAccess: HistoryAccess;
  generalContext: GeneralContext;
  checkinFrequency: CheckinFrequency;
  lastCheckinAt: string | null;
  checkinSnoozedUntil: string | null;
  workingFolder: string | null;
}

// ── Providers & models ───────────────────────────────────────────────────────
export type Protocol = 'openai_responses' | 'openai_chat' | 'anthropic_messages' | 'gemini_generate_content';
export type AccessType = 'paid_api' | 'institutional' | 'local' | 'other';
export type AuthType = 'api_key' | 'bearer_token' | 'token_command' | 'none';
export type ConnectionStatus = 'unverified' | 'verified' | 'error' | 'expired' | 'needs_credentials';

export interface ConnectionDto {
  id: string;
  name: string;
  preset: string;
  protocol: Protocol;
  accessType: AccessType;
  baseUrl: string;
  authType: AuthType;
  tokenCommand: string[] | null;
  extraHeaders: Record<string, string>;
  status: ConnectionStatus;
  statusDetail: string | null;
  lastTestedAt: string | null;
  lastVerifiedAt: string | null;
  hasSecret: boolean;
}

export interface ProviderPresetDto {
  key: string;
  name: string;
  protocol: Protocol;
  accessType: AccessType;
  baseUrl: string;
  authType: AuthType;
  tokenCommand?: string[];
  secretLabel?: string;
  docsUrl?: string;
  summary: string;
  authNotes: string;
  modelNotes?: string;
}

export interface ModelDto {
  id: string;
  connectionId: string;
  apiModelId: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsStreaming: boolean;
  supportsTools: boolean;
  supportsImages: boolean;
  supportsPdfs: boolean;
  params: ModelParams;
  enabled: boolean;
  sortOrder: number;
}

export interface ModelParams {
  temperature?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
}

export interface DiscoveredModel {
  apiModelId: string;
  displayName: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  alreadyAdded: boolean;
}

// ── Assistant profiles ───────────────────────────────────────────────────────
export type ProfileKind = 'general' | 'goals' | 'master';
export type ToolGroup = 'web_search' | 'attachments' | 'files' | 'run_command' | 'mission_history' | 'memory_proposals';

export interface ProfileDto {
  id: string;
  kind: ProfileKind;
  workspaceId: string | null;
  defaultKey: string | null;
  name: string;
  description: string;
  instructions: string;
  personality: string;
  tone: string;
  verbosity: string;
  responseStructure: string;
  preferredModelId: string | null;
  tools: ToolGroup[];
  allowedTools: ToolGroup[];
  sortOrder: number;
  canReset: boolean;
}

// ── Conversations ────────────────────────────────────────────────────────────
export interface FolderDto {
  id: string;
  workspaceId: string;
  name: string;
  sortOrder: number;
}

export type ConversationKind = 'chat' | 'goals' | 'master';

export interface ConversationDto {
  id: string;
  workspaceId: string | null;
  kind: ConversationKind;
  folderId: string | null;
  title: string;
  titleIsCustom: boolean;
  selectedProfileId: string | null;
  selectedModelId: string | null;
  draft: string;
  draftAttachmentIds: string[];
  draftUpdatedAt: string | null;
  webSearchEnabled: boolean;
  filesEnabled: boolean;
  summaryThroughSeq: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
}

export interface ConversationListItem {
  id: string;
  kind: ConversationKind;
  title: string;
  folderId: string | null;
  updatedAt: string;
  lastMessageAt: string | null;
  hasDraft: boolean;
}

export interface SearchHit {
  conversationId: string;
  title: string;
  folderId: string | null;
  snippet: string | null;
  messageId: string | null;
  matchedIn: 'title' | 'message';
  updatedAt: string;
}

export type MessageStatus = 'streaming' | 'awaiting_approval' | 'complete' | 'error' | 'cancelled' | 'interrupted';

export interface SourceRef {
  title: string;
  url: string;
  snippet?: string;
  provider: string;
}

export type ToolCallStatus = 'running' | 'awaiting_approval' | 'done' | 'error' | 'denied' | 'cancelled';

export type MessagePart =
  | { type: 'text'; text: string }
  | {
      type: 'tool_call';
      id: string;
      name: string;
      input: unknown;
      status: ToolCallStatus;
      approvalId?: string;
    }
  | {
      type: 'tool_result';
      callId: string;
      name: string;
      summary: string;
      output: string;
      isError: boolean;
      sources?: SourceRef[];
      diff?: string;
    }
  | { type: 'notice'; level: 'info' | 'warning'; text: string };

export interface MessageErrorDto {
  code: string;
  message: string;
  retryable: boolean;
  action?: 'reconnect' | 'settings' | 'retry' | 'choose_model';
  connectionId?: string;
}

export interface ContextReport {
  estimatedTokens: number;
  budgetTokens: number;
  totalMessages: number;
  includedMessages: number;
  summaryThroughSeq: number | null;
  retrievedSeqs: number[];
  omittedRanges: [number, number][];
  memoryIncluded: 'none' | 'brief' | 'mission' | 'all_missions';
  notices: string[];
}

export interface UsageDto {
  inputTokens: number | null;
  outputTokens: number | null;
  estimated: boolean;
}

export type AttachmentKind = 'image' | 'pdf' | 'text' | 'unsupported';
export type ExtractionStatus = 'not_needed' | 'ok' | 'partial' | 'no_text' | 'unsupported' | 'error';

export interface AttachmentDto {
  id: string;
  filename: string;
  mimeType: string;
  kind: AttachmentKind;
  sizeBytes: number;
  extractionStatus: ExtractionStatus;
  extractionDetail: string | null;
  pageCount: number | null;
  charCount: number | null;
  createdAt: string;
}

export interface MessageDto {
  id: string;
  conversationId: string;
  seq: number;
  role: 'user' | 'assistant';
  content: string;
  parts: MessagePart[];
  attachments: AttachmentDto[];
  profileId: string | null;
  profileName: string | null;
  profileKind: ProfileKind | null;
  modelId: string | null;
  modelLabel: string | null;
  connectionLabel: string | null;
  status: MessageStatus;
  error: MessageErrorDto | null;
  usage: UsageDto | null;
  context: ContextReport | null;
  superseded: boolean;
  createdAt: string;
  updatedAt: string;
}

// ── Memory ───────────────────────────────────────────────────────────────────
export type MemoryCategory =
  | 'long_term_goal'
  | 'current_focus'
  | 'progress'
  | 'next_step'
  | 'idea'
  | 'feeling'
  | 'constraint'
  | 'note';
export type MemoryCertainty = 'confirmed' | 'tentative' | 'suggestion';
export type MemoryOrigin = 'user' | 'approved' | 'autosave' | 'import';

export interface MemoryItemDto {
  id: string;
  workspaceId: string;
  category: MemoryCategory;
  certainty: MemoryCertainty;
  text: string;
  origin: MemoryOrigin;
  sourceConversationId: string | null;
  sourceTitle: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'auto_applied' | 'duplicate' | 'stale';

export interface MemoryProposalDto {
  id: string;
  workspaceId: string;
  op: 'add' | 'update' | 'remove';
  targetItemId: string | null;
  targetText: string | null;
  category: MemoryCategory | null;
  certainty: MemoryCertainty | null;
  text: string | null;
  reason: string;
  evidence: string | null;
  importance: 'low' | 'medium' | 'high';
  sourceKind: 'suggestion_scan' | 'goals_assistant';
  sourceConversationId: string | null;
  sourceTitle: string | null;
  status: ProposalStatus;
  statusDetail: string | null;
  changeId: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface MemorySnapshot {
  category: MemoryCategory;
  certainty: MemoryCertainty;
  text: string;
  deleted: boolean;
}

export interface MemoryChangeDto {
  id: string;
  workspaceId: string;
  origin: 'user_edit' | 'proposal_approved' | 'autosave' | 'undo' | 'import';
  summary: string;
  proposalId: string | null;
  undoOfChangeId: string | null;
  undoneByChangeId: string | null;
  createdAt: string;
  ops: { itemId: string; op: 'add' | 'update' | 'remove'; before: MemorySnapshot | null; after: MemorySnapshot | null }[];
}

export interface CheckinStatusDto {
  due: boolean;
  frequency: CheckinFrequency;
  lastCheckinAt: string | null;
}

// ── Tools ────────────────────────────────────────────────────────────────────
export type ApprovalKind = 'run_command' | 'apply_file_edit' | 'read_outside_folder';
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';

export interface ToolApprovalDto {
  id: string;
  conversationId: string;
  messageId: string;
  toolCallId: string;
  kind: ApprovalKind;
  payload: Record<string, unknown>;
  status: ApprovalStatus;
  createdAt: string;
  decidedAt: string | null;
}

export type WebSearchProvider = 'tavily' | 'brave';

export interface ToolSettingsDto {
  webSearchProvider: WebSearchProvider | null;
  webSearchHasKey: boolean;
  commandNetwork: boolean;
  commandTimeoutSeconds: number;
  outsideFolderAccess: 'ask' | 'deny';
  sandboxAvailable: boolean;
}

// ── Settings, backup, system ─────────────────────────────────────────────────
export interface WeatherSettings {
  enabled: boolean;
  locationName: string | null;
  latitude: number | null;
  longitude: number | null;
  units: 'celsius' | 'fahrenheit';
}

export type WeatherDto =
  | { status: 'disabled' }
  | { status: 'ok'; temperature: number; units: 'celsius' | 'fahrenheit'; description: string; locationName: string; observedAt: string; fetchedAt: string; stale: boolean }
  | { status: 'unavailable'; reason: string };

export interface BackupSettingsDto {
  directory: string;
  isDefaultDirectory: boolean;
  automatic: boolean;
  lastBackupAt: string | null;
  lastBackupError: string | null;
  retention: string;
}

export interface BackupEntryDto {
  id: string;
  createdAt: string;
  reason: 'automatic' | 'manual' | 'before_restore' | 'before_import' | 'before_migration';
  sizeBytes: number;
  schemaVersion: number;
  attachmentCount: number;
}

export interface ImportPreviewDto {
  token: string;
  createdAt: string;
  appVersion: string;
  schemaVersion: number;
  counts: Record<string, number>;
  conflicts: Record<string, number>;
  warnings: string[];
}

export interface UsageSummaryDto {
  since: string;
  rows: { purpose: string; calls: number; inputTokens: number; outputTokens: number; estimated: boolean }[];
  recent: {
    createdAt: string;
    purpose: string;
    modelLabel: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    estimated: boolean;
    status: string;
    detail: string | null;
  }[];
}

export interface AppInfoDto {
  name: string;
  version: string;
  mode: 'production' | 'development' | 'test';
  port: number;
  dataDir: string;
  dbFile: string;
  schemaVersion: number;
  secretStore: string;
  idleShutdownMinutes: number | null;
  startedAt: string;
  bootId: string;
}

export interface BootstrapDto {
  app: AppInfoDto;
  sections: SectionDto[];
  workspaces: WorkspaceDto[];
  preferences: Record<string, unknown>;
}

export interface CatalogModelDto extends ModelDto {
  connectionName: string;
  connectionStatus: ConnectionStatus;
  accessType: AccessType;
  protocol: Protocol;
}

export interface ConversationOptionsDto {
  profiles: ProfileDto[];
  resolvedProfileId: string;
  resolvedModelId: string | null;
  webSearchReady: boolean;
  sandboxAvailable: boolean;
  workingFolder: string | null;
  generating: boolean;
}

export interface ConversationDetailDto {
  conversation: ConversationDto;
  messages: MessageDto[];
  approvals: ToolApprovalDto[];
  options: ConversationOptionsDto;
}

export interface MissionMemoryDto {
  workspaceId: string;
  items: MemoryItemDto[];
  lastChangedAt: string | null;
  pendingCount: number;
  autosave: boolean;
  checkin: CheckinStatusDto;
}

export interface DraftDto {
  text: string;
  attachmentIds: string[];
  updatedAt: string | null;
}

// ── Live events (server → all open views) ────────────────────────────────────
export type AppEvent =
  | { type: 'hello'; bootId: string }
  | { type: 'workspaces.changed' }
  | { type: 'folders.changed'; workspaceId: string }
  | { type: 'conversations.changed'; workspaceId: string | null; conversationId?: string }
  | { type: 'conversation.updated'; conversationId: string; workspaceId: string | null }
  | {
      type: 'draft.updated';
      key: string;
      conversationId: string | null;
      draft: string;
      attachmentIds: string[];
      updatedAt: string;
    }
  | { type: 'messages.changed'; conversationId: string }
  | {
      type: 'message.delta';
      conversationId: string;
      messageId: string;
      partIndex: number;
      offset: number;
      text: string;
    }
  | {
      type: 'message.parts';
      conversationId: string;
      messageId: string;
      parts: MessagePart[];
      status: MessageStatus;
    }
  | { type: 'memory.changed'; workspaceId: string }
  | { type: 'proposals.changed'; workspaceId: string }
  | { type: 'approvals.changed'; conversationId: string }
  | { type: 'preferences.changed'; keys: string[] }
  | {
      type: 'settings.changed';
      area: 'connections' | 'models' | 'profiles' | 'workspace_settings' | 'tools' | 'backup' | 'weather';
    }
  | { type: 'usage.changed' }
  | { type: 'data.restored' };

export type AppEventEnvelope = AppEvent & { originClientId?: string };
