/**
 * /incidents — User-facing incident history.
 *
 * Shows plain-English outage history (friendly service names, no K8s details).
 * Admin/Operator view is handled separately with technical details.
 *

 */

import { CommandHandler } from '../../command-router';
import { ResponseFormatter, IncidentSummary } from '../../response-formatter';

const formatter = new ResponseFormatter();

export function createUserIncidentsHandler(): CommandHandler {
  return async (ctx) => {
    // TODO (BLY-2): Fetch real incident history from the incident store.
    // For now, return a placeholder until the incident store is wired up.
    const incidents: IncidentSummary[] = [];
    const response = formatter.formatIncidents(incidents, 'user');
    await ctx.reply(response);
  };
}
