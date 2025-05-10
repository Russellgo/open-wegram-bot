/**
 * Open Wegram Bot - Core Logic
 * Shared code between Cloudflare Worker and Vercel deployments
 */
import {
  banTopic,
  checkInit,
  doCheckInit,
  init,
  motherBotCommands,
  parseMetaDataMessage,
  processERReceived,
  processERSent,
  processPMReceived,
  processPMSent,
  reset,
  unbanTopic
} from './topicPmHandler.js'

export const allowed_updates = ['message', 'message_reaction', 'edited_message'];

export function validateSecretToken(token) {
  return token.length > 15 && /[A-Z]/.test(token) && /[a-z]/.test(token) && /[0-9]/.test(token);
}

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

export async function postToTelegramApi(token, method, body) {
  return fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

export async function handleInstall(request, ownerUid, botToken, prefix, secretToken) {
  if (!validateSecretToken(secretToken)) {
    return jsonResponse({
      success: false,
      message: 'Secret token must be at least 16 characters and contain uppercase letters, lowercase letters, and numbers.'
    }, 400);
  }

  const url = new URL(request.url);
  const baseUrl = `${url.protocol}//${url.hostname}`;
  const webhookUrl = `${baseUrl}/${prefix}/webhook/${ownerUid}/${botToken}`;

  try {
    const response = await postToTelegramApi(botToken, 'setWebhook', {
      url: webhookUrl,
      allowed_updates: allowed_updates,
      secret_token: secretToken
    });

    const result = await response.json();
    if (result.ok) {
      return jsonResponse({ success: true, message: 'Webhook successfully installed.' });
    }

    return jsonResponse({ success: false, message: `Failed to install webhook: ${result.description}` }, 400);
  } catch (error) {
    return jsonResponse({ success: false, message: `Error installing webhook: ${error.message}` }, 500);
  }
}

export async function handleUninstall(botToken, secretToken) {
  if (!validateSecretToken(secretToken)) {
    return jsonResponse({
      success: false,
      message: 'Secret token must be at least 16 characters and contain uppercase letters, lowercase letters, and numbers.'
    }, 400);
  }

  try {
    const response = await postToTelegramApi(botToken, 'deleteWebhook', {})

    const result = await response.json();
    if (result.ok) {
      return jsonResponse({ success: true, message: 'Webhook successfully uninstalled.' });
    }

    return jsonResponse({ success: false, message: `Failed to uninstall webhook: ${result.description}` }, 400);
  } catch (error) {
    return jsonResponse({ success: false, message: `Error uninstalling webhook: ${error.message}` }, 500);
  }
}

export async function handleWebhook(request, ownerUid, botToken, secretToken, childBotUrl, childBotSecretToken) {
  if (secretToken !== request.headers.get('X-Telegram-Bot-Api-Secret-Token')) {
    return new Response('Unauthorized', { status: 401 });
  }

  const update = await request.json();
  // --- for debugging ---
  // TODO: 2025/5/10
  await postToTelegramApi(botToken, 'sendMessage', {
    chat_id: ownerUid,
    text: `DEBUG MESSAGE! update: ${JSON.stringify(update)}`,
  });
  // --- for debugging ---

  if (update.edited_message) {
    return new Response('OK');
  }

  if (update.message_reaction) {
    try {
      // message_reaction EMOJI REACT(ER)
      const messageReaction = update.message_reaction
      const fromChat = messageReaction.chat;

      const check = await doCheckInit(botToken, ownerUid)
      if (!check.failed) {
        const metaDataMessage = check.checkMetaDataMessageResp.result.pinned_message;
        const {
          superGroupChatId,
          topicToFromChat,
          fromChatToTopic,
          bannedTopics
        } = parseMetaDataMessage(metaDataMessage);
        if (false) {
          // ignore message types
          return new Response('OK');
        } else if (messageReaction.user.id.toString() === ownerUid && fromChat.id === superGroupChatId
            && fromChat.is_forum) {
          // topic ER send to others.
          await processERSent(botToken, messageReaction, topicToFromChat);
        } else {
          // topic ER receive from others.
          if (!bannedTopics.includes(fromChatToTopic.get(fromChat.id))) {
            await processERReceived(botToken, ownerUid, messageReaction, superGroupChatId, bannedTopics);
          }
        }
        return new Response('OK');
      }
      return new Response('OK');
    } catch (error) {
      // --- for debugging ---
      await postToTelegramApi(botToken, 'sendMessage', {
        chat_id: ownerUid,
        text: `Error! You can send the message to developer for getting help : ${error.message} Stack: ${error.stack} origin: ${JSON.stringify(update)}`,
      });
      // --- for debugging ---
      return new Response('OK');
    }
  }

  if (!update.message) {
    return new Response('OK');
  }
  const message = update.message;
  const fromChat = message.chat;

  if (childBotUrl) {
    // --- delivery children bots ---
    return await motherBotCommands(botToken, ownerUid, message, childBotUrl, childBotSecretToken);
  }

  // --- commands ---
  try {
    if (message.from.id.toString() === ownerUid && fromChat.is_forum
        && message.text?.startsWith(".!") && message.text?.endsWith("!.")) {
      if (!message.is_topic_message) {
        // --- commands in General topic ---
        if (message.text === ".!pm_RUbot_checkInit!.") {
          return await checkInit(botToken, ownerUid, message);
        } else if (message.text === ".!pm_RUbot_doInit!.") {
          return await init(botToken, ownerUid, message);
        } else if (message.text === ".!pm_RUbot_doReset!.") {
          return await reset(botToken, ownerUid, message, false);
        }
      } else {
        // --- commands in PM topic ---
        const check = await doCheckInit(botToken, ownerUid)
        if (!check.failed) {
          const metaDataMessage = check.checkMetaDataMessageResp.result.pinned_message;
          const {
            superGroupChatId,
            topicToFromChat,
            fromChatToTopic,
            bannedTopics
          } = parseMetaDataMessage(metaDataMessage);
          if (fromChat.id !== superGroupChatId) {
            await postToTelegramApi(botToken, 'sendMessage', {
              chat_id: fromChat.id,
              text: `Only can work in your PM super group`,
            });
            return new Response('OK');
          }
          if (message.text === (".!pm_RUbot_ban!.")) {
            return await banTopic(botToken, ownerUid, message, topicToFromChat, metaDataMessage, false);
          } else if (message.text === (".!pm_RUbot_unban!.")) {
            return await unbanTopic(botToken, ownerUid, message, topicToFromChat, metaDataMessage, false);
          } else if (message.text === (".!pm_RUbot_silent_ban!.")) {
            return await banTopic(botToken, ownerUid, message, topicToFromChat, metaDataMessage, true);
          } else if (message.text === (".!pm_RUbot_silent_unban!.")) {
            return await unbanTopic(botToken, ownerUid, message, topicToFromChat, metaDataMessage, true);
          }
        }
      }
      return new Response('OK');
    } else if (message.from.id.toString() === ownerUid && fromChat.id.toString() === ownerUid
        && message.text?.startsWith(".!") && message.text?.endsWith("!.")) {
      // --- commands in Owner Chat ---
      if (message.text === ".!pm_RUbot_doReset!.") {
        return await reset(botToken, ownerUid, message, true);
      }
    }
  } catch (error) {
    // --- for debugging ---
    await postToTelegramApi(botToken, 'sendMessage', {
      chat_id: ownerUid,
      text: `Error! You can send the message to developer for getting help : ${error.message} Stack: ${error.stack} origin: ${JSON.stringify(update)}`,
    });
    // --- for debugging ---
    return new Response('OK');
  }
  // --- commands ---

  try {
    if ("/start" === message.text) {
      // TODO: 2025/5/6 Introduction words for various scenarios
      return new Response('OK');
    }

    const check = await doCheckInit(botToken, ownerUid)
    if (!check.failed) {
      const metaDataMessage = check.checkMetaDataMessageResp.result.pinned_message;
      const {
        superGroupChatId,
        topicToFromChat,
        fromChatToTopic,
        bannedTopics
      } = parseMetaDataMessage(metaDataMessage);
      if (message.forum_topic_created || message.pinned_message) {
        // ignore message types
        return new Response('OK');
      } else if (message.from.id.toString() === ownerUid && fromChat.id === superGroupChatId
          && fromChat.is_forum && message.is_topic_message) {
        // topic PM send to others
        await processPMSent(botToken, message, topicToFromChat);
      } else {
        // topic PM receive from others. Always receive first.
        await processPMReceived(botToken, ownerUid, message, superGroupChatId, fromChatToTopic, bannedTopics, metaDataMessage);
      }
      return new Response('OK');
    }

    const reply = message.reply_to_message;
    if (reply && fromChat.id.toString() === ownerUid) {
      const rm = reply.reply_markup;
      if (rm && rm.inline_keyboard && rm.inline_keyboard.length > 0) {
        let senderUid = rm.inline_keyboard[0][0].callback_data;
        if (!senderUid) {
          senderUid = rm.inline_keyboard[0][0].url.split('tg://user?id=')[1];
        }

        await postToTelegramApi(botToken, 'copyMessage', {
          chat_id: parseInt(senderUid),
          from_chat_id: fromChat.id,
          message_id: message.message_id
        });
      }

      return new Response('OK');
    }

    const sender = fromChat;
    const senderUid = sender.id.toString();
    const senderName = sender.username ? `@${sender.username}` : [sender.first_name, sender.last_name].filter(Boolean).join(' ');

    const copyMessage = async function (withUrl = false) {
      const ik = [[{
        text: `🔏 From: ${senderName} (${senderUid})`,
        callback_data: senderUid,
      }]];

      if (withUrl) {
        ik[0][0].text = `🔓 From: ${senderName} (${senderUid})`
        ik[0][0].url = `tg://user?id=${senderUid}`;
      }

      return await postToTelegramApi(botToken, 'copyMessage', {
        chat_id: parseInt(ownerUid),
        from_chat_id: fromChat.id,
        message_id: message.message_id,
        reply_markup: { inline_keyboard: ik }
      });
    }

    const response = await copyMessage(true);
    if (!response.ok) {
      await copyMessage();
    }

    return new Response('OK');
  } catch (error) {
    // --- for debugging ---
    await postToTelegramApi(botToken, 'sendMessage', {
      chat_id: ownerUid,
      text: `Error! You can send the message to developer for getting help : ${error.message} Stack: ${error.stack} origin: ${JSON.stringify(update)}`,
    });
    // --- for debugging ---
    return new Response('OK');
  }
}

export async function handleRequest(request, config) {
  const { prefix, secretToken, childBotUrl, childBotSecretToken } = config;

  const url = new URL(request.url);
  const path = url.pathname;

  const INSTALL_PATTERN = new RegExp(`^/${prefix}/install/([^/]+)/([^/]+)$`);
  const UNINSTALL_PATTERN = new RegExp(`^/${prefix}/uninstall/([^/]+)$`);
  const WEBHOOK_PATTERN = new RegExp(`^/${prefix}/webhook/([^/]+)/([^/]+)$`);

  let match;

  if (match = path.match(INSTALL_PATTERN)) {
    return handleInstall(request, match[1], match[2], prefix, secretToken);
  }

  if (match = path.match(UNINSTALL_PATTERN)) {
    return handleUninstall(match[1], secretToken);
  }

  if (match = path.match(WEBHOOK_PATTERN)) {
    return handleWebhook(request, match[1], match[2], secretToken, childBotUrl, childBotSecretToken);
  }

  return new Response('Not Found', { status: 404 });
}