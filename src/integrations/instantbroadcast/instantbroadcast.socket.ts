import { io, Socket } from 'socket.io-client';
import { logger } from '../../utils';
import { env } from '../../config';
import { emitToBranch, emitToOwners } from '../../socket';

export interface InstantBroadcastSocketConfig {
  uid: string;
  userToken: string;
  businessId: string;
  numberId: string;
}

/**
 * Relays a provider event about one chat to that chat's branch (plus owners).
 * Events we can't tie to a stored conversation go to owners only, never to every branch.
 */
async function emitForChat(config: InstantBroadcastSocketConfig, chatId: string | undefined, event: string, payload: any) {
  if (chatId) {
    const { WaConversation } = await import('../../models');
    const conv = await WaConversation.findOne({ businessId: config.businessId, providerChatId: chatId })
      .select('branchId')
      .setOptions({ skipTenantScope: true });
    if (conv) return emitToBranch(config.businessId, conv.branchId.toString(), event, payload);
  }
  emitToOwners(config.businessId, event, payload);
}

/**
 * IB's `update_chat_list` carries each changed chat with its newest message as a JSON string
 * (verified live 2026-11-03): `route` INCOMING = the customer wrote, OUTGOING = we sent it and
 * `status` is its tick. Incoming messages are stored (duplicates by wamid are skipped); outgoing
 * ones only move the tick of a message we sent.
 */
export async function ingestChatList(config: InstantBroadcastSocketConfig, data: any) {
  const { applyMessageStatus, processInboundWebhook } = await import('../../services/whatsapp.service');
  const chats: any[] = Array.isArray(data) ? data : Array.isArray(data?.chats) ? data.chats : [];
  for (const chat of chats) {
    let last: any = chat?.last_message;
    if (typeof last === 'string') {
      try {
        last = JSON.parse(last);
      } catch {
        continue;
      }
    }
    if (!last?.metaChatId || chat?.is_group) continue;

    if (last.route === 'INCOMING') {
      const mobile = String(chat.sender_mobile || last.senderMobile || '').replace(/\D/g, '');
      if (!mobile) continue;
      await processInboundWebhook(config.numberId, {
        from: `+${mobile}`,
        text: last.text?.body ?? last.msgContext?.text?.body ?? last.caption ?? undefined,
        providerMessageId: last.metaChatId,
        mediaUrl: last.mediaUrl || undefined,
        senderName: chat.sender_name || last.senderName || undefined,
        providerChatId: chat.chat_id,
        // Unix seconds; the list replays old chats, so this keeps their 24-hour window honest
        sentAt: Number(last.timestamp) > 0 ? new Date(Number(last.timestamp) * 1000) : undefined,
      });
    } else if (last.route === 'OUTGOING' && ['sent', 'delivered', 'read', 'failed'].includes(last.status)) {
      await applyMessageStatus(config.businessId, last.metaChatId, last.status);
    }
  }
}

class InstantBroadcastSocketManager {
  private sockets: Map<string, Socket> = new Map();
  private wsUrl: string;

  constructor() {
    this.wsUrl = env.INSTANT_BROADCAST_WS_URL || 'https://api.instantbroadcast.in';
  }

