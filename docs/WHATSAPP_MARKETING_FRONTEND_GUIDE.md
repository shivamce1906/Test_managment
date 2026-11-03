# WhatsApp Inbox & Marketing — Frontend Implementation Guide

Step-by-step code for `~/Desktop/Glox-Salon-Management-Frontend`. It follows that repo's existing patterns:
- `api` from `@/lib/api/client`;
- TanStack Query hooks with key factories;
- `useCan` and `MATRIX` for permissions;
- `APP_ROUTES` plus a `SCREENS` map for routing;
- atoms and molecules from `@/components`;
- `notify` for toasts.

Backend contract (endpoints, JSON, errors): [WHATSAPP_MARKETING_API_GUIDE.md](WHATSAPP_MARKETING_API_GUIDE.md). Section numbers like "API §4.4" point there.

> Prop names for your own atoms (`Button`, `Badge`, `SearchInput`, `FormSheet` …) are written as they appear in the repo today. If one differs, adjust the prop and keep the logic.

## Build order

| # | Step | Files | Result |
| --- | --- | --- | --- |
| 1 | Socket client | `src/lib/socket.ts`, `src/hooks/use-socket.ts` | Live connection after login |
| 2 | WhatsApp API | `src/lib/api/whatsapp.ts` | Typed hooks for the inbox |
| 3 | Realtime bridge | `src/hooks/use-whatsapp-realtime.ts`, mounted in `AppLayout` | Socket events update the cache and play the chime |
| 4 | Permissions, nav, router | `permissions.ts`, `navigation.ts`, `app-router.tsx`, `route-elements.tsx`, `use-nav-counts.ts` | Menu items and an unread badge |
| 5 | Inbox screen | `src/pages/whatsapp/*` | 3-pane live chat |
| 6 | Marketing API | `src/lib/api/marketing.ts` | Offers, segments and campaigns hooks |
| 7 | Promo code on New bill | `bill-draft.ts`, `new-bill-page.tsx` | Offer applied by the server |
| 8 | Offers screen | `src/pages/marketing/offers-page.tsx` | Create and edit codes |
| 9 | Segments screen | `src/pages/marketing/segments-page.tsx` | Builder with live count |
| 10 | Campaigns screen | `src/pages/marketing/campaigns-page.tsx`, `campaign-wizard.tsx` | Wizard, schedule and analytics |
| 11 | Test | — | The checklist at the end |

---

## Step 1 — Socket client

```bash
npm install socket.io-client@4
```

**`src/lib/socket.ts`**

```ts
import { io, type Socket } from 'socket.io-client';
import { getAccessToken, refreshAccessToken } from '@/lib/api/client';

/*
 * One Socket.IO connection per signed-in tab (WhatsApp API guide §3). The server checks the token
 * like HTTP and joins the rooms itself: owners hear every branch, others only their own.
 */
let socket: Socket | null = null;

function connectSocket(): Socket {
  if (socket) return socket;
  socket = io(import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000', {
    path: '/socket.io',
    transports: ['websocket', 'polling'],
    // Read on every (re)connect so a refreshed token is used
    auth: (cb) => cb({ token: getAccessToken() }),
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10_000,
  });

  // Expired or revoked token: refresh once, then retry. A failed refresh ends the session via the API client.
  socket.on('connect_error', async () => {
    try {
      await refreshAccessToken();
      socket?.connect();
    } catch {
      disconnectSocket();
    }
  });
  return socket;
}

function getSocket() {
  return socket;
}

function disconnectSocket() {
  socket?.removeAllListeners();
  socket?.disconnect();
  socket = null;
}

export { connectSocket, disconnectSocket, getSocket };
```

**`src/hooks/use-socket.ts`**

```ts
import { useEffect, useRef } from 'react';
import { connectSocket, disconnectSocket, getSocket } from '@/lib/socket';
import { useSession } from '@/stores/auth-store';

/** Opens the socket while a salon user is signed in; closes it on sign-out. */
function useSocketConnection() {
  const session = useSession();
  const tenant = session && session.role !== 'superadmin';
  useEffect(() => {
    if (!tenant) return;
    connectSocket();
    return () => disconnectSocket();
  }, [tenant, session?.user.id]);
}

/** Subscribes to one event for the component's lifetime; the latest handler is always used. */
function useSocketEvent<T>(event: string, handler: (payload: T) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const listener = (payload: T) => ref.current(payload);
    socket.on(event, listener);
    return () => {
      socket.off(event, listener);
    };
  }, [event, getSocket()]);
}

export { useSocketConnection, useSocketEvent };
```

---

## Step 2 — WhatsApp API (`src/lib/api/whatsapp.ts`)

```ts
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api/client';

/*
 * Shared WhatsApp inbox (WhatsApp API guide §4). Managers and branch logins only ever get their own
 * branches' chats; another branch's id answers 404.
 */

type MessageStatus = 'sent' | 'delivered' | 'read' | 'failed';

type WaMessage = {
  _id: string;
  conversationId: string;
  direction: 'in' | 'out';
  kind: 'text' | 'template' | 'media';
  text?: string;
  templateId?: string;
  variables?: string[];
  mediaUrl?: string;
  senderName?: string;
  status: MessageStatus;
  providerMessageId?: string;
  origin?: 'inbox' | 'campaign' | 'automation';
  sentBy?: string;
  createdAt: string;
  /** Client-only: optimistic bubble waiting for the server. */
  pending?: boolean;
};

type ChatNote = { _id: string; note: string; authorId?: string; createdAt: string };

type Conversation = {
  _id: string;
  numberId: string;
  branchId: string;
  phone: string;
  customerId?: {
    _id: string;
    name: string;
    phone: string;
    stats?: { visits: number; spendPaise: number; noShows: number };
    tags?: string[];
    walletBalancePaise?: number;
    loyaltyPoints?: number;
    duePaise?: number;
  } | null;
  leadId?: { _id: string; name?: string; phone: string; stage?: string } | null;
  contactMeta?: { pushName?: string; profilePicUrl?: string };
  unread: number;
  lastMessageAt: string;
  lastInboundAt?: string;
  notes: ChatNote[];
  /** Client-only preview of the newest message, filled by the realtime bridge. */
  lastText?: string;
};

type WaTemplate = {
  _id: string;
  numberId: string;
  name: string;
  category: string;
  language?: string;
  body: string;
  variables: string[];
  status: 'approved' | 'pending' | 'rejected';
};

type ConversationFilter = { branchId?: string; unreadOnly?: boolean; search?: string };

const PAGE = 50;
const WINDOW_MS = 24 * 3600 * 1000;

const waKeys = {
  all: ['whatsapp'] as const,
  conversations: (f: ConversationFilter) => ['whatsapp', 'conversations', f] as const,
  conversation: (id: string) => ['whatsapp', 'conversation', id] as const,
  messages: (id: string) => ['whatsapp', 'messages', id] as const,
  templates: ['whatsapp', 'templates'] as const,
};

/** Name to show: customer → lead → WhatsApp name → phone. */
function displayName(c: Pick<Conversation, 'customerId' | 'leadId' | 'contactMeta' | 'phone'>) {
  return c.customerId?.name || c.leadId?.name || c.contactMeta?.pushName || c.phone;
}

/** Milliseconds left in the 24-hour free-text window (≤ 0 = closed, use a template). */
function windowLeftMs(c: Pick<Conversation, 'lastInboundAt'>, now = Date.now()) {
  return c.lastInboundAt ? WINDOW_MS - (now - Date.parse(c.lastInboundAt)) : -1;
}

function useConversations(filter: ConversationFilter) {
  return useQuery({
    queryKey: waKeys.conversations(filter),
    queryFn: async () =>
      (
        await api.get<Conversation[]>('/whatsapp/conversations', {
          params: {
            branchId: filter.branchId || undefined,
            unreadOnly: filter.unreadOnly ? 'true' : undefined,
            search: filter.search || undefined,
          },
        })
      ).data,
    // Sockets keep it live; this is the safety net after a missed event
    refetchInterval: 60_000,
  });
}

function useConversation(id: string | null) {
  return useQuery({
    queryKey: waKeys.conversation(id ?? ''),
    enabled: Boolean(id),
    queryFn: async () => (await api.get<Conversation>(`/whatsapp/conversations/${id}`)).data,
  });
}

/** Pages of messages, newest page first; flatten with `allMessages()` for display (oldest → newest). */
function useMessages(id: string | null) {
  return useInfiniteQuery({
    queryKey: waKeys.messages(id ?? ''),
    enabled: Boolean(id),
    initialPageParam: 0,
    queryFn: async ({ pageParam }) =>
      (await api.get<WaMessage[]>('/whatsapp/messages', { params: { conversationId: id, limit: PAGE, skip: pageParam } }))
        .data,
    getNextPageParam: (last, pages) => (last.length < PAGE ? undefined : pages.length * PAGE),
  });
}

function allMessages(pages: WaMessage[][] | undefined) {
  return [...(pages ?? [])].reverse().flat();
}

function useTemplates() {
  return useQuery({
    queryKey: waKeys.templates,
    queryFn: async () => (await api.get<WaTemplate[]>('/whatsapp/templates')).data,
    select: (rows) => rows.filter((t) => t.status === 'approved'),
    staleTime: 5 * 60_000,
  });
}

type SendBody = { conversationId: string; text?: string; templateId?: string; variables?: string[] };

function useSendMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: SendBody) => (await api.post<WaMessage>('/whatsapp/messages', body)).data,
    onSuccess: (message) => {
      upsertMessage(queryClient, message);
      void queryClient.invalidateQueries({ queryKey: ['whatsapp', 'conversations'] });
    },
  });
}

function useMarkRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await api.post<Conversation>(`/whatsapp/conversations/${id}/read`)).data,
    onSuccess: (conv) => setUnread(queryClient, conv._id, 0),
  });
}

function useAddNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, note }: { id: string; note: string }) =>
      (await api.post<Conversation>(`/whatsapp/conversations/${id}/notes`, { note })).data,
    onSuccess: (conv) => queryClient.setQueryData(waKeys.conversation(conv._id), (old?: Conversation) => ({ ...old, ...conv } as Conversation)),
  });
}

// ---- cache helpers used by the mutations and the realtime bridge ----

type QC = ReturnType<typeof useQueryClient>;

/** Adds or replaces a message in the open chat's newest page (skips duplicates by _id). */
function upsertMessage(queryClient: QC, message: WaMessage) {
  queryClient.setQueryData(waKeys.messages(message.conversationId), (old: { pages: WaMessage[][]; pageParams: unknown[] } | undefined) => {
    if (!old) return old;
    const exists = old.pages.some((p) => p.some((m) => m._id === message._id));
    if (exists) {
      return { ...old, pages: old.pages.map((p) => p.map((m) => (m._id === message._id ? message : m))) };
    }
    const [newest, ...rest] = old.pages;
    return { ...old, pages: [[...(newest ?? []).filter((m) => !m.pending), message], ...rest] };
  });
}

function setMessageStatus(queryClient: QC, conversationId: string, messageId: string, status: MessageStatus) {
  queryClient.setQueryData(waKeys.messages(conversationId), (old: { pages: WaMessage[][]; pageParams: unknown[] } | undefined) =>
    old && { ...old, pages: old.pages.map((p) => p.map((m) => (m._id === messageId ? { ...m, status } : m))) },
  );
}

/** Updates every cached conversation list (all filters) for one chat. */
function patchConversation(queryClient: QC, id: string, patch: (c: Conversation) => Conversation) {
  queryClient.setQueriesData<Conversation[]>({ queryKey: ['whatsapp', 'conversations'] }, (rows) =>
    rows
      ?.map((c) => (c._id === id ? patch(c) : c))
      .sort((a, b) => Date.parse(b.lastMessageAt) - Date.parse(a.lastMessageAt)),
  );
}

function setUnread(queryClient: QC, id: string, unread: number) {
  patchConversation(queryClient, id, (c) => ({ ...c, unread }));
}

export {
  allMessages,
  displayName,
  patchConversation,
  setMessageStatus,
  setUnread,
  upsertMessage,
  useAddNote,
  useConversation,
  useConversations,
  useMarkRead,
  useMessages,
  useSendMessage,
  useTemplates,
  waKeys,
  windowLeftMs,
};
export type { ChatNote, Conversation, ConversationFilter, MessageStatus, WaMessage, WaTemplate };
```

