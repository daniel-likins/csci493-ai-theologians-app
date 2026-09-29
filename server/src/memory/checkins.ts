import { CHECKIN_INTERVAL_DAYS } from '../../../shared/constants.ts';
import type { CheckinStatusDto, WorkspaceSettingsDto } from '../../../shared/types.ts';

/**
 * Gentle, optional, in-app check-ins. No OS notifications, no streaks, no model calls on a timer:
 * a due check-in only shows a quiet prompt in the Goals panel. The user decides whether to start one.
 */
export function checkinStatus(settings: WorkspaceSettingsDto, now = new Date()): CheckinStatusDto {
  const base = { frequency: settings.checkinFrequency, lastCheckinAt: settings.lastCheckinAt };
  if (settings.checkinFrequency === 'off') return { ...base, due: false };
  if (settings.checkinSnoozedUntil && new Date(settings.checkinSnoozedUntil) > now) return { ...base, due: false };
  const intervalMs = CHECKIN_INTERVAL_DAYS[settings.checkinFrequency] * 86_400_000;
  const due = !settings.lastCheckinAt || now.getTime() - new Date(settings.lastCheckinAt).getTime() >= intervalMs;
  return { ...base, due };
}

export function checkinPrompt(missionName: string): string {
  return `Check-in: I'd like to take a few minutes to reflect on ${missionName}. Based on what's saved, ask me a couple of thoughtful questions about how it's going, what matters most right now, and whether my focus still fits my long-term goals.`;
}

export const SNOOZE_DAYS = 3;
