import { Telegraf, Context } from 'telegraf';
import { message } from 'telegraf/filters';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import * as dotenv from 'dotenv';
import * as readline from 'readline';
import { JsonFileStorage, IStorage } from './storage'; // Припускаємо, що цей файл існує

// --- ПРОСУНУТИЙ ЛОГГЕР ---
const logger = {
  info: (message: string, ...args: any[]) => {
    console.log(`[${new Date().toISOString()}] [INFO]  `, message, ...args);
  },
  warn: (message: string, ...args: any[]) => {
    console.warn(`[${new Date().toISOString()}] [WARN]  `, message, ...args);
  },
  error: (message: string, error?: any, ...args: any[]) => {
    if (error) {
      console.error(`[${new Date().toISOString()}] [ERROR] `, message, error, ...args);
    } else {
      console.error(`[${new Date().toISOString()}] [ERROR] `, message, ...args);
    }
  },
};

// --- Допоміжна функція для запитань в консолі ---
function askQuestion(query: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(query, ans => { rl.close(); resolve(ans); }));
}

// --- КОНФІГУРАЦІЯ ---
dotenv.config();
const { API_ID, API_HASH, BOT_TOKEN, SOURCE_CHANNEL_USERNAME, SESSION_STRING } = process.env;
if (!API_ID || !API_HASH || !BOT_TOKEN || !SOURCE_CHANNEL_USERNAME) {
  throw new Error("Будь ласка, заповніть API_ID, API_HASH, BOT_TOKEN, SOURCE_CHANNEL_USERNAME в .env файлі!");
}
const apiId = parseInt(API_ID, 10);
const apiHash = API_HASH;
const stringSession = new StringSession(SESSION_STRING || '');

// --- Ініціалізація сховища ---
const storage: IStorage = new JsonFileStorage('bot_subscriptions.json');

// --- Управління станом розмови ---
const usersInAddMode = new Set<number>();

// --- ЧАСТИНА 1: БОТ ДЛЯ СПОВІЩЕНЬ (Telegraf) ---
const notifierBot = new Telegraf(BOT_TOKEN);

async function sendNotification(text: string, chatIds: number[], messageId: number) {
  if (chatIds.length === 0) return;
  logger.info(`Надсилаю сповіщення для ${chatIds.length} підписників...`);

  const notificationMessage = `🚨 **Увага! Повідомлення від водоканалу!** 🚨\n\n(Можливо, стосується вашої вулиці)\n\n---\n${text}`;
  const sourceLink = `https://t.me/${SOURCE_CHANNEL_USERNAME!.replace('@', '')}/${messageId}`;

  const sendPromises = chatIds.map(chatId =>
      notifierBot.telegram.sendMessage(chatId, notificationMessage, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '➡️ Перейти до джерела', url: sourceLink }]
          ]
        }
      })
          .catch(err => {
            logger.error(`Не вдалося надіслати повідомлення в чат ${chatId}:`, err);
            if (err.code === 403) {
              logger.warn(`Користувач ${chatId} заблокував бота. Видаляємо зі списку підписників.`);
              storage.removeSubscriber(chatId);
              storage.save();
            }
          })
  );
  await Promise.all(sendPromises);
  logger.info("Розсилку завершено.");
}

// --- Команди для управління підпискою ---

notifierBot.start(async (ctx: Context) => {
  if (ctx.chat) {
    await ctx.reply('Вітаю! 👋 Я допоможу вам відстежувати повідомлення від водоканалу.\n\nНадішліть мені назву першої вулиці, за якою ви хочете стежити.');
    usersInAddMode.add(ctx.chat.id);
  }
});

notifierBot.command('addstreet', async (ctx: Context) => {
  if (ctx.chat) {
    await ctx.reply('Надішліть мені назву вулиці, яку хочете додати до списку моніторингу.');
    usersInAddMode.add(ctx.chat.id);
  }
});

notifierBot.command('mystreets', async (ctx: Context) => {
  if (ctx.chat) {
    const streets = await storage.getStreetsFor(ctx.chat.id);
    if (streets.length > 0) {
      const streetList = streets.map(s => ` - \`${s}\``).join('\n');
      await ctx.replyWithMarkdown(`Ви відстежуєте наступні вулиці:\n${streetList}`);
    } else {
      await ctx.reply('Ви ще не додали жодної вулиці. Надішліть /addstreet, щоб почати.');
    }
  }
});

notifierBot.command('removestreet', async (ctx: Context) => {
  if (ctx.chat && ctx.message && 'text' in ctx.message) {
    const streetToRemove = ctx.message.text.split(' ').slice(1).join(' ').trim();

    if (!streetToRemove) {
      return ctx.reply('Будь ласка, вкажіть назву вулиці після команди, наприклад:\n`/removestreet Велика Перспективна`', { parse_mode: 'Markdown' });
    }

    const wasRemoved = await storage.removeStreet(ctx.chat.id, streetToRemove);
    await storage.save();

    if (wasRemoved) {
      await ctx.reply(`Вулицю "${streetToRemove}" видалено зі списку моніторингу.`);
    } else {
      await ctx.reply(`Вулиця "${streetToRemove}" не знайдена у вашому списку.`);
    }
  }
});

