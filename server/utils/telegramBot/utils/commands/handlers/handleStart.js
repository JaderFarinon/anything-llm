const { Workspace } = require("../../../../../models/workspace");
const { canAccessTelegramWorkspace } = require("../../access");

/**
 * /start - Welcome message with current workspace info.
 * @param {import("../index").BotContext} ctx
 * @param {number} chatId
 */
async function handleStart(ctx, chatId) {
  const state = ctx.getState(chatId);
  const workspace = await Workspace.get({ slug: state.workspaceSlug });
  if (!(await canAccessTelegramWorkspace(ctx, chatId, workspace))) {
    await ctx.bot.sendMessage(chatId, "Use /switch para selecionar um workspace liberado para sua conta.");
    return;
  }
  const name = workspace?.name || state.workspaceSlug;

  await ctx.bot.sendMessage(
    chatId,
    `Welcome to AnyHealth!\n\nYour messages go to the "${name}" workspace. Use /switch to change workspaces or threads, and /help to see all commands.`
  );
}

module.exports = { handleStart };