  /**
   * Connect or reconnect a socket connection for a specific WhatsApp account / UID.
   */
  public connectAccount(config: InstantBroadcastSocketConfig): Socket {
    const existing = this.sockets.get(config.uid);
    if (existing && existing.connected) {
      return existing;
    }

    if (existing) {
      existing.disconnect();
    }

    logger.info({ uid: config.uid, wsUrl: this.wsUrl }, 'Connecting to Instant Broadcast WebSocket engine');

    const socket = io(this.wsUrl, {
      auth: {
        uid: config.uid,
        userToken: config.userToken,
        token: config.userToken,
        agent: 'false',
      },
      query: {
        uid: config.uid,
        userToken: config.userToken,
        token: config.userToken,
        agent: 'false',
      },
      // IB refuses a direct WebSocket (HTTP 400); it accepts polling first, then upgrades
      transports: ['polling', 'websocket'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    // Live debugging: IB_LOG_RAW=true logs every provider event as received
    if (process.env.IB_LOG_RAW === 'true') {
      socket.onAny((event: string, ...args: any[]) => logger.info({ uid: config.uid, event, args }, 'Instant Broadcast raw event'));
    }

    // 1. Handshake Confirmation
    socket.on('connection_ack', (info: any) => {
      logger.info(
        { uid: config.uid, socketId: socket.id, serverId: info?.id, info },
        'Connected to Instant Broadcast WebSocket engine'
      );
    });

    // 2. Real-Time Chat Stream (Server -> Client)
    socket.on('update_conversation', async (data: any) => {
      logger.info({ uid: config.uid, chatId: data?.chatId }, 'Instant Broadcast: update_conversation received');
      try {
        const { processInboundWebhook } = await import('../../services/whatsapp.service');
        const chatId = data?.chatId;
        const conv = data?.conversation;
        const lastMsg = conv?.lastMessage || {};

        const fromPhone = lastMsg.sender || conv?.phone || data?.phone || '';
        const text = lastMsg.text || lastMsg.body || '';
        const providerMessageId = lastMsg.id || lastMsg.messageId || data?.messageId;
        const status = lastMsg.status || 'delivered';

        if (fromPhone) {
          await processInboundWebhook(config.numberId, {
            from: fromPhone,
            text,
            providerMessageId,
            status,
            mediaUrl: lastMsg.mediaUrl || lastMsg.media,
            senderName: lastMsg.senderName || conv?.name,
            providerChatId: chatId,
          });
        }

        // Notify local frontend management clients
        await emitForChat(config, chatId, 'wa:conversation_update', {
          chatId,
          data,
          numberId: config.numberId,
        });
      } catch (err: any) {
        logger.error({ err: err.message, uid: config.uid }, 'Error processing update_conversation event');
      }
    });

    // 3. Conversations Ordering & Unread Sync (Server -> Client)
    socket.on('update_chat_list', async (data: any) => {
      logger.debug({ uid: config.uid }, 'Instant Broadcast: update_chat_list received');
      try {
        await ingestChatList(config, data);
      } catch (err: any) {
        logger.error({ err: err.message, uid: config.uid }, 'Error processing update_chat_list event');
      }
      emitToOwners(config.businessId, 'wa:chat_list_update', {
        numberId: config.numberId,
        data,
      });
    });

    // 4. Inbound Message Chime Alert (Server -> Client)
    socket.on('ring', (data: any) => {
      logger.info({ uid: config.uid, chatId: data?.chatId }, 'Instant Broadcast: incoming message chime (ring) received');
      void emitForChat(config, data?.chatId, 'wa:ring', {
        numberId: config.numberId,
        data,
      });
    });

    // 5. Contact & Phonebook Sync (Server -> Client)
    socket.on('update_chat_info', async (data: any) => {
      logger.info({ uid: config.uid, chatId: data?.chatId }, 'Instant Broadcast: update_chat_info received');
      try {
        const { updateConversationContactMeta } = await import('../../services/whatsapp.service');
        if (data?.chatId) {
          await updateConversationContactMeta(config.businessId, data.chatId, {
            pushName: data.name || data.pushName,
            profilePicUrl: data.profilePic || data.profilePicUrl,
          });
        }
        await emitForChat(config, data?.chatId, 'wa:chat_info_update', data);
      } catch (err: any) {
        logger.warn({ err: err.message }, 'Failed to update contact info from update_chat_info');
      }
    });

    socket.on('connect_error', (error: any) => {
      logger.warn({ uid: config.uid, err: error.message }, 'Instant Broadcast socket connection error');
    });

    socket.on('disconnect', (reason: string) => {
      logger.warn({ uid: config.uid, reason }, 'Disconnected from Instant Broadcast socket');
    });

    this.sockets.set(config.uid, socket);
    return socket;
  }

  /**
   * Mark a chat as read via socket emit.
   */
  public markChatRead(uid: string, chatId: string): boolean {
    const socket = this.sockets.get(uid);
    if (!socket || !socket.connected) return false;
    socket.emit('mark_chat_read', { data: { chatId } });
    return true;
  }

  /**
   * Save an internal agent note on a chat via socket emit.
   */
  public saveChatNote(uid: string, chatId: string, note: string): boolean {
    const socket = this.sockets.get(uid);
    if (!socket || !socket.connected) return false;
    socket.emit('save_chat_note', { data: { chatId, note } });
    return true;
  }

  /**
   * Fetch active chats list via socket emit.
   */
  public getChats(uid: string, page = 1, limit = 50): boolean {
    const socket = this.sockets.get(uid);
    if (!socket || !socket.connected) return false;
    socket.emit('get_chats', { data: { limit, page } });
    return true;
  }

  /**
   * Disconnect all active sockets (used on server shutdown).
   */
  public disconnectAll(): void {
    for (const [uid, socket] of this.sockets.entries()) {
      try {
        socket.disconnect();
      } catch {}
    }
    this.sockets.clear();
  }
}

export const instantBroadcastSocket = new InstantBroadcastSocketManager();