notifierBot.command('stop', async (ctx: Context) => {
  if (ctx.chat) {
    await storage.removeSubscriber(ctx.chat.id);
    await storage.save();
    await ctx.reply('Ви успішно відписалися. Всі ваші дані та список вулиць видалено. Щоб почати знову, надішліть /start.');
  }
});

notifierBot.on(message('text'), async (ctx) => {
  const chatId = ctx.chat.id;

  if (usersInAddMode.has(chatId)) {
    const streetName = ctx.message.text.trim();
    if (streetName) {
      await storage.addStreet(chatId, streetName);
      await storage.save();
      usersInAddMode.delete(chatId);
      await ctx.reply(`✅ Вулицю "${streetName}" додано! \n\nНадішліть /addstreet, щоб додати ще, або /mystreets, щоб переглянути весь список.`);
    }
  } else {
    ctx.reply("Не розумію вас. Щоб додати вулицю, використайте команду /addstreet.");
  }
});

// --- ЧАСТИНА 2: КЛІЄНТ ДЛЯ ПРОСЛУХОВУВАННЯ (Telegram/MTProto) ---
async function main() {
  await storage.load();

  logger.info("Запускаємо Telegram клієнт...");
  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => await askQuestion("Введіть ваш номер телефону: "),
    password: async () => await askQuestion("Введіть ваш пароль 2FA: "),
    phoneCode: async () => await askQuestion("Введіть код, отриманий в Telegram: "),
    onError: (err) => logger.error("Помилка під час авторизації клієнта:", err),
  });
  logger.info("✅ Клієнт успішно підключено!");

  const newSessionString = client.session.save();
  if (!SESSION_STRING && newSessionString) {
    logger.warn(`\nВАЖЛИВО! Збережіть цей рядок сесії у вашому .env файлі як SESSION_STRING:\n${newSessionString}\n`);
  }

  try {
    logger.info(`--- Тестовий запит до каналу ${SOURCE_CHANNEL_USERNAME} ---`);
    const [lastMessage] = await client.getMessages(SOURCE_CHANNEL_USERNAME, { limit: 1 });
    if (lastMessage && lastMessage.text) {
      logger.info("✅ Успішно отримано останнє повідомлення:");
      logger.info(`"${lastMessage.text.substring(0, 200)}..."`);
    } else if (lastMessage) {
      logger.info("✅ Успішно отримано останнє повідомлення (без тексту, можливо медіа).");
    } else {
      logger.warn("⚠️ Не вдалося отримати останнє повідомлення. Можливо, канал порожній або сталася помилка.");
    }
  } catch (error: any) {
    logger.error("❌ Помилка під час отримання тестового повідомлення. Перевірте, чи правильний SOURCE_CHANNEL_USERNAME в .env і чи має акаунт доступ до цього каналу.", error);
  }
  logger.info("--------------------------------------------------\n");

  client.addEventHandler(async (event) => {
    const messageText = event.message?.message;
    const messageId = event.message?.id;

    if (!messageText || !messageId) return;

    const lowerCaseMessage = messageText.toLowerCase();

    logger.info(`Отримано повідомлення #${messageId} з каналу...`);

    const allSubscriptions = await storage.getAllSubscriptions();
    const usersToNotify = new Set<number>();

    for (const [chatId, streets] of allSubscriptions.entries()) {
      for (const street of streets) {
        if (lowerCaseMessage.includes(street.toLowerCase())) {
          usersToNotify.add(chatId);
          break;
        }
      }
    }

    if (usersToNotify.size > 0) {
      logger.info(`Знайдено збіги для ${usersToNotify.size} користувачів.`);
      const chatIdsToNotify = Array.from(usersToNotify);
      await sendNotification(messageText, chatIdsToNotify, messageId);
    } else {
      logger.info("Збігів для підписників не знайдено.");
    }
  });

  await notifierBot.launch(() => logger.info("✅ Бот для сповіщень запущено."));
  logger.info(`🎧 Прослуховування каналу ${SOURCE_CHANNEL_USERNAME!.replace('@','')} розпочато...`);
}

// --- Обробка коректного завершення роботи ---
async function gracefulShutdown(signal: string) {
  logger.info(`Отримано сигнал ${signal}. Завершення роботи...`);
  await storage.save();
  notifierBot.stop(signal);
  process.exit(0);
}
process.once('SIGINT', () => gracefulShutdown('SIGINT'));
process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));

main().catch(err => {
  logger.error("Сталася критична помилка в головній функції:", err);
  process.exit(1);
});