---

## Step 3 — Realtime bridge (`src/hooks/use-whatsapp-realtime.ts`)

This is mounted once for the whole app, so the badge, chime and toasts work on every screen.

```ts
import { useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useMatch, useNavigate } from 'react-router';
import { useSocketConnection, useSocketEvent } from '@/hooks/use-socket';
import { patchConversation, setMessageStatus, setUnread, upsertMessage, waKeys, type ChatNote, type MessageStatus, type WaMessage } from '@/lib/api/whatsapp';
import { notify } from '@/lib/notify';

const MUTE_KEY = 'glox.wa.muted';
let chime: HTMLAudioElement | null = null;

function isMuted() {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

function setMuted(muted: boolean) {
  try {
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  } catch {
    /* private mode: stays unmuted */
  }
}

function playChime() {
  if (isMuted()) return;
  chime ??= new Audio('/sounds/message-chime.mp3');
  chime.currentTime = 0;
  // Browsers block audio before the first click; ignore that
  void chime.play().catch(() => undefined);
}

/** Keeps the WhatsApp cache live from socket events (WhatsApp API guide §3.2). */
function useWhatsappRealtime() {
  useSocketConnection();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const inbox = useMatch('/whatsapp');
  const refetchTimer = useRef<number>();

  const refetchListSoon = () => {
    window.clearTimeout(refetchTimer.current);
    refetchTimer.current = window.setTimeout(
      () => void queryClient.invalidateQueries({ queryKey: ['whatsapp', 'conversations'] }),
      800,
    );
  };

  useSocketEvent<{ conversationId: string; message: WaMessage }>('wa:new_message', ({ conversationId, message }) => {
    upsertMessage(queryClient, message);
    const openId = new URLSearchParams(window.location.search).get('chat');
    const isOpen = Boolean(inbox) && openId === String(conversationId);
    let known = false;
    patchConversation(queryClient, String(conversationId), (c) => {
      known = true;
      return {
        ...c,
        lastMessageAt: message.createdAt,
        lastText: message.text ?? `[${message.kind}]`,
        ...(message.direction === 'in'
          ? { lastInboundAt: message.createdAt, unread: isOpen ? c.unread : c.unread + 1 }
          : {}),
      };
    });
    if (!known) refetchListSoon(); // a brand-new chat
    if (message.direction === 'in') {
      playChime();
      if (!inbox) {
        notify.info(message.senderName || 'New WhatsApp message', {
          description: message.text?.slice(0, 80),
          action: { label: 'Open', onClick: () => navigate(`/whatsapp?chat=${conversationId}`) },
        });
      }
    }
  });

  useSocketEvent<{ conversationId: string; messageId: string; status: MessageStatus }>('wa:message_status', (p) =>
    setMessageStatus(queryClient, String(p.conversationId), String(p.messageId), p.status),
  );

  useSocketEvent<{ conversationId: string }>('wa:chat_read', ({ conversationId }) => setUnread(queryClient, String(conversationId), 0));

  useSocketEvent<{ conversationId: string; note: ChatNote }>('wa:chat_note_saved', ({ conversationId, note }) =>
    queryClient.setQueryData(waKeys.conversation(String(conversationId)), (old: any) =>
      old && !old.notes?.some((n: ChatNote) => n._id === note._id) ? { ...old, notes: [...(old.notes ?? []), note] } : old,
    ),
  );

  // Raw provider events: never render them, just refresh (debounced). wa:ring is ignored on purpose (no double chime).
  useSocketEvent('wa:conversation_update', refetchListSoon);
  useSocketEvent('wa:chat_list_update', refetchListSoon);
  useSocketEvent('wa:chat_info_update', () => {
    refetchListSoon();
    void queryClient.invalidateQueries({ queryKey: ['whatsapp', 'conversation'] });
  });
}

export { isMuted, setMuted, useWhatsappRealtime };
```

**Mount it** in `src/routes/route-elements.tsx`:

```tsx
import { useWhatsappRealtime } from '@/hooks/use-whatsapp-realtime';

function RealtimeBridge() {
  useWhatsappRealtime();
  return null;
}

function AppLayout() {
  return (
    <RequireAuth>
      <AppShellTemplate>
        <RealtimeBridge />
        <Outlet />
      </AppShellTemplate>
    </RequireAuth>
  );
}
```

**Also:**
- Put a short chime file at `public/sounds/message-chime.mp3`.
- **On reconnect:** in `connectSocket()`, add `socket.on('connect', () => queryClient.invalidateQueries({ queryKey: ['whatsapp'] }))`, or do it in the bridge with `useSocketEvent('connect', …)`. That catches up on events missed while offline.

---

## Step 4 — Permissions, nav, router, unread badge

**`src/lib/permissions.ts`:** add these to `Action` and `MATRIX`:

```ts
| 'whatsapp.templatesSync'
| 'marketing.view'
| 'marketing.manage'
```

```ts
'whatsapp.inbox': { owner: true, manager: true, branch: true }, // already there
'whatsapp.templatesSync': { owner: true },
'marketing.view': { owner: true, manager: true },
'marketing.manage': { owner: true, manager: (f) => Boolean(f.manageMarketing) },
```

Replace the existing `'whatsapp.campaigns'` uses with `'marketing.manage'`, and add `manageMarketing?: boolean` to `PermissionFlags` if the manager phase didn't already add it.

**`src/lib/navigation.ts`:**
- `countKey` gets a new member: `'approvals' | 'branchRequests' | 'whatsappUnread'`.
- The `/whatsapp` entry gets `countKey: 'whatsappUnread'`.
- Replace the two marketing entries:

```ts
{ path: '/whatsapp', title: 'WhatsApp', icon: MessageCircleIcon, group: 'frontDesk', roles: OMB, countKey: 'whatsappUnread' },

{ path: '/marketing/campaigns', title: 'Campaigns', icon: MegaphoneIcon, group: 'marketing', roles: OM },
{ path: '/marketing/offers', title: 'Offers', icon: TicketPercentIcon, group: 'marketing', roles: OM },
{ path: '/marketing/segments', title: 'Segments', icon: UsersRoundIcon, group: 'marketing', roles: OM },
```

Keep `/whatsapp/automations` if you already show it; it isn't covered by this guide.

**`src/hooks/use-nav-counts.ts`:**

```ts
import { useConversations } from '@/lib/api/whatsapp';

function useNavCounts() {
  const { branchId } = useActiveBranch();
  const { data: approvals } = useApprovalsCount(branchId);
  const { data: stats } = usePlatformStats();
  const { data: chats } = useConversations({ unreadOnly: true });
  return {
    approvals: approvals ?? 0,
    branchRequests: stats?.pendingBranchRequests ?? 0,
    whatsappUnread: (chats ?? []).reduce((sum, c) => sum + c.unread, 0),
  };
}
```

The realtime bridge keeps that list current, so the badge updates live.

> `usePlatformStats` must stay disabled for salon roles, as it is today. Likewise, don't call `useConversations` for Super Admin: wrap it with `enabled: session?.role !== 'superadmin'` (add an `enabled` option to the hook).

**`src/routes/route-elements.tsx`** (lazy pages) and **`src/routes/app-router.tsx`** (`SCREENS`):

```ts
const WhatsappInboxPage = lazy(() => import('@/pages/whatsapp/inbox-page'));
const CampaignsPage = lazy(() => import('@/pages/marketing/campaigns-page'));
const OffersPage = lazy(() => import('@/pages/marketing/offers-page'));
const SegmentsPage = lazy(() => import('@/pages/marketing/segments-page'));
```

