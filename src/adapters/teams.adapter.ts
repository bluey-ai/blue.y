/**
 * MS Teams Adapter — STUB
 * Full implementation: HUBS-6147
 *
 * Normalises a Bot Framework Activity into CallerIdentity.
 * User identity = Azure AD Object ID (aadObjectId).
 */

import { CallerIdentity, Platform } from '../rbac';

export interface TeamsActivityLike {
  from?: {
    aadObjectId?: string;
    name?: string;
    id?: string;
  };
  text?: string;
}

export function adaptTeamsMessage(activity: TeamsActivityLike): CallerIdentity {
  const id = activity.from?.aadObjectId ?? activity.from?.id ?? '';
  return {
    platform: 'teams' as Platform,
    id,
    displayName: activity.from?.name ?? id,
    rawMessage: activity.text ?? '',
  };
}
