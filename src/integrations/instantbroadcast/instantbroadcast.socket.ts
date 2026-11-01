import { io, Socket } from 'socket.io-client';
import { logger } from '../../utils';
import { env } from '../../config';
import { emitToBusiness } from '../../socket';

export interface InstantBroadcastSocketConfig {
  uid: string;
  userToken: string;
  businessId: string;
  numberId: string;
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
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

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
        emitToBusiness(config.businessId, 'wa:conversation_update', {
          chatId,
          data,
          numberId: config.numberId,
        });
      } catch (err: any) {
        logger.error({ err: err.message, uid: config.uid }, 'Error processing update_conversation event');
      }
    });

    // 3. Conversations Ordering & Unread Sync (Server -> Client)
    socket.on('update_chat_list', (data: any) => {
      logger.debug({ uid: config.uid }, 'Instant Broadcast: update_chat_list received');
      emitToBusiness(config.businessId, 'wa:chat_list_update', {
        numberId: config.numberId,
        data,
      });
    });

    // 4. Inbound Message Chime Alert (Server -> Client)
    socket.on('ring', (data: any) => {
      logger.info({ uid: config.uid, data }, 'Instant Broadcast: incoming message chime (ring) received');
      emitToBusiness(config.businessId, 'wa:ring', {
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
        emitToBusiness(config.businessId, 'wa:chat_info_update', data);
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