```ts
'/whatsapp': WhatsappInboxPage,
'/marketing/campaigns': CampaignsPage,
'/marketing/offers': OffersPage,
'/marketing/segments': SegmentsPage,
```

---

## Step 5 — Inbox screen (`src/pages/whatsapp/`)

```
inbox-page.tsx           ← layout, selected chat in ?chat=, filters
conversation-list.tsx    ← left pane
chat-panel.tsx           ← centre pane: messages, 24 h banner, composer, templates
contact-panel.tsx        ← right pane: customer card, notes, quick actions
```

**`inbox-page.tsx`**

```tsx
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { PageHeader } from '@/components/organisms/page-header';
import { useActiveBranch } from '@/hooks/use-active-branch';
import { useConversations } from '@/lib/api/whatsapp';
import { cn } from '@/lib/utils';
import { ChatPanel } from '@/pages/whatsapp/chat-panel';
import { ContactPanel } from '@/pages/whatsapp/contact-panel';
import { ConversationList } from '@/pages/whatsapp/conversation-list';

/** S-1201 Shared WhatsApp inbox: list · chat · customer (stacked on phones). */
function InboxPage() {
  const { branchId, isAll } = useActiveBranch();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const chatId = params.get('chat');

  const conversations = useConversations({ branchId: isAll ? undefined : (branchId ?? undefined), unreadOnly, search });
  const open = (id: string | null) =>
    setParams((p) => {
      if (id) p.set('chat', id);
      else p.delete('chat');
      return p;
    });

  return (
    <div className="flex h-[calc(100dvh-8rem)] flex-col gap-3">
      <PageHeader title="WhatsApp" description="Customer chats for your branches, live." />
      <div className="border-border bg-card grid min-h-0 flex-1 overflow-hidden rounded-xl border md:grid-cols-[320px_1fr] xl:grid-cols-[320px_1fr_300px]">
        <div className={cn('min-h-0 border-r', chatId && 'hidden md:block')}>
          <ConversationList
            query={conversations}
            selectedId={chatId}
            onSelect={open}
            search={search}
            onSearch={setSearch}
            unreadOnly={unreadOnly}
            onUnreadOnly={setUnreadOnly}
          />
        </div>
        <div className={cn('min-h-0', !chatId && 'hidden md:block')}>
          {chatId ? <ChatPanel key={chatId} conversationId={chatId} onBack={() => open(null)} /> : <NoChat />}
        </div>
        <div className="hidden min-h-0 border-l xl:block">{chatId ? <ContactPanel conversationId={chatId} /> : null}</div>
      </div>
    </div>
  );
}

function NoChat() {
  return <div className="text-muted-foreground grid h-full place-items-center text-sm">Pick a chat to start replying</div>;
}

export default InboxPage;
```

**`conversation-list.tsx`**

```tsx
import { formatDistanceToNowStrict } from 'date-fns';
import { Badge } from '@/components/atoms/badge';
import { Skeleton } from '@/components/atoms/skeleton';
import { SwitchField } from '@/components/atoms/switch';
import { EmptyState } from '@/components/molecules/empty-state';
import { QueryError } from '@/components/molecules/query-error';
import { SearchInput } from '@/components/molecules/search-input';
import { displayName, type Conversation } from '@/lib/api/whatsapp';
import { cn } from '@/lib/utils';
import type { UseQueryResult } from '@tanstack/react-query';

type Props = {
  query: UseQueryResult<Conversation[]>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  search: string;
  onSearch: (v: string) => void;
  unreadOnly: boolean;
  onUnreadOnly: (v: boolean) => void;
};

function ConversationList({ query, selectedId, onSelect, search, onSearch, unreadOnly, onUnreadOnly }: Props) {
  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b p-3">
        <SearchInput value={search} onChange={(e) => onSearch(e.target.value)} onClear={() => onSearch('')} placeholder="Name or phone" />
        <SwitchField label="Unread only" checked={unreadOnly} onCheckedChange={onUnreadOnly} />
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {query.isPending ? (
          Array.from({ length: 6 }, (_, i) => <li key={i} className="p-3"><Skeleton className="h-12" /></li>)
        ) : query.error ? (
          <li className="p-3"><QueryError error={query.error} onRetry={() => void query.refetch()} /></li>
        ) : query.data.length === 0 ? (
          <li><EmptyState title={search || unreadOnly ? 'No matching chats' : 'No chats yet'} description="New WhatsApp messages appear here instantly." /></li>
        ) : (
          query.data.map((c) => (
            <li key={c._id}>
              <button
                type="button"
                onClick={() => onSelect(c._id)}
                className={cn('hover:bg-muted flex w-full items-start gap-3 px-3 py-2.5 text-left', selectedId === c._id && 'bg-primary-light')}
              >
                <Avatar conversation={c} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className={cn('truncate text-sm', c.unread > 0 && 'font-semibold')}>{displayName(c)}</span>
                    <span className="text-muted-foreground shrink-0 text-xs">
                      {formatDistanceToNowStrict(new Date(c.lastMessageAt), { addSuffix: false })}
                    </span>
                  </span>
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground truncate text-xs">
                      {c.leadId && !c.customerId ? 'Lead · ' : ''}{c.lastText ?? c.phone}
                    </span>
                    {c.unread > 0 ? <Badge tone="success" shape="pill">{c.unread}</Badge> : null}
                  </span>
                </span>
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

function Avatar({ conversation }: { conversation: Conversation }) {
  const url = conversation.contactMeta?.profilePicUrl;
  const initial = displayName(conversation).slice(0, 1).toUpperCase();
  return url ? (
    <img src={url} alt="" className="size-9 shrink-0 rounded-full object-cover" />
  ) : (
    <span className="bg-primary-light text-primary grid size-9 shrink-0 place-items-center rounded-full text-sm font-medium">{initial}</span>
  );
}

export { ConversationList };
```

**`chat-panel.tsx`**

```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import { format } from 'date-fns';
import { ArrowLeftIcon, CheckCheckIcon, CheckIcon, ClockIcon, TriangleAlertIcon } from 'lucide-react';
import { Button } from '@/components/atoms/button';
import { Skeleton } from '@/components/atoms/skeleton';
import { Textarea } from '@/components/atoms/textarea';
import { QueryError } from '@/components/molecules/query-error';
import { toApiError } from '@/lib/api/errors';
import {
  allMessages, displayName, upsertMessage, useConversation, useMarkRead, useMessages, useSendMessage, windowLeftMs,
  type WaMessage,
} from '@/lib/api/whatsapp';
import { notify } from '@/lib/notify';
import { cn } from '@/lib/utils';
import { TemplatePicker } from '@/pages/whatsapp/template-picker';
import { useQueryClient } from '@tanstack/react-query';

function ChatPanel({ conversationId, onBack }: { conversationId: string; onBack: () => void }) {
  const queryClient = useQueryClient();
  const conv = useConversation(conversationId);
  const messages = useMessages(conversationId);
  const send = useSendMessage();
  const markRead = useMarkRead();
  const [text, setText] = useState('');
  const [templateOpen, setTemplateOpen] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const list = useMemo(() => allMessages(messages.data?.pages), [messages.data]);
  const [now, setNow] = useState(Date.now());

  // Mark read on open and whenever a new inbound message lands here
  const lastInboundId = [...list].reverse().find((m) => m.direction === 'in')?._id;
  useEffect(() => {
    markRead.mutate(conversationId);
  }, [conversationId, lastInboundId]);

  useEffect(() => bottom.current?.scrollIntoView({ block: 'end' }), [list.length]);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);

  if (conv.isPending) return <Skeleton className="m-4 h-40" />;
  if (conv.error) return <QueryError error={conv.error} onRetry={() => void conv.refetch()} />;

  const left = windowLeftMs(conv.data, now);
  const open = left > 0;

  const submit = () => {
    const body = text.trim();
    if (!body) return;
    const temp: WaMessage = {
      _id: `tmp-${Date.now()}`, conversationId, direction: 'out', kind: 'text', text: body,
      status: 'sent', createdAt: new Date().toISOString(), pending: true,
    };
    upsertMessage(queryClient, temp);
    setText('');
    send.mutate(
      { conversationId, text: body },
      {
        onError: (err) => {
          const e = toApiError(err);
          if (e.code === 'WINDOW_CLOSED') setTemplateOpen(true);
          notify.error(e.code === 'WINDOW_CLOSED' ? 'Reply window closed — send a template' : e.message);
          void queryClient.invalidateQueries({ queryKey: ['whatsapp', 'messages', conversationId] });
        },
      },
    );
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b px-3 py-2.5">
        <Button variant="ghost" size="icon" className="md:hidden" onClick={onBack} aria-label="Back to chats"><ArrowLeftIcon /></Button>
        <div className="min-w-0">
          <p className="truncate font-medium">{displayName(conv.data)}</p>
          <p className="text-muted-foreground text-xs">{conv.data.phone}</p>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto bg-[#f7f3f1] p-3">
        {messages.hasNextPage ? (
          <Button variant="ghost" size="sm" className="mx-auto block" onClick={() => void messages.fetchNextPage()} disabled={messages.isFetchingNextPage}>
            Load earlier messages
          </Button>
        ) : null}
        {messages.isPending ? <Skeleton className="h-24" /> : list.map((m) => <Bubble key={m._id} message={m} />)}
        <div ref={bottom} />
      </div>

      <div className={cn('border-t px-3 py-1.5 text-xs', open ? 'text-success' : 'text-[#a8742c]')}>
        {open
          ? `Reply window open · ${Math.floor(left / 3_600_000)} h ${Math.floor((left % 3_600_000) / 60_000)} m left`
          : 'Reply window closed — the customer must write first, or send an approved template'}
      </div>

      <form className="flex items-end gap-2 border-t p-3" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <Button type="button" variant="secondary" onClick={() => setTemplateOpen(true)}>Templates</Button>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
          placeholder={open ? 'Type a message' : 'Window closed — use a template'}
          disabled={!open}
          rows={1}
          className="max-h-32 min-h-10 flex-1 resize-none"
        />
        <Button type="submit" disabled={!open || !text.trim() || send.isPending}>Send</Button>
      </form>

      <TemplatePicker open={templateOpen} onOpenChange={setTemplateOpen} conversationId={conversationId} customerName={conv.data.customerId?.name} />
    </div>
  );
}

function Bubble({ message: m }: { message: WaMessage }) {
  const out = m.direction === 'out';
  return (
    <div className={cn('flex', out ? 'justify-end' : 'justify-start')}>
      <div className={cn('max-w-[78%] rounded-lg px-3 py-1.5 text-sm shadow-xs', out ? 'bg-[#e7f6e7]' : 'bg-white', m.status === 'failed' && 'ring-destructive ring-1')}>
        {m.kind === 'template' ? <p className="text-muted-foreground text-[11px]">Template</p> : null}
        {m.kind === 'media' && m.mediaUrl ? <a href={m.mediaUrl} target="_blank" rel="noreferrer" className="underline">Attachment</a> : null}
        <p className="whitespace-pre-wrap break-words">{m.text ?? (m.variables?.length ? m.variables.join(' · ') : '')}</p>
        <p className="text-muted-foreground mt-0.5 flex items-center justify-end gap-1 text-[11px]">
          {format(new Date(m.createdAt), 'HH:mm')}
          {out ? <Ticks message={m} /> : null}
        </p>
        {m.status === 'failed' ? <p className="text-destructive text-[11px]">Not delivered</p> : null}
      </div>
    </div>
  );
}

function Ticks({ message: m }: { message: WaMessage }) {
  if (m.pending) return <ClockIcon className="size-3" aria-label="Sending" />;
  if (m.status === 'failed') return <TriangleAlertIcon className="text-destructive size-3" aria-label="Failed" />;
  if (m.status === 'read') return <CheckCheckIcon className="size-3 text-sky-600" aria-label="Read" />;
  if (m.status === 'delivered') return <CheckCheckIcon className="size-3" aria-label="Delivered" />;
  return <CheckIcon className="size-3" aria-label="Sent" />;
}

export { ChatPanel };
```

