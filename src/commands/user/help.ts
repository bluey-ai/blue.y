/**
 * /help — User-facing help (registered for 'user' role).
 *
 * Admin/Operator help is handled via ResponseFormatter.formatHelp()
 * and called from main.ts. This handler covers the multi-platform
 * user-facing case where ResponseFormatter is used correctly by role.
 *

 */

import { CommandHandler } from '../../command-router';
import { ResponseFormatter } from '../../response-formatter';

const formatter = new ResponseFormatter();

export function createUserHelpHandler(): CommandHandler {
  return async (ctx) => {
    const response = formatter.formatHelp('user', ctx.caller.platform);
    await ctx.reply(response);
  };
}
