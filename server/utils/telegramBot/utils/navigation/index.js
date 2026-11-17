const { isVerified } = require("../verification");
const { SystemSettings } = require("../../../../models/systemSettings");
const { resolveCallbackHandler } = require("./callbacks");

/**
 * Handle inline keyboard callback queries (workspace/thread selection, tool approval, etc).
 * @param {BotContext} ctx
 * @param {object} query - Telegram callback query object
 * @param {object} [options={}] - Optional dependencies that specific handlers may need
 */
async function handleKeyboardQueryCallback(ctx, query, options = {}) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;

  let callbackCtx = ctx;
  const multiUser = await SystemSettings.isMultiUserMode();
  if (multiUser) {
    const user = await ctx.getUser(chatId);
    if (!user || user.suspended) {
      await ctx.bot.answerCallbackQuery(query.id, { text: "Conta não vinculada." });
      return;
    }
    callbackCtx = { ...ctx, getUser: async () => user };
  } else if (!isVerified(ctx.config.approved_users, chatId)) {
    await ctx.bot.answerCallbackQuery(query.id, {
      text: "You are not approved.",
    });
    return;
  }

  try {
    const handler = resolveCallbackHandler(data);
    if (!handler) throw new Error(`Callback handler not found: ${data}`);
    await handler({ ctx: callbackCtx, chatId, query, messageId, data, ...options });
  } catch (error) {
    ctx.log("Callback error:", error.message);
    await ctx.bot.answerCallbackQuery(query.id, {
      text: "Something went wrong.",
    });
  }
}

module.exports = {
  handleKeyboardQueryCallback,
};