**`template-picker.tsx`**

```tsx
import { useMemo, useState } from 'react';
import { Button } from '@/components/atoms/button';
import { Input } from '@/components/atoms/input';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/atoms/sheet';
import { toApiError } from '@/lib/api/errors';
import { useSendMessage, useTemplates, type WaTemplate } from '@/lib/api/whatsapp';
import { notify } from '@/lib/notify';

/** Fills a template body's {{1}}, {{2}} … with the values typed so far. */
function fillTemplate(body: string, values: string[]) {
  return body.replace(/\{\{(\d+)\}\}/g, (_, n) => values[Number(n) - 1] || `{{${n}}}`);
}

function TemplatePicker({ open, onOpenChange, conversationId, customerName }: {
  open: boolean; onOpenChange: (o: boolean) => void; conversationId: string; customerName?: string;
}) {
  const templates = useTemplates();
  const send = useSendMessage();
  const [picked, setPicked] = useState<WaTemplate | null>(null);
  const [values, setValues] = useState<string[]>([]);
  const preview = useMemo(() => (picked ? fillTemplate(picked.body, values) : ''), [picked, values]);

  const choose = (t: WaTemplate) => {
    setPicked(t);
    setValues(t.variables.map((v) => (v === 'name' && customerName ? customerName : '')));
  };

  const submit = () =>
    picked &&
    send.mutate(
      { conversationId, templateId: picked._id, variables: values },
      {
        onSuccess: (m) => {
          if (m.status === 'failed') notify.error('WhatsApp did not accept the message');
          onOpenChange(false);
          setPicked(null);
        },
        onError: (e) => notify.error(toApiError(e).message),
      },
    );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader><SheetTitle>{picked ? picked.name : 'Send a template'}</SheetTitle></SheetHeader>
        {!picked ? (
          <ul className="space-y-2 p-4">
            {(templates.data ?? []).map((t) => (
              <li key={t._id}>
                <button type="button" className="hover:bg-muted w-full rounded-lg border p-3 text-left" onClick={() => choose(t)}>
                  <p className="text-sm font-medium">{t.name}</p>
                  <p className="text-muted-foreground line-clamp-2 text-xs">{t.body}</p>
                </button>
              </li>
            ))}
            {templates.data?.length === 0 ? <p className="text-muted-foreground text-sm">No approved templates yet. Ask the owner to sync templates.</p> : null}
          </ul>
        ) : (
          <div className="space-y-3 p-4">
            {picked.variables.map((name, i) => (
              <label key={i} className="block text-sm">
                <span className="text-muted-foreground">{`{{${i + 1}}} ${name}`}</span>
                <Input value={values[i] ?? ''} onChange={(e) => setValues((v) => v.map((x, j) => (j === i ? e.target.value : x)))} />
              </label>
            ))}
            <div className="rounded-lg bg-[#e7f6e7] p-3 text-sm whitespace-pre-wrap">{preview}</div>
            <div className="flex justify-between">
              <Button variant="ghost" onClick={() => setPicked(null)}>Back</Button>
              <Button onClick={submit} disabled={send.isPending || values.some((v) => !v.trim())}>Send template</Button>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

export { TemplatePicker, fillTemplate };
```

**`contact-panel.tsx`**

```tsx
import { useState } from 'react';
import { Link } from 'react-router';
import { Button, buttonVariants } from '@/components/atoms/button';
import { Textarea } from '@/components/atoms/textarea';
import { toApiError } from '@/lib/api/errors';
import { formatDateTime, formatINR } from '@/lib/format';
import { useAddNote, useConversation } from '@/lib/api/whatsapp';
import { notify } from '@/lib/notify';

function ContactPanel({ conversationId }: { conversationId: string }) {
  const conv = useConversation(conversationId);
  const addNote = useAddNote();
  const [note, setNote] = useState('');
  if (!conv.data) return null;
  const c = conv.data.customerId;

  return (
    <aside className="flex h-full flex-col overflow-y-auto p-4 text-sm">
      {c ? (
        <section className="space-y-1">
          <p className="font-medium">{c.name}</p>
          <p className="text-muted-foreground">{c.phone}</p>
          <dl className="grid grid-cols-2 gap-2 pt-2">
            <Stat label="Visits" value={String(c.stats?.visits ?? 0)} />
            <Stat label="Spend" value={formatINR(c.stats?.spendPaise ?? 0, { whole: true })} />
            <Stat label="Wallet" value={formatINR(c.walletBalancePaise ?? 0, { whole: true })} />
            <Stat label="Due" value={formatINR(c.duePaise ?? 0, { whole: true })} />
          </dl>
          <div className="flex gap-2 pt-3">
            <Link to={`/customers/${c._id}`} className={buttonVariants({ variant: 'secondary', size: 'sm' })}>Profile</Link>
            <Link to={`/calendar?customer=${c._id}`} className={buttonVariants({ size: 'sm' })}>Book</Link>
          </div>
        </section>
      ) : (
        <section className="space-y-2">
          <p className="font-medium">{conv.data.leadId?.name || conv.data.contactMeta?.pushName || 'New contact'}</p>
          <p className="text-muted-foreground">{conv.data.phone} · not a customer yet</p>
          <Link to={`/customers?new=1&phone=${encodeURIComponent(conv.data.phone)}`} className={buttonVariants({ size: 'sm' })}>
            Add as customer
          </Link>
        </section>
      )}

      <section className="mt-6 space-y-2">
        <h3 className="font-medium">Internal notes</h3>
        <p className="text-muted-foreground text-xs">Only your team sees these.</p>
        <ul className="space-y-2">
          {conv.data.notes.map((n) => (
            <li key={n._id} className="bg-muted rounded-md p-2">
              <p>{n.note}</p>
              <p className="text-muted-foreground text-[11px]">{formatDateTime(n.createdAt)}</p>
            </li>
          ))}
        </ul>
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note" rows={2} />
        <Button
          size="sm"
          disabled={!note.trim() || addNote.isPending}
          onClick={() =>
            addNote.mutate({ id: conversationId, note: note.trim() }, {
              onSuccess: () => setNote(''),
              onError: (e) => notify.error(toApiError(e).message),
            })
          }
        >
          Save note
        </Button>
      </section>
    </aside>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-background rounded-md p-2">
      <dt className="text-muted-foreground text-[11px]">{label}</dt>
      <dd className="tnum">{value}</dd>
    </div>
  );
}

export { ContactPanel };
```

If your calendar page and customer page don't read `?customer=` or `?new=1&phone=` yet, either add that, or link to the plain pages for now.

**Mute toggle:** in the topbar user menu, add a switch bound to `isMuted()` / `setMuted()` from `use-whatsapp-realtime.ts`.

---

## Step 6 — Marketing API (`src/lib/api/marketing.ts`)

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api/client';

/*
 * Offers, segments and campaigns (WhatsApp API guide §5–§7). Percentages are basis points (2500 = 25 %).
 * Managers view; writing needs the manageMarketing flag. Branch logins only validate codes.
 */

type DiscountType = 'percentage' | 'flat';

type Offer = {
  _id: string;
  code: string;
  title: string;
  description?: string;
  offerType: 'festival' | 'special_discount' | 'segment_exclusive' | 'general';
  discountType: DiscountType;
  discountValue: number;
  maxDiscountPaise?: number;
  minBillAmountPaise: number;
  usageLimitPerCustomer: number;
  totalUsageLimit?: number;
  totalUsedCount: number;
  validFrom: string;
  validTill: string;
  branchScope: string[];
  targetSegmentId?: string;
  active: boolean;
};

type OfferBody = Omit<Offer, '_id' | 'totalUsedCount'>;

