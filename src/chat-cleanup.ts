/**
 * Учёт сообщений для «чистки» чата.
 *
 * Бот запоминает всё, что он отправил, и сообщение пользователя, запустившее
 * текущий шаг. Перед следующим действием эти сообщения удаляются, чтобы в чате
 * оставался только актуальный экран.
 *
 * Telegram Bot API разрешает боту удалять свои сообщения и входящие сообщения
 * в личных чатах, но только не старше 48 часов. Поэтому вызывающая сторона
 * игнорирует неудачные попытки удаления — здесь это не обрабатывается.
 */
export interface MessageTracker {
  /** Запоминает сообщение, чтобы удалить его при следующем действии. */
  remember(chatId: number, messageId: number): void;
  /** Отдаёт запомненные сообщения и очищает список для этого чата. */
  take(chatId: number): number[];
}

export const createMessageTracker = (): MessageTracker => {
  const byChat = new Map<number, number[]>();

  return {
    remember(chatId, messageId) {
      const ids = byChat.get(chatId);
      if (ids === undefined) {
        byChat.set(chatId, [messageId]);
        return;
      }
      if (!ids.includes(messageId)) ids.push(messageId);
    },

    take(chatId) {
      const ids = byChat.get(chatId);
      if (ids === undefined) return [];
      byChat.delete(chatId);
      return ids;
    },
  };
};
