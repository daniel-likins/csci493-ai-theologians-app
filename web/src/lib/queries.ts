import { useQuery } from '@tanstack/react-query';
import type {
  BackupEntryDto,
  BackupSettingsDto,
  BootstrapDto,
  CatalogModelDto,
  ConnectionDto,
  ConversationDetailDto,
  ConversationDto,
  ConversationListItem,
  FolderDto,
  MemoryChangeDto,
  MemoryProposalDto,
  MissionMemoryDto,
  ProfileDto,
  ProviderPresetDto,
  SectionDto,
  ToolSettingsDto,
  UsageSummaryDto,
  WeatherDto,
  WeatherSettings,
  WorkspaceDto,
  WorkspaceSettingsDto,
} from '../../../shared/types.ts';
import { api } from '../api/client.ts';

export const useBootstrap = () =>
  useQuery({ queryKey: ['bootstrap'], queryFn: () => api.get<BootstrapDto>('/api/bootstrap'), staleTime: Infinity });

export const useWorkspaces = () =>
  useQuery({
    queryKey: ['workspaces'],
    queryFn: () => api.get<{ sections: SectionDto[]; workspaces: WorkspaceDto[] }>('/api/workspaces'),
    staleTime: 5 * 60_000,
  });

export const useFolders = (workspaceId: string | undefined) =>
  useQuery({ queryKey: ['folders', workspaceId], queryFn: () => api.get<FolderDto[]>(`/api/workspaces/${workspaceId}/folders`), enabled: !!workspaceId });

export const useConversationList = (workspaceId: string | undefined) =>
  useQuery({
    queryKey: ['conversations', workspaceId],
    queryFn: () => api.get<ConversationListItem[]>(`/api/workspaces/${workspaceId}/conversations`),
    enabled: !!workspaceId,
  });

export const useHomeConversations = () =>
  useQuery({ queryKey: ['homeConversations'], queryFn: () => api.get<ConversationListItem[]>('/api/home/conversations') });

export const useConversation = (id: string | null | undefined) =>
  useQuery({
    queryKey: ['conversation', id],
    queryFn: () => api.get<ConversationDetailDto>(`/api/conversations/${id}`),
    enabled: !!id,
    staleTime: 15_000,
  });

export const useGoalsConversation = (workspaceId: string | undefined, enabled = true) =>
  useQuery({
    queryKey: ['goalsConversation', workspaceId],
    queryFn: () => api.get<ConversationDto>(`/api/workspaces/${workspaceId}/goals-conversation`),
    enabled: !!workspaceId && enabled,
    staleTime: Infinity,
  });

export const useMemory = (workspaceId: string | undefined) =>
  useQuery({ queryKey: ['memory', workspaceId], queryFn: () => api.get<MissionMemoryDto>(`/api/workspaces/${workspaceId}/memory`), enabled: !!workspaceId });

export const useProposals = (workspaceId: string | undefined) =>
  useQuery({
    queryKey: ['proposals', workspaceId],
    queryFn: () => api.get<MemoryProposalDto[]>(`/api/workspaces/${workspaceId}/memory/proposals?filter=recent`),
    enabled: !!workspaceId,
  });

export const useChanges = (workspaceId: string | undefined) =>
  useQuery({ queryKey: ['changes', workspaceId], queryFn: () => api.get<MemoryChangeDto[]>(`/api/workspaces/${workspaceId}/memory/changes`), enabled: !!workspaceId });

export const useModels = () => useQuery({ queryKey: ['models'], queryFn: () => api.get<CatalogModelDto[]>('/api/models') });

export const useProfiles = () => useQuery({ queryKey: ['profiles'], queryFn: () => api.get<ProfileDto[]>('/api/profiles') });

export const useConnections = () => useQuery({ queryKey: ['connections'], queryFn: () => api.get<ConnectionDto[]>('/api/connections') });

export const usePresets = () =>
  useQuery({ queryKey: ['presets'], queryFn: () => api.get<ProviderPresetDto[]>('/api/provider-presets'), staleTime: Infinity });

export const useToolSettings = () => useQuery({ queryKey: ['toolSettings'], queryFn: () => api.get<ToolSettingsDto>('/api/tools/settings') });

export const useWorkspaceSettings = (workspaceId: string | undefined) =>
  useQuery({
    queryKey: ['workspaceSettings', workspaceId],
    queryFn: () => api.get<WorkspaceSettingsDto>(`/api/workspaces/${workspaceId}/settings`),
    enabled: !!workspaceId,
  });

export const useBackups = () =>
  useQuery({
    queryKey: ['backups'],
    queryFn: () => api.get<{ settings: BackupSettingsDto; backups: BackupEntryDto[]; exportsDirectory: string }>('/api/backups'),
  });

export const useUsage = () => useQuery({ queryKey: ['usage'], queryFn: () => api.get<UsageSummaryDto>('/api/usage') });

export const useWeather = () =>
  useQuery({ queryKey: ['weather'], queryFn: () => api.get<WeatherDto>('/api/weather'), refetchInterval: 20 * 60_000, staleTime: 10 * 60_000, retry: false });

export const useWeatherSettings = () => useQuery({ queryKey: ['weatherSettings'], queryFn: () => api.get<WeatherSettings>('/api/weather/settings') });

export const useSystemInfo = () =>
  useQuery({
    queryKey: ['systemInfo'],
    queryFn: () => api.get<import('../../../shared/types.ts').AppInfoDto & { openViews: number; backupDirectory: string }>('/api/system/info'),
    refetchInterval: 15_000,
  });