type ValidatedOffer = {
  valid: true; offerId: string; code: string; title: string; discountType: DiscountType; discountValue: number; discountPaise: number;
};

type SegmentCriteria = {
  customerType?: 'all' | 'new' | 'regular';
  inactivityDays?: number;
  spendTier?: { type: 'top_percentile' | 'min_spend'; value: number };
  serviceIds?: string[];
  categoryIds?: string[];
  serviceWithinDays?: number;
  membershipStatus?: 'active_any' | 'plan_specific' | 'non_member';
  planIds?: string[];
  gender?: 'male' | 'female' | 'other';
};

type Segment = { _id: string; name: string; description?: string; type: 'custom_rule'; criteria: SegmentCriteria; cachedCount: number };
type PredefinedSegment = { key: string; name: string; description: string; criteria: SegmentCriteria };
type SegmentPreview = {
  totalMatched: number; eligibleForWa: number; excludedOptOut: number;
  sampleCustomers: { id: string; name: string; phone: string; spendPaise: number; visits: number }[];
};

type CampaignStatus = 'draft' | 'scheduled' | 'sending' | 'paused' | 'completed' | 'cancelled';
type Audience =
  | { kind: 'selection'; customerIds: string[] }
  | { kind: 'segment'; segmentId?: string; segmentCriteria?: SegmentCriteria };

type Campaign = {
  _id: string;
  name: string;
  status: CampaignStatus;
  numberId: string | { _id: string; phone: string };
  templateId: string | { _id: string; name: string; body: string };
  offerId?: string | { _id: string; code: string; title: string };
  audience: Audience;
  variableMap: Record<string, string>;
  scheduledAt?: string;
  stats: {
    total: number; excluded: number; sent: number; delivered: number; read: number; failed: number; costPaise: number;
    conversions: { billsCount: number; revenuePaise: number; discountGivenPaise: number };
  };
  createdAt: string;
};

type CampaignBody = {
  name: string; numberId: string; templateId: string; offerId?: string; audience: Audience; variableMap: Record<string, string>; scheduledAt?: string;
};

type CampaignAnalytics = {
  campaignId: string; name: string; status: CampaignStatus; scheduledAt?: string;
  stats: {
    totalAudience: number; excluded: number; sent: number; delivered: number; read: number; failed: number; costPaise: number;
    deliveryRatePct: number; readRatePct: number;
    conversions: { billsCount: number; revenuePaise: number; discountGivenPaise: number; conversionRatePct: number };
  };
};

const mkKeys = {
  offers: ['marketing', 'offers'] as const,
  segments: ['marketing', 'segments'] as const,
  segmentCustomers: (id: string, page: number) => ['marketing', 'segments', id, 'customers', page] as const,
  preview: (criteria: SegmentCriteria) => ['marketing', 'segment-preview', criteria] as const,
  campaigns: ['marketing', 'campaigns'] as const,
  campaign: (id: string) => ['marketing', 'campaigns', id] as const,
  analytics: (id: string) => ['marketing', 'campaigns', id, 'analytics'] as const,
};

/** UI percent (25) ⇄ API basis points (2500). */
const toBps = (percent: number) => Math.round(percent * 100);
const fromBps = (bps: number) => bps / 100;

function useInvalidate(prefix: readonly string[]) {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: prefix });
}

// ---- offers ----
function useOffers() {
  return useQuery({ queryKey: mkKeys.offers, queryFn: async () => (await api.get<Offer[]>('/marketing/offers')).data });
}
function useSaveOffer() {
  const invalidate = useInvalidate(mkKeys.offers);
  return useMutation({
    mutationFn: async ({ id, body }: { id?: string; body: Partial<OfferBody> }) =>
      (id ? await api.patch<Offer>(`/marketing/offers/${id}`, body) : await api.post<Offer>('/marketing/offers', body)).data,
    onSuccess: invalidate,
  });
}
function useDeleteOffer() {
  const invalidate = useInvalidate(mkKeys.offers);
  return useMutation({ mutationFn: async (id: string) => (await api.delete(`/marketing/offers/${id}`)).data, onSuccess: invalidate });
}
function useValidateOffer() {
  return useMutation({
    mutationFn: async (body: { code: string; customerId: string; branchId?: string; grossPaise: number }) =>
      (await api.post<ValidatedOffer>('/marketing/offers/validate', body)).data,
  });
}

// ---- segments ----
function useSegments() {
  return useQuery({
    queryKey: mkKeys.segments,
    queryFn: async () => (await api.get<{ predefined: PredefinedSegment[]; custom: Segment[] }>('/marketing/segments')).data,
  });
}
/** Live audience count; pass already-debounced criteria. */
function useSegmentPreview(criteria: SegmentCriteria | null) {
  return useQuery({
    queryKey: mkKeys.preview(criteria ?? {}),
    enabled: criteria !== null,
    queryFn: async () => (await api.post<SegmentPreview>('/marketing/segments/preview', { criteria })).data,
    placeholderData: (prev) => prev,
  });
}
function useSaveSegment() {
  const invalidate = useInvalidate(mkKeys.segments);
  return useMutation({
    mutationFn: async ({ id, body }: { id?: string; body: { name: string; description?: string; criteria: SegmentCriteria } }) =>
      (id ? await api.patch<Segment>(`/marketing/segments/${id}`, body) : await api.post<Segment>('/marketing/segments', body)).data,
    onSuccess: invalidate,
  });
}
function useDeleteSegment() {
  const invalidate = useInvalidate(mkKeys.segments);
  return useMutation({ mutationFn: async (id: string) => (await api.delete(`/marketing/segments/${id}`)).data, onSuccess: invalidate });
}
function useSegmentCustomers(id: string | null, page = 1) {
  return useQuery({
    queryKey: mkKeys.segmentCustomers(id ?? '', page),
    enabled: Boolean(id),
    queryFn: async () => (await api.get(`/marketing/segments/${id}/customers`, { params: { page, limit: 25 } })).data,
  });
}

// ---- campaigns ----
function useCampaigns() {
  return useQuery({ queryKey: mkKeys.campaigns, queryFn: async () => (await api.get<Campaign[]>('/marketing/campaigns')).data });
}
function useCampaignAnalytics(id: string | null, status?: CampaignStatus) {
  return useQuery({
    queryKey: mkKeys.analytics(id ?? ''),
    enabled: Boolean(id),
    queryFn: async () => (await api.get<CampaignAnalytics>(`/marketing/campaigns/${id}/analytics`)).data,
    // No progress socket event: poll while sending
    refetchInterval: status === 'sending' ? 10_000 : false,
  });
}
function useSaveCampaign() {
  const invalidate = useInvalidate(mkKeys.campaigns);
  return useMutation({
    mutationFn: async ({ id, body }: { id?: string; body: Partial<CampaignBody> }) =>
      (id ? await api.patch<Campaign>(`/marketing/campaigns/${id}`, body) : await api.post<Campaign>('/marketing/campaigns', body)).data,
    onSuccess: invalidate,
  });
}
function useCampaignAction() {
  const invalidate = useInvalidate(['marketing', 'campaigns']);
  return useMutation({
    mutationFn: async ({ id, action, scheduledAt }: { id: string; action: 'send' | 'schedule' | 'pause' | 'cancel'; scheduledAt?: string }) =>
      (await api.post<Campaign>(`/marketing/campaigns/${id}/${action}`, action === 'schedule' ? { scheduledAt } : undefined)).data,
    onSuccess: invalidate,
  });
}

export {
  fromBps, mkKeys, toBps,
  useCampaignAction, useCampaignAnalytics, useCampaigns, useDeleteOffer, useDeleteSegment, useOffers, useSaveCampaign,
  useSaveOffer, useSaveSegment, useSegmentCustomers, useSegmentPreview, useSegments, useValidateOffer,
};
export type {
  Audience, Campaign, CampaignAnalytics, CampaignBody, CampaignStatus, Offer, OfferBody, PredefinedSegment, Segment,
  SegmentCriteria, SegmentPreview, ValidatedOffer,
};
```

---

## Step 7 — Promo code on New bill

The backend does the maths. The frontend only sends the code and shows what the preview returns.

**`src/pages/bills/bill-draft.ts`**

1. Add to the draft type and the initial value:

```ts
// type
offerCode: string | null;
offerCampaignId: string | null;
// initial draft
offerCode: null,
offerCampaignId: null,
```

2. In the body builder, next to `billDiscount` (around line 147):

```ts
...(draft.offerCode
  ? { marketingOffer: { code: draft.offerCode, ...(draft.offerCampaignId ? { campaignId: draft.offerCampaignId } : {}) } }
  : {}),
