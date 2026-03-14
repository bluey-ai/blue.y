/**
 * /incidents — Technical incident history (admin/operator view).
 *
 * Shows deployment names, timestamps, durations, technical descriptions.
 * Full implementation in main.ts; this stub satisfies command registration.
 *

 */

import { CommandHandler } from '../../command-router';
import { ResponseFormatter, IncidentSummary } from '../../response-formatter';

const formatter = new ResponseFormatter();

export function createAdminIncidentsHandler(getIncidents: () => IncidentSummary[]): CommandHandler {
  return async (ctx) => {
    const incidents = getIncidents();
    const response = formatter.formatIncidents(incidents, ctx.role === 'user' ? 'user' : 'admin');
    await ctx.reply(response);
  };
}