```

3. Add `offer?: { offerId: string; code: string; title?: string; campaignId?: string; discountPaise: number } | null` to the `BillPreview` type in `src/lib/api/billing.ts`, and `offerDiscountPaise?: number` to its `totals`.

**`src/pages/bills/new-bill-page.tsx`:** a promo-code row in the totals panel.

```tsx
function PromoCodeRow({ draft, setDraft, preview, previewError }: {
  draft: BillDraft;
  setDraft: (fn: (d: BillDraft) => BillDraft) => void;
  preview?: BillPreview;
  previewError: unknown;
}) {
  const [input, setInput] = useState(draft.offerCode ?? '');
  const err = previewError ? toApiError(previewError) : null;
  // Offer errors come back from the preview: 404 unknown code, 422 rule broken, 400 no customer
  const offerError =
    draft.offerCode && err && (err.status === 404 || err.status === 422 || err.fields?.customerId) ? err.message : null;

  useEffect(() => {
    // Drop a code the server refused, so the rest of the bill keeps previewing
    if (offerError) setDraft((d) => ({ ...d, offerCode: null }));
  }, [offerError]);

  if (preview?.offer) {
    return (
      <div className="flex items-center justify-between text-sm">
        <span>
          <Badge tone="success">{preview.offer.code}</Badge> {preview.offer.title}
        </span>
        <span className="tnum">
          − {formatINR(preview.offer.discountPaise)}
          <Button variant="ghost" size="xs" onClick={() => { setInput(''); setDraft((d) => ({ ...d, offerCode: null, offerCampaignId: null })); }}>
            Remove
          </Button>
        </span>
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <div className="flex gap-2">
        <Input value={input} onChange={(e) => setInput(e.target.value.toUpperCase())} placeholder="Promo code" disabled={!draft.customer} />
        <Button variant="secondary" disabled={!input.trim() || !draft.customer} onClick={() => setDraft((d) => ({ ...d, offerCode: input.trim() }))}>
          Apply
        </Button>
      </div>
      {!draft.customer ? <p className="text-muted-foreground text-xs">Choose the customer first</p> : null}
      {offerError ? <p className="text-destructive text-xs">{offerError}</p> : null}
    </div>
  );
}
```

Rules for the bill screen:
- Don't add the offer into `billDiscount`, and don't include it in the "needs approval above X %" hint. The server applies it, and it never counts towards the user's limit.
- The totals already include it: `totals.discountPaise` and `totals.totalPaise` from the preview. Show `totals.offerDiscountPaise` as its own line ("Offer DIWALI25 − ₹250").
- When the bill is saved, keep the offer chip on the receipt screen: `bill.marketingOffer.code` and `discountPaise`.
- **From a WhatsApp chat:** if the receptionist came from a campaign chat, you can set `offerCampaignId` for attribution. It's optional.

---

## Step 8 — Offers screen (`src/pages/marketing/offers-page.tsx`)

```tsx
import { useState } from 'react';
import { Badge } from '@/components/atoms/badge';
import { Button } from '@/components/atoms/button';
import { Input } from '@/components/atoms/input';
import { NativeSelect, NativeSelectOption } from '@/components/atoms/native-select';
import { SwitchField } from '@/components/atoms/switch';
import { EmptyState } from '@/components/molecules/empty-state';
import { FormSheet } from '@/components/molecules/form-sheet';
import { MoneyInput } from '@/components/molecules/money-input';
import { QueryError } from '@/components/molecules/query-error';
import { PageHeader } from '@/components/organisms/page-header';
import { useCan } from '@/hooks/use-can';
import { toApiError } from '@/lib/api/errors';
import { fromBps, toBps, useOffers, useSaveOffer, useSegments, type Offer, type OfferBody } from '@/lib/api/marketing';
import { formatDate, formatINR } from '@/lib/format';
import { notify } from '@/lib/notify';

const discountLabel = (o: Pick<Offer, 'discountType' | 'discountValue' | 'maxDiscountPaise'>) =>
  o.discountType === 'percentage'
    ? `${fromBps(o.discountValue)} %${o.maxDiscountPaise ? ` (max ${formatINR(o.maxDiscountPaise, { whole: true })})` : ''}`
    : formatINR(o.discountValue, { whole: true });

function OffersPage() {
  const offers = useOffers();
  const canManage = useCan('marketing.manage');
  const [editing, setEditing] = useState<Offer | 'new' | null>(null);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Offers"
        description="Promo codes the front desk can apply on a bill."
        actions={canManage ? <Button onClick={() => setEditing('new')}>New offer</Button> : null}
      />
      {offers.error ? <QueryError error={offers.error} onRetry={() => void offers.refetch()} /> : null}
      {offers.data?.length === 0 ? <EmptyState title="No offers yet" description="Create a code like DIWALI25 and share it in a campaign." /> : null}
      <table className="w-full text-sm">
        <thead className="text-muted-foreground text-left">
          <tr><th>Code</th><th>Title</th><th>Discount</th><th>Valid</th><th>Used</th><th>Status</th><th /></tr>
        </thead>
        <tbody>
          {(offers.data ?? []).map((o) => (
            <tr key={o._id} className="border-t">
              <td className="font-mono">{o.code}</td>
              <td>{o.title}</td>
              <td>{discountLabel(o)}</td>
              <td>{formatDate(o.validFrom)} – {formatDate(o.validTill)}</td>
              <td className="tnum">{o.totalUsedCount}{o.totalUsageLimit ? ` / ${o.totalUsageLimit}` : ''}</td>
              <td>{o.active && new Date(o.validTill) > new Date() ? <Badge tone="success">Active</Badge> : <Badge tone="neutral">Off</Badge>}</td>
              <td>{canManage ? <Button variant="ghost" size="sm" onClick={() => setEditing(o)}>Edit</Button> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing ? <OfferSheet offer={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

function OfferSheet({ offer, onClose }: { offer: Offer | null; onClose: () => void }) {
  const save = useSaveOffer();
  const segments = useSegments();
  const [form, setForm] = useState({
    code: offer?.code ?? '',
    title: offer?.title ?? '',
    offerType: offer?.offerType ?? 'festival',
    discountType: offer?.discountType ?? 'percentage',
    percent: offer && offer.discountType === 'percentage' ? fromBps(offer.discountValue) : 10,
    flatPaise: offer && offer.discountType === 'flat' ? offer.discountValue : 0,
    maxDiscountPaise: offer?.maxDiscountPaise ?? null,
    minBillAmountPaise: offer?.minBillAmountPaise ?? 0,
    usageLimitPerCustomer: offer?.usageLimitPerCustomer ?? 1,
    totalUsageLimit: offer?.totalUsageLimit ?? null,
    validFrom: offer?.validFrom.slice(0, 10) ?? new Date().toISOString().slice(0, 10),
    validTill: offer?.validTill.slice(0, 10) ?? '',
    targetSegmentId: offer?.targetSegmentId ?? '',
    active: offer?.active ?? true,
  });
  const [fields, setFields] = useState<Record<string, string>>({});
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = () => {
    const body: Partial<OfferBody> = {
      code: form.code, title: form.title, offerType: form.offerType as OfferBody['offerType'], discountType: form.discountType as OfferBody['discountType'],
      discountValue: form.discountType === 'percentage' ? toBps(form.percent) : form.flatPaise,
      ...(form.maxDiscountPaise ? { maxDiscountPaise: form.maxDiscountPaise } : {}),
      minBillAmountPaise: form.minBillAmountPaise,
      usageLimitPerCustomer: form.usageLimitPerCustomer,
      ...(form.totalUsageLimit ? { totalUsageLimit: form.totalUsageLimit } : {}),
      validFrom: form.validFrom, validTill: form.validTill,
      ...(form.targetSegmentId ? { targetSegmentId: form.targetSegmentId } : {}),
      active: form.active,
    };
    save.mutate({ id: offer?._id, body }, {
      onSuccess: () => { notify.success(offer ? 'Offer updated' : 'Offer created'); onClose(); },
      onError: (e) => { const err = toApiError(e); setFields(err.fields ?? {}); notify.error(err.message); },
    });
  };

  return (
    <FormSheet
      open
      onOpenChange={(o) => !o && onClose()}
      title={offer ? `Edit ${offer.code}` : 'New offer'}
      footer={<Button onClick={submit} disabled={save.isPending}>{offer ? 'Save changes' : 'Create offer'}</Button>}
    >
      <Field label="Code" error={fields.code}><Input value={form.code} onChange={(e) => set('code', e.target.value.toUpperCase())} disabled={Boolean(offer)} /></Field>
      <Field label="Title" error={fields.title}><Input value={form.title} onChange={(e) => set('title', e.target.value)} /></Field>
      <Field label="Type">
        <NativeSelect value={form.discountType} onChange={(e) => set('discountType', e.target.value as 'percentage' | 'flat')}>
          <NativeSelectOption value="percentage">Percent off</NativeSelectOption>
          <NativeSelectOption value="flat">Flat amount off</NativeSelectOption>
        </NativeSelect>
      </Field>
      {form.discountType === 'percentage' ? (
        <>
          <Field label="Percent" error={fields.discountValue}>
            <Input type="number" min={1} max={100} value={form.percent} onChange={(e) => set('percent', Number(e.target.value))} />
          </Field>
          <Field label="Max discount (optional)"><MoneyInput value={form.maxDiscountPaise} onValueChange={(v) => set('maxDiscountPaise', v)} /></Field>
        </>
      ) : (
        <Field label="Amount off" error={fields.discountValue}><MoneyInput value={form.flatPaise} onValueChange={(v) => set('flatPaise', v ?? 0)} /></Field>
      )}
      <Field label="Minimum bill"><MoneyInput value={form.minBillAmountPaise} onValueChange={(v) => set('minBillAmountPaise', v ?? 0)} /></Field>
      <Field label="Uses per customer"><Input type="number" min={1} value={form.usageLimitPerCustomer} onChange={(e) => set('usageLimitPerCustomer', Number(e.target.value))} /></Field>
      <Field label="Total uses (optional)"><Input type="number" min={1} value={form.totalUsageLimit ?? ''} onChange={(e) => set('totalUsageLimit', e.target.value ? Number(e.target.value) : null)} /></Field>
      <Field label="Valid from" error={fields.validFrom}><Input type="date" value={form.validFrom} onChange={(e) => set('validFrom', e.target.value)} /></Field>
      <Field label="Valid till" error={fields.validTill}><Input type="date" value={form.validTill} onChange={(e) => set('validTill', e.target.value)} /></Field>
      <Field label="Only for segment (optional)">
        <NativeSelect value={form.targetSegmentId} onChange={(e) => set('targetSegmentId', e.target.value)}>
          <NativeSelectOption value="">Everyone</NativeSelectOption>
          {(segments.data?.custom ?? []).map((s) => <NativeSelectOption key={s._id} value={s._id}>{s.name}</NativeSelectOption>)}
        </NativeSelect>
      </Field>
      <SwitchField label="Active" checked={form.active} onCheckedChange={(v) => set('active', v)} />
    </FormSheet>
  );
}

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1 text-sm">
      <span>{label}</span>
      {children}
      {error ? <span className="text-destructive text-xs">{error}</span> : null}
    </label>
  );
}

export default OffersPage;
```

- **Branch scope:** add a multi-select of `GET /business/branches/directory` and send `branchScope: [...]`. Empty means every branch.
- `FormSheet` takes the save button through `footer`, and `MoneyInput` reports paise through `onValueChange`. Both match the components in `src/components/molecules` today.

---

## Step 9 — Segments screen (`src/pages/marketing/segments-page.tsx`)

```tsx
import { useEffect, useState } from 'react';
import { Button } from '@/components/atoms/button';
import { Input } from '@/components/atoms/input';
import { NativeSelect, NativeSelectOption } from '@/components/atoms/native-select';
import { PageHeader } from '@/components/organisms/page-header';
import { useCan } from '@/hooks/use-can';
import { toApiError } from '@/lib/api/errors';
import { useSaveSegment, useSegmentPreview, useSegments, type SegmentCriteria } from '@/lib/api/marketing';
import { notify } from '@/lib/notify';

function useDebounced<T>(value: T, ms = 400) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [JSON.stringify(value), ms]);
  return v;
}

function SegmentsPage() {
  const segments = useSegments();
  const canManage = useCan('marketing.manage');
  const save = useSaveSegment();
  const [criteria, setCriteria] = useState<SegmentCriteria>({ customerType: 'all' });
  const [name, setName] = useState('');
  const preview = useSegmentPreview(useDebounced(criteria));
  const set = (patch: Partial<SegmentCriteria>) => setCriteria((c) => ({ ...c, ...patch }));

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Segments" description="Groups of customers to target with campaigns and offers." />

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[...(segments.data?.predefined ?? []), ...(segments.data?.custom ?? [])].map((s) => (
          <button key={'key' in s ? s.key : s._id} type="button" className="hover:bg-muted rounded-lg border p-3 text-left" onClick={() => setCriteria(s.criteria)}>
            <p className="font-medium">{s.name}</p>
            <p className="text-muted-foreground text-xs">{s.description}</p>
          </button>
        ))}
      </section>

      <section className="grid gap-4 rounded-xl border p-4 lg:grid-cols-[1fr_280px]">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">Customer type
            <NativeSelect value={criteria.customerType ?? 'all'} onChange={(e) => set({ customerType: e.target.value as SegmentCriteria['customerType'] })}>
              <NativeSelectOption value="all">All</NativeSelectOption>
              <NativeSelectOption value="new">New (first visit in 30 days)</NativeSelectOption>
              <NativeSelectOption value="regular">Regular (3+ visits)</NativeSelectOption>
            </NativeSelect>
          </label>
          <label className="text-sm">No visit for (days)
            <Input type="number" min={1} value={criteria.inactivityDays ?? ''} onChange={(e) => set({ inactivityDays: e.target.value ? Number(e.target.value) : undefined })} />
          </label>
          <label className="text-sm">Top spenders (%)
            <Input type="number" min={1} max={100} value={criteria.spendTier?.type === 'top_percentile' ? criteria.spendTier.value : ''}
              onChange={(e) => set({ spendTier: e.target.value ? { type: 'top_percentile', value: Number(e.target.value) } : undefined })} />
          </label>
          <label className="text-sm">Membership
            <NativeSelect value={criteria.membershipStatus ?? ''} onChange={(e) => set({ membershipStatus: (e.target.value || undefined) as SegmentCriteria['membershipStatus'] })}>
              <NativeSelectOption value="">Any</NativeSelectOption>
              <NativeSelectOption value="active_any">Active member</NativeSelectOption>
              <NativeSelectOption value="non_member">Not a member</NativeSelectOption>
            </NativeSelect>
          </label>
          <label className="text-sm">Gender
            <NativeSelect value={criteria.gender ?? ''} onChange={(e) => set({ gender: (e.target.value || undefined) as SegmentCriteria['gender'] })}>
              <NativeSelectOption value="">Any</NativeSelectOption>
              <NativeSelectOption value="female">Female</NativeSelectOption>
              <NativeSelectOption value="male">Male</NativeSelectOption>
              <NativeSelectOption value="other">Other</NativeSelectOption>
            </NativeSelect>
          </label>
          {/* serviceIds / categoryIds + serviceWithinDays: reuse your service picker from the catalogue screens */}
        </div>

        <aside className="bg-muted space-y-2 rounded-lg p-3 text-sm">
          <p className="text-2xl font-semibold tnum">{preview.data?.totalMatched ?? '—'}</p>
          <p className="text-muted-foreground">customers match</p>
          <p>{preview.data?.eligibleForWa ?? 0} on WhatsApp · {preview.data?.excludedOptOut ?? 0} opted out</p>
          <ul className="text-muted-foreground text-xs">
            {(preview.data?.sampleCustomers ?? []).slice(0, 5).map((c) => <li key={c.id}>{c.name}</li>)}
          </ul>
          {canManage ? (
            <div className="space-y-2 pt-2">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Segment name" />
              <Button className="w-full" disabled={!name.trim() || save.isPending}
                onClick={() => save.mutate({ body: { name: name.trim(), criteria } }, {
                  onSuccess: () => { notify.success('Segment saved'); setName(''); },
                  onError: (e) => notify.error(toApiError(e).message),
                })}>
                Save segment
              </Button>
            </div>
          ) : null}
        </aside>
      </section>
    </div>
  );
}

export default SegmentsPage;
```

---

## Step 10 — Campaigns (`src/pages/marketing/campaigns-page.tsx` + `campaign-wizard.tsx`)

**`campaigns-page.tsx`**

```tsx
import { useState } from 'react';
import { Badge } from '@/components/atoms/badge';
import { Button } from '@/components/atoms/button';
import { ConfirmDialog } from '@/components/molecules/confirm-dialog';
import { EmptyState } from '@/components/molecules/empty-state';
import { PageHeader } from '@/components/organisms/page-header';
import { useCan } from '@/hooks/use-can';
import { toApiError } from '@/lib/api/errors';
import { useCampaignAction, useCampaignAnalytics, useCampaigns, type Campaign, type CampaignStatus } from '@/lib/api/marketing';
import { formatDateTime, formatINR } from '@/lib/format';
import { notify } from '@/lib/notify';
import { CampaignWizard } from '@/pages/marketing/campaign-wizard';

const TONE: Record<CampaignStatus, 'neutral' | 'pending' | 'brand' | 'success' | 'danger'> = {
  draft: 'neutral', scheduled: 'pending', sending: 'brand', paused: 'pending', completed: 'success', cancelled: 'danger',
};

function CampaignsPage() {
  const campaigns = useCampaigns();
  const canManage = useCan('marketing.manage');
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const open = campaigns.data?.find((c) => c._id === openId) ?? null;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Campaigns" description="WhatsApp broadcasts to a segment or a picked list."
        actions={canManage ? <Button onClick={() => setCreating(true)}>New campaign</Button> : null} />
      {campaigns.data?.length === 0 ? <EmptyState title="No campaigns yet" /> : null}
      <ul className="divide-y rounded-xl border">
        {(campaigns.data ?? []).map((c) => (
          <li key={c._id}>
            <button type="button" className="hover:bg-muted flex w-full items-center justify-between p-3 text-left" onClick={() => setOpenId(c._id)}>
              <span>
                <span className="font-medium">{c.name}</span>
                <span className="text-muted-foreground block text-xs">
                  {typeof c.templateId === 'object' ? c.templateId.name : ''} · {c.stats.total} recipients
                  {c.scheduledAt ? ` · ${formatDateTime(c.scheduledAt)}` : ''}
                </span>
              </span>
              <Badge tone={TONE[c.status]}>{c.status}</Badge>
            </button>
          </li>
        ))}
      </ul>
      {open ? <CampaignDetail campaign={open} canManage={canManage} onClose={() => setOpenId(null)} /> : null}
      {creating ? <CampaignWizard onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

function CampaignDetail({ campaign, canManage, onClose }: { campaign: Campaign; canManage: boolean; onClose: () => void }) {
  const analytics = useCampaignAnalytics(campaign._id, campaign.status);
  const act = useCampaignAction();
  const [confirm, setConfirm] = useState<'send' | 'cancel' | null>(null);
  const s = analytics.data?.stats;
  const run = (action: 'send' | 'pause' | 'cancel') =>
    act.mutate({ id: campaign._id, action }, { onError: (e) => notify.error(toApiError(e).message), onSuccess: () => setConfirm(null) });

  return (
    <section className="space-y-3 rounded-xl border p-4">
      <header className="flex items-center justify-between">
        <h2 className="font-medium">{campaign.name}</h2>
        <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
      </header>
      <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        <Kpi label="Audience" value={s?.totalAudience} />
        <Kpi label="Delivered" value={s ? `${s.delivered} (${s.deliveryRatePct}%)` : undefined} />
        <Kpi label="Read" value={s ? `${s.read} (${s.readRatePct}%)` : undefined} />
        <Kpi label="Failed" value={s?.failed} />
        <Kpi label="Bills" value={s?.conversions.billsCount} />
        <Kpi label="Revenue" value={s ? formatINR(s.conversions.revenuePaise, { whole: true }) : undefined} />
        <Kpi label="Discount given" value={s ? formatINR(s.conversions.discountGivenPaise, { whole: true }) : undefined} />
        <Kpi label="Cost" value={s ? formatINR(s.costPaise) : undefined} />
      </dl>
      {canManage ? (
        <div className="flex flex-wrap gap-2">
          {['draft', 'scheduled', 'paused'].includes(campaign.status) ? <Button onClick={() => setConfirm('send')}>Send now</Button> : null}
          {campaign.status === 'sending' ? <Button variant="secondary" onClick={() => run('pause')}>Pause</Button> : null}
          {!['completed', 'cancelled'].includes(campaign.status) ? <Button variant="danger" onClick={() => setConfirm('cancel')}>Cancel</Button> : null}
        </div>
      ) : null}
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm === 'send' ? `Send to ${campaign.stats.total} customers?` : 'Cancel this campaign?'}
        description={confirm === 'send'
          ? 'Messages go out between 09:00 and 21:00 IST, one marketing message per customer per day. Opted-out customers are skipped.'
          : 'Messages not sent yet will not go out.'}
        onConfirm={() => confirm && run(confirm)}
      />
    </section>
  );
}

function Kpi({ label, value }: { label: string; value?: string | number }) {
  return (
    <div className="bg-muted rounded-md p-2">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="tnum">{value ?? '—'}</dd>
    </div>
  );
}

export default CampaignsPage;
```

**`campaign-wizard.tsx`** (four steps):

```tsx
import { useMemo, useState } from 'react';
import { Button } from '@/components/atoms/button';
import { Input } from '@/components/atoms/input';
import { NativeSelect, NativeSelectOption } from '@/components/atoms/native-select';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/atoms/sheet';
import { toApiError } from '@/lib/api/errors';
import { useCampaignAction, useOffers, useSaveCampaign, useSegmentPreview, useSegments, type Audience } from '@/lib/api/marketing';
import { useTemplates } from '@/lib/api/whatsapp';
import { notify } from '@/lib/notify';
import { fillTemplate } from '@/pages/whatsapp/template-picker';

type Step = 1 | 2 | 3 | 4;

function CampaignWizard({ onClose }: { onClose: () => void }) {
  const templates = useTemplates();
  const segments = useSegments();
  const offers = useOffers();
  const save = useSaveCampaign();
  const act = useCampaignAction();
  const [step, setStep] = useState<Step>(1);
  const [name, setName] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [segmentId, setSegmentId] = useState('');
  const [presetKey, setPresetKey] = useState('');
  const [vars, setVars] = useState<Record<string, string>>({});
  const [offerId, setOfferId] = useState('');
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [scheduledAt, setScheduledAt] = useState('');

  const template = templates.data?.find((t) => t._id === templateId);
  const preset = segments.data?.predefined.find((p) => p.key === presetKey);
  const audience: Audience | null = segmentId
    ? { kind: 'segment', segmentId }
    : preset
      ? { kind: 'segment', segmentCriteria: preset.criteria }
      : null;
  const reach = useSegmentPreview(
    preset ? preset.criteria : segments.data?.custom.find((s) => s._id === segmentId)?.criteria ?? null,
  );
  const preview = useMemo(
    () => (template ? fillTemplate(template.body, template.variables.map((_, i) => vars[String(i + 1)] || '')) : ''),
    [template, vars],
  );

  const finish = () => {
    if (!template || !audience) return;
    save.mutate(
      {
        body: {
          name, templateId, numberId: template.numberId, audience, variableMap: vars,
          ...(offerId ? { offerId } : {}),
        },
      },
      {
        onSuccess: (c) =>
          act.mutate(
            when === 'now' ? { id: c._id, action: 'send' } : { id: c._id, action: 'schedule', scheduledAt: new Date(scheduledAt).toISOString() },
            {
              onSuccess: () => { notify.success(when === 'now' ? 'Campaign is sending' : 'Campaign scheduled'); onClose(); },
              onError: (e) => notify.error(`Saved as draft — ${toApiError(e).message}`),
            },
          ),
        onError: (e) => notify.error(toApiError(e).message),
      },
    );
  };

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full space-y-4 sm:max-w-lg">
        <SheetHeader><SheetTitle>New campaign · step {step} of 4</SheetTitle></SheetHeader>

        {step === 1 ? (
          <div className="space-y-3 p-4">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Campaign name" />
            <NativeSelect value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <NativeSelectOption value="">Choose an approved template</NativeSelectOption>
              {(templates.data ?? []).map((t) => <NativeSelectOption key={t._id} value={t._id}>{t.name}</NativeSelectOption>)}
            </NativeSelect>
          </div>
        ) : null}

        {step === 2 ? (
          <div className="space-y-3 p-4">
            <NativeSelect value={presetKey} onChange={(e) => { setPresetKey(e.target.value); setSegmentId(''); }}>
              <NativeSelectOption value="">Ready-made segment…</NativeSelectOption>
              {(segments.data?.predefined ?? []).map((p) => <NativeSelectOption key={p.key} value={p.key}>{p.name}</NativeSelectOption>)}
            </NativeSelect>
            <NativeSelect value={segmentId} onChange={(e) => { setSegmentId(e.target.value); setPresetKey(''); }}>
              <NativeSelectOption value="">…or one of your segments</NativeSelectOption>
              {(segments.data?.custom ?? []).map((s) => <NativeSelectOption key={s._id} value={s._id}>{s.name}</NativeSelectOption>)}
            </NativeSelect>
            <p className="text-sm">{reach.data ? `${reach.data.eligibleForWa} customers will get it (${reach.data.excludedOptOut} opted out)` : ' '}</p>
          </div>
        ) : null}

        {step === 3 && template ? (
          <div className="space-y-3 p-4">
            {template.variables.map((v, i) => (
              <label key={i} className="block text-sm">
                {`{{${i + 1}}} ${v}`}
                <Input value={vars[String(i + 1)] ?? ''} onChange={(e) => setVars((x) => ({ ...x, [String(i + 1)]: e.target.value }))}
                  placeholder={v === 'name' ? '{{customer_name}}' : ''} />
              </label>
            ))}
            <p className="text-muted-foreground text-xs">{'{{customer_name}}'} is filled in per customer.</p>
            <div className="rounded-lg bg-[#e7f6e7] p-3 text-sm whitespace-pre-wrap">{preview}</div>
          </div>
        ) : null}

        {step === 4 ? (
          <div className="space-y-3 p-4">
            <NativeSelect value={offerId} onChange={(e) => setOfferId(e.target.value)}>
              <NativeSelectOption value="">No offer</NativeSelectOption>
              {(offers.data ?? []).filter((o) => o.active).map((o) => <NativeSelectOption key={o._id} value={o._id}>{o.code} — {o.title}</NativeSelectOption>)}
            </NativeSelect>
            <NativeSelect value={when} onChange={(e) => setWhen(e.target.value as 'now' | 'later')}>
              <NativeSelectOption value="now">Send now</NativeSelectOption>
              <NativeSelectOption value="later">Schedule</NativeSelectOption>
            </NativeSelect>
            {when === 'later' ? <Input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} /> : null}
            <p className="text-muted-foreground text-xs">Sends 09:00–21:00 IST only; at most one marketing message per customer per day.</p>
          </div>
        ) : null}

        <footer className="flex justify-between p-4">
          <Button variant="ghost" disabled={step === 1} onClick={() => setStep((s) => (s - 1) as Step)}>Back</Button>
          {step < 4 ? (
            <Button
              disabled={(step === 1 && (!name.trim() || !template)) || (step === 2 && !audience) || (step === 3 && !!template && template.variables.some((_, i) => !vars[String(i + 1)]))}
              onClick={() => setStep((s) => (s + 1) as Step)}
            >
              Next
            </Button>
          ) : (
            <Button onClick={finish} disabled={save.isPending || act.isPending || (when === 'later' && !scheduledAt)}>
              {when === 'now' ? 'Send campaign' : 'Schedule'}
            </Button>
          )}
        </footer>
      </SheetContent>
    </Sheet>
  );
}

export { CampaignWizard };
```

A "Pick customers" audience (`{ kind: 'selection', customerIds }`) can be added to step 2 with your existing `CustomerPicker` organism.

---

## Step 11 — Test checklist

Run the backend (`npm run dev`) and the frontend. The WhatsApp number must be saved through Super Admin; copy `webhookUrl` from the response.

| # | Do | Expect |
| --- | --- | --- |
| 1 | Log in as `owner@glox.test`; open DevTools → Network → WS | One `socket.io` connection, status 101 |
| 2 | `curl -X POST "http://localhost:4000/webhooks/instantbroadcast/<uid>?secret=<secret>" -H 'Content-Type: application/json' -d '{"from":"+919876543210","text":"Hi, slot at 4?","providerMessageId":"wamid.t1"}'` | A chime, a toast with "Open", and the sidebar WhatsApp badge goes up. The chat jumps to the top of the list |
| 3 | Open the chat | Unread clears. In a second window logged in as `branch@glox.test` (same branch), the badge also clears (`wa:chat_read`) |
| 4 | Reply "See you at 4" | The bubble shows a clock, then ✓. The other window shows it instantly |
| 5 | Same curl with `"status":"read"` and the `providerMessageId` of your reply | ✓✓ turns blue |
| 6 | Log in as `branch2@glox.test` (other branch) | The chat isn't listed; `/whatsapp?chat=<id>` → "Conversation not found" |
| 7 | Log in as the **other business's owner** | Nothing from Glox Test Salon, in the list or live |
| 8 | Set the chat's `lastInboundAt` older than 24 h (or wait) | The text box is disabled; Templates sends fine |
| 9 | Add a note | It appears in the other window too |
| 10 | Owner → Offers → New: `DIWALI25`, 25 %, valid this month | Saved; the table shows "25 %" |
| 11 | `branch@glox.test` → New bill → pick a customer → Promo code `DIWALI25` → Apply | The "DIWALI25 − ₹…" line shows; the total drops 25 %; the bill saves as **Paid**, not held |
| 12 | Apply the same code again for that customer | The limit message shows under the field, and the bill still previews without it |
| 13 | Segments → "Inactive 60 days" | The count and "on WhatsApp / opted out" appear; typing in the builder updates them after a short pause |
| 14 | Campaigns → New → Diwali, a template, a segment, variables, the offer, Schedule | The list shows "scheduled"; the detail shows analytics |
| 15 | `manager2@glox.test` without `manageMarketing` | Campaigns, Offers and Segments are visible but have no create buttons; the API returns 403 if forced |
| 16 | Stop the backend for 10 s, then restart it | The socket reconnects by itself and the chat list refreshes |
