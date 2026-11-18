# Glox Salon — WhatsApp Inbox & Marketing APIs (Frontend Integration Guide)

This guide covers the **shared WhatsApp inbox** (live 1-on-1 chat), **real-time socket events**, **marketing offers** (promo codes on bills), **customer segments** and **marketing campaigns**.

It replaces `frontend integration guide.md` and `FRONTEND_WHATSAPP_CHAT_GUIDE.md` at the repo root. Several things in those two files don't match the backend; see [§10](#10-corrections-to-the-two-old-guides). Every JSON block here was captured from the running backend on the test database (business "Glamour Studio", branches SRT1 "Vesu" and SRT2 "Adajan").

Base URL: `VITE_API_BASE_URL` (default `http://localhost:4000`). There's **no `/api/v1` prefix**. Every request except webhooks sends `Authorization: Bearer <accessToken>`.

## Contents

1. [Who can do what](#1-who-can-do-what)
2. [Setup: connecting a WhatsApp number (Super Admin)](#2-setup-connecting-a-whatsapp-number-super-admin)
3. [Real-time: Socket.IO](#3-real-time-socketio)
4. [Inbox REST API](#4-inbox-rest-api)
5. [Marketing offers and promo codes on bills](#5-marketing-offers-and-promo-codes-on-bills)
6. [Customer segments](#6-customer-segments)
7. [Marketing campaigns](#7-marketing-campaigns)
8. [Errors](#8-errors)
9. [Frontend implementation checklist](#9-frontend-implementation-checklist)
10. [Corrections to the two old guides](#10-corrections-to-the-two-old-guides)
11. [Backend changes (2026-11-03)](#11-backend-changes-2026-11-03)

---

## 1. Who can do what

✅ = full · 👁 = view only · ⚑ = with the manager flag · ❌ = 403

| Feature | Owner | Manager | Branch login |
| --- | --- | --- | --- |
| Inbox: list, open, send, read, notes | ✅ all branches | ✅ own branches | ✅ own branch |
| Inbox: full customer number inside the chat | ✅ | ✅ | ✅ (PRD: "full, own branch") |
| Templates list | ✅ | ✅ | ✅ |
| Template sync (`POST /whatsapp/templates/sync`) | ✅ | ❌ | ❌ |
| Offers: list, open | ✅ | 👁 | ❌ |
| Offers: create, edit, delete | ✅ | ⚑ `manageMarketing` | ❌ |
| Offer code check (`POST /marketing/offers/validate`) and offer on a bill | ✅ | ✅ | ✅ |
| Segments: list, preview, customers | ✅ | 👁 | ❌ |
| Segments: create, edit, delete | ✅ | ⚑ `manageMarketing` | ❌ |
| Campaigns: list, open, analytics | ✅ | 👁 | ❌ |
| Campaigns: create, edit, schedule, send, pause, cancel | ✅ | ⚑ `manageMarketing` | ❌ |

**Use `/marketing/campaigns` only.** The older `/whatsapp/campaigns` and `/whatsapp/automations` endpoints still exist, but the UI shouldn't build on `/whatsapp/campaigns`. Writing to `/whatsapp/campaigns` is owner only.

**Branch scope:** a manager or branch login asking for another branch's chats gets `403 "You do not have access to this branch"`. Opening another branch's conversation by id gets `404 "Conversation not found"`.

---

## 2. Setup: connecting a WhatsApp number (Super Admin)

`POST /admin/businesses/:id/wa-config` (platform token):

```json
{ "phone": "+919800000077", "uid": "<Instant Broadcast uid>", "userToken": "<Instant Broadcast token>", "branchIds": ["<branch that owns new chats>"] }
```

**200**: the number, plus **`webhookUrl`**. Paste that into Instant Broadcast's webhook settings, prefixed with the public API host:

```json
{ "_id": "…", "phone": "+919800000077", "provider": "instant_broadcast", "status": "active",
  "webhookUrl": "/webhooks/instantbroadcast/ib-uid-9?secret=3f9c…48 hex characters…" }
```

- **Webhooks need the secret.** It's checked against `?secret=` or the `x-webhook-secret` header; without it, or with a wrong one, the webhook gets `401 INVALID_SIGNATURE`.
- The secret is generated on the first save and **kept** on later saves. Send `webhookSecret` (16+ characters) to set your own.
- Numbers saved before 2026-11-03 had a placeholder secret. **Save each number once again** (same body) to get a real secret, then update the URL in Instant Broadcast.
- New inbound chats are assigned to the number's first `branchIds` entry, or to the head (oldest) branch when it has none.
- This endpoint used to fail with `400 TENANT_SCOPE_MISSING`; that's fixed.

**Several businesses:** every business connects its **own** WhatsApp account. One business may have several numbers, for example one per branch, using `branchIds`.

| Rule | Behaviour |
| --- | --- |
| A `uid` or phone already connected to another business | `409 {"error":{"code":"ALREADY_EXISTS","message":"This WhatsApp account is already connected to another business","fields":{"uid":"Already used by another business"}}}` (or `fields.phone`). Show it on the Super Admin form |
| Re-saving the same number for the same business | Allowed; the secret is kept |
| Webhooks | Routed by the number in the URL, so the message lands only in that number's business. A uid that was saved for two businesses before this check is **dropped** (logged) rather than guessed |
| After a server restart or deploy | The live Instant Broadcast connection of every active number of every business is reopened automatically |
| Who sees a chat | Only users of the number's business: owners see all its branches, managers and branch logins their own. Replies go out from that business's own number |

---

## 3. Real-time: Socket.IO

### 3.1 Connect

```bash
npm install socket.io-client@4
```

```ts
// src/lib/socket.ts
import { io, type Socket } from 'socket.io-client';
import { getAccessToken } from '@/lib/api/client';

let socket: Socket | null = null;

export function connectSocket(): Socket {
  if (socket) return socket;
  socket = io(import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000', {
    path: '/socket.io',
    transports: ['websocket', 'polling'],
    auth: (cb) => cb({ token: getAccessToken() }), // read fresh on every (re)connect
    reconnection: true,
  });
  return socket;
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}
```

**Auth** works the same as HTTP: signature, expiry, a **revoked session** (password reset, branches changed, logout everywhere) and an inactive user are all refused with a `connect_error`. On `connect_error`:
1. refresh the access token with your existing refresh flow;
2. call `socket.connect()` again;
3. if the refresh fails, log out.

**Rooms** are joined by the server; the client emits nothing:

| Role | Receives |
| --- | --- |
| Owner | Every branch |
| Manager | Only their branches |
| Branch login | Only its branch |

Call `connectSocket()` after login and `disconnectSocket()` on logout. After a reconnect, refetch the conversation list and the open chat; events sent while offline aren't replayed.

### 3.2 Events

| Event | Payload | What the frontend does |
| --- | --- | --- |
| `wa:new_message` | `{ conversationId, message }`: `message` is the same shape as in [§4.3](#43-messages-history-paged) | If that chat is open, append it (skip if `_id` is already shown, since your own send returns it too). Move the chat to the top and update the preview. If `message.direction === "in"`: bump unread unless the chat is open, and **play the chime** |
| `wa:message_status` | `{ conversationId, messageId, providerMessageId, status }` | Update the ticks on that message (`sent` → `delivered` → `read`, or `failed`). Match on **`messageId` = `message._id`** |
| `wa:chat_read` | `{ conversationId }` | Set that chat's unread to 0 (someone else opened it) |
| `wa:chat_note_saved` | `{ conversationId, note: { note, authorId, createdAt, _id } }` | Append to the notes panel |
| `wa:conversation_update` | `{ chatId, data, numberId }` | Raw provider event. Refetch the list (debounced); never render `data` directly |
| `wa:chat_info_update` | provider data with `chatId`, `name`, `profilePic` | Refetch the conversation for the new name and avatar |
| `wa:ring` | `{ numberId, data }` | Provider chime. **Don't** play a sound on it, because `wa:new_message` with `direction: "in"` already does; ignore it to avoid double chimes |
| `wa:chat_list_update` | `{ numberId, data }` | Owners only; raw provider list. Refetch the list (debounced) |

Captured `wa:new_message` for an inbound message:

```json
{ "conversationId": "6ae9ad43730f68dfd722ca01",
  "message": { "_id": "6ae9ad43730f68dfd722ca12", "conversationId": "6ae9ad43730f68dfd722ca01", "direction": "in", "kind": "text",
               "text": "Hi, any slot at 4?", "senderName": "Priya S", "status": "delivered", "providerMessageId": "wamid.A1",
               "origin": "inbox", "createdAt": "2026-11-03T09:45:39.893Z" } }
```

There's **no** `marketing:campaign_progress` event. For campaign progress, refetch the analytics ([§7.4](#74-analytics)) every 10 s while a campaign is `sending`.

---

## 4. Inbox REST API

### 4.1 Conversation list

`GET /whatsapp/conversations`

| Query | Meaning |
| --- | --- |
| `branchId` | One branch (must be one of yours; otherwise 403). Leave it out for all your branches |
| `unreadOnly=true` | Only chats with `unread > 0` |
| `search` | Matches the WhatsApp name (`contactMeta.pushName`), the customer's name, or phone digits (`98111`) |

Sorted by `lastMessageAt`, newest first. **200** (captured):

```json
[
  {
    "_id": "6ae9ad43730f68dfd722ca01", "numberId": "6ae9ad43730f68dfd722c9fb", "branchId": "6ae9ad43730f68dfd722c9b4",
    "phone": "+919876543210",
    "customerId": { "_id": "6ae9ad43730f68dfd722c9e9", "name": "Priya Shah", "phone": "+919876543210" },
    "contactMeta": { "pushName": "Priya S" },
    "unread": 2, "lastInboundAt": "2026-11-03T09:45:39.869Z", "lastMessageAt": "2026-11-03T09:45:39.869Z",
    "notes": []
  }
]
```

| Field | Notes |
| --- | --- |
| `customerId` or `leadId` | `customerId` is set for a known customer. Otherwise `leadId` (`{ name, phone, stage }`) is set for a new number |
| Display name | `customerId.name` → `leadId.name` → `contactMeta.pushName` → `phone` |
| `lastInboundAt` | Starts the 24-hour window ([§4.4](#44-send-a-message)) |

### 4.2 Open a conversation

`GET /whatsapp/conversations/:id` returns the same fields, with a richer `customerId` for the right-hand panel:

```json
"customerId": { "_id": "6ae9ad43730f68dfd722c9e9", "name": "Priya Shah", "phone": "+919876543210",
                "stats": { "visits": 0, "spendPaise": 0, "noShows": 0 }, "tags": [], "walletBalancePaise": 0, "loyaltyPoints": 0, "duePaise": 0 }
```

For recent bills, use `GET /customers/:id/history` (owner guide §12). Opening a chat does **not** mark it read; call [§4.5](#45-mark-read) for that.

### 4.3 Messages: history, paged

`GET /whatsapp/messages?conversationId=<id>&limit=50&skip=0`

- Returns the **latest** `limit` messages in **display order, oldest → newest**.
- For "Load earlier", call again with `skip` = the number of messages already loaded.
- When fewer than `limit` come back, there are no older messages.
- `limit` is at most 200.

```json
[
  { "_id": "6ae9ad43730f68dfd722ca12", "direction": "in", "kind": "text", "text": "Hi, any slot at 4?", "senderName": "Priya S",
    "status": "delivered", "providerMessageId": "wamid.A1", "createdAt": "2026-11-03T09:45:39.893Z" },
  { "_id": "6ae9ad43730f68dfd722ca1e", "direction": "out", "kind": "text", "text": "Yes! 4:30 with Sam.",
    "status": "sent", "origin": "inbox", "sentBy": "6ae9ad43730f68dfd722c9cc", "createdAt": "2026-11-03T09:45:39.975Z" }
]
```

| Field | Values |
| --- | --- |
| `kind` | `text` · `template` (has `templateId` and `variables`) · `media` (has `mediaUrl`) |
| `status` | `sent` · `delivered` · `read` · `failed` |
| `origin` | `inbox` (staff), or `campaign` / `automation` (system) |

### 4.4 Send a message

`POST /whatsapp/messages`

**Free text**, only inside the 24-hour window (the customer wrote within the last 24 h):

```json
{ "conversationId": "6ae9ad43730f68dfd722ca01", "text": "Yes! 4:30 with Sam." }
```

**Template**, allowed any time:

```json
{ "conversationId": "6ae9ad43730f68dfd722ca01", "templateId": "6ae9ad43730f68dfd722c9fd", "variables": ["Priya", "4:30 PM"] }
```

**201** (captured): the stored message.

```json
{ "_id": "6ae9ad44730f68dfd722ca25", "conversationId": "6ae9ad43730f68dfd722ca01", "direction": "out", "kind": "template",
  "templateId": "6ae9ad43730f68dfd722c9fd", "variables": ["Priya", "4:30 PM"], "status": "sent",
  "providerMessageId": "ib_1793699140010_bvshj", "origin": "inbox", "createdAt": "2026-11-03T09:45:40.010Z" }
```

- **Check `status`:** a `201` can still come back with `"status": "failed"` when the provider refused the message. Show a red "Not delivered — retry" on it.
- **Window closed:** `422 {"error":{"code":"WINDOW_CLOSED","message":"Cannot send free-form message outside 24-hour customer response window. Use an approved template."}}`
- **24-hour banner:**
  - `remainingMs = 24*3600*1000 - (Date.now() - Date.parse(conv.lastInboundAt))`;
  - while it's positive, show "Reply window open for 5 h 12 m";
  - once it's ≤ 0, disable the text box and show the template picker.

### 4.5 Mark read

`POST /whatsapp/conversations/:id/read` → **200**: the conversation, with `"unread": 0`. Others get `wa:chat_read`. Call it when the user opens a chat and when a new inbound message lands in the open chat.

### 4.6 Internal notes

`POST /whatsapp/conversations/:id/notes` `{ "note": "Prefers ammonia-free colour" }` → **201**: the conversation, with the note added. Notes are never sent to the customer.

```json
"notes": [{ "_id": "6ae9ad44730f68dfd722ca30", "note": "Prefers ammonia-free colour", "authorId": "6ae9ad43730f68dfd722c9cc", "createdAt": "2026-11-03T09:45:40.090Z" }]
```

### 4.7 Templates

`GET /whatsapp/templates` returns **all** templates, including `pending` and `rejected` ones. **Show only `status === "approved"`** in the picker.

```json
{ "_id": "6ae9ad43730f68dfd722c9fd", "name": "appointment_reminder", "category": "utility", "language": "en",
  "body": "Hi {{1}}, see you at {{2}}", "variables": ["name", "time"], "status": "approved" }
```

Build one input per `variables` entry, labelled with its name. Show the `body` with `{{n}}` replaced as a live preview.

---

## 5. Marketing offers and promo codes on bills

### 5.1 Create an offer

`POST /marketing/offers` (owner, or a manager with `manageMarketing`):

```json
{
  "code": "DIWALI25", "title": "Diwali 25% off", "offerType": "festival",
  "discountType": "percentage", "discountValue": 2500,
  "maxDiscountPaise": 150000, "minBillAmountPaise": 50000,
  "usageLimitPerCustomer": 1, "totalUsageLimit": 500,
  "validFrom": "2026-11-01", "validTill": "2026-11-30",
  "branchScope": [], "targetSegmentId": "<optional segment>", "active": true
}
```

| Field | Rule |
| --- | --- |
| `discountValue` with `percentage` | **Basis points: `2500` = 25 %**, at most `10000`. Convert in the UI: `percent * 100` |
| `discountValue` with `flat` | Paise: `20000` = ₹200 |
| `code` | 3–20 letters, digits, `-` or `_`. Stored in capitals and matched ignoring case |
| `offerType` | `festival` · `special_discount` · `segment_exclusive` · `general` |
| `branchScope` | Empty = every branch |
| `targetSegmentId` | Only customers in that segment can use it |

**201** (captured, trimmed): `{ "_id": "6ae9ad44730f68dfd722ca4a", "code": "DIWALI25", "discountType": "percentage", "discountValue": 2500, "totalUsedCount": 0, "active": true, … }`

**Other actions:** `GET /marketing/offers` lists them, `GET /marketing/offers/:id` opens one, `PATCH /marketing/offers/:id` edits (same fields, all optional), and `DELETE /marketing/offers/:id` deletes.

### 5.2 Check a code (optional, for instant feedback)

`POST /marketing/offers/validate` (every salon role):

```json
{ "code": "diwali25", "customerId": "6ae9ad43730f68dfd722c9e9", "branchId": "6ae9ad43730f68dfd722c9b4", "grossPaise": 100000 }
```

**200**: `{ "valid": true, "offerId": "6ae9ad44730f68dfd722ca4a", "code": "DIWALI25", "title": "Diwali 25% off", "discountType": "percentage", "discountValue": 2500, "discountPaise": 25000 }`

A code that fails returns an **error** rather than `valid: false`. Show its `message` under the code field:

| Case | Response |
| --- | --- |
| Unknown or inactive | `404 "Invalid or inactive promotional code"` |
| Not started yet, or expired | `422 "Offer is not active yet"`, `422 "Offer has expired"` |
| Other branch | `422 "Offer is not valid at this branch"` |
| Bill too small | `422 "Bill amount must be at least ₹500.00 to apply this offer"` |
| Limits reached | `422 "Offer total usage limit has been reached"`, `422 "You have already reached the maximum redemption limit (1) for this offer"` |
| Not in the target segment | `422 "This offer is exclusive to select customer segments"` |

### 5.3 Apply it on a bill

Add **`marketingOffer: { code, campaignId? }`** to the normal preview and create calls: `POST /branches/:branchId/bills/preview` and `POST /branches/:branchId/bills` (owner guide §14).

- **The backend applies the discount itself.** It re-checks the code and works out the amount. A `discountPaise` sent by the client is **ignored**.
- **No discount-limit hold.** The offer discount doesn't count towards the user's limit, so a 25 % offer at a 10 %-limit front desk is **not** held for approval. A bill can still be held for other reasons, such as part payment or a manual discount over the limit.
- **Which lines it applies to:** service and product lines, after any manual bill discount. It never applies to plan sales or wallet top-ups.
- **`campaignId`:** pass it when the customer came from a campaign (for example, a link or code in that message). The bill's revenue and discount then count towards that campaign's conversions.

**Preview 200** (captured, trimmed):

```json
{ "payablePaise": 75000,
  "totals": { "grossPaise": 100000, "discountPaise": 25000, "taxablePaise": 75000, "totalPaise": 75000, "offerDiscountPaise": 25000 },
  "offer": { "offerId": "6ae9ad44730f68dfd722ca4a", "code": "DIWALI25", "title": "Diwali 25% off", "campaignId": "6ae9ad44730f68dfd722ca58", "discountPaise": 25000 },
  "needsApproval": true, "approvalReasons": ["partly_paid"] }
```

`needsApproval` here is only `partly_paid`, because the preview had no payment yet. With the full UPI payment of ₹750, the bill saves as `paid`.

**Bill 201** keeps the offer on the bill: `"marketingOffer": { "offerId": "…", "code": "DIWALI25", "campaignId": "…", "discountPaise": 25000 }`

**Counting:**
- An offer **use**, and the campaign conversion, is counted when the bill takes effect: saved as `paid` or `partly_paid`, or approved later.
- A held bill doesn't count until it's approved.
- Cancelling takes the count back. A refund doesn't: the customer did come and use the offer.
- An edited bill keeps its offer.

**Errors on the bill:** the same `404`/`422` messages as [§5.2](#52-check-a-code-optional-for-instant-feedback). There's also `400 fields.customerId: "Required for offers"` when no customer is chosen. Nothing is saved when the code fails.

---

## 6. Customer segments

Audiences for campaigns. WhatsApp-ineligible customers (`waOptIn: false` or `doNotMessage: true`) are counted in `excludedOptOut` and never messaged.

### 6.1 List

`GET /marketing/segments` → `{ "predefined": [...], "custom": [...] }`. The predefined ones (captured):

| `key` | Name | `criteria` |
| --- | --- | --- |
| `new_customers` | New Customers | `{ "customerType": "new" }` |
| `regular_customers` | Regular Customers | `{ "customerType": "regular" }` |
| `inactive_30` / `inactive_60` / `inactive_90` | Inactive Customers (30 / 60 / 90+ days) | `{ "inactivityDays": 30 }` and so on |
| `high_spenders_top10` | High Spenders (Top 10%) | `{ "spendTier": { "type": "top_percentile", "value": 10 } }` |
| `active_members` | Active Members | `{ "membershipStatus": "active_any" }` |

### 6.2 Criteria keys (all optional, combined with AND)

| Key | Type |
| --- | --- |
| `customerType` | `all` · `new` · `regular` |
| `inactivityDays` | Integer ≥ 1 |
| `spendTier` | `{ "type": "top_percentile", "value": 10 }` or `{ "type": "min_spend", "value": 500000 }` (paise) |
| `serviceIds`, `categoryIds` | Ids; with `serviceWithinDays` for "took it in the last N days" |
| `membershipStatus` | `active_any` · `plan_specific` (with `planIds`) · `non_member` |
| `gender` | `male` · `female` · `other` |

### 6.3 Preview (live audience count)

`POST /marketing/segments/preview` `{ "criteria": { "customerType": "all" } }` → **200**:

```json
{ "totalMatched": 1, "eligibleForWa": 1, "excludedOptOut": 0,
  "sampleCustomers": [{ "id": "6ae9acbf59671929ad16cd37", "name": "Priya Shah", "phone": "+919876543210", "spendPaise": 0, "visits": 0 }] }
```

### 6.4 Save, edit and view a segment

- `POST /marketing/segments` `{ "name": "Lapsed 60 days", "description": "…", "criteria": { "inactivityDays": 60 } }` → **201** `{ "_id": "…", "name": "Lapsed 60 days", "type": "custom_rule", "criteria": {…}, "cachedCount": 0 }`
- `GET /marketing/segments/:id` opens one.
- `PATCH /marketing/segments/:id` edits it, and `DELETE /marketing/segments/:id` deletes it.
- `GET /marketing/segments/:id/customers?page=1&limit=25` returns the matching customers.

---

## 7. Marketing campaigns

### 7.1 Create (always a draft)

`POST /marketing/campaigns`:

```json
{
  "name": "Diwali broadcast",
  "numberId": "6ae9ad43730f68dfd722c9fb",
  "templateId": "6ae9ad43730f68dfd722c9fd",
  "offerId": "6ae9ad44730f68dfd722ca4a",
  "audience": { "kind": "selection", "customerIds": ["6ae9ad43730f68dfd722c9e9"] },
  "variableMap": { "1": "{{customer_name}}", "2": "DIWALI25" }
}
```

| Field | Meaning |
| --- | --- |
| `audience.kind` | `selection` (`customerIds`) · `segment` (`segmentId` of a saved segment, **or** `segmentCriteria` inline) · `upload` (`uploadKey`) |
| `variableMap` | Template variable number → value. `{{customer_name}}` is filled per customer |
| `scheduledAt` | Optional; ISO time. Same as calling schedule |
| `numberId` | The business's WhatsApp number. There's usually one; take it from a template's `numberId` |

**201** (captured, trimmed):

```json
{ "_id": "6ae9ad44730f68dfd722ca58", "name": "Diwali broadcast", "status": "draft",
  "stats": { "total": 1, "excluded": 0, "sent": 0, "delivered": 0, "read": 0, "failed": 0, "costPaise": 0,
             "conversions": { "billsCount": 0, "revenuePaise": 0, "discountGivenPaise": 0 } } }
```

### 7.2 Lifecycle

`draft` → `scheduled` → `sending` → `completed`. A campaign can also go to `paused` or `cancelled`.

| Action | Endpoint | Notes |
| --- | --- | --- |
| Edit | `PATCH /marketing/campaigns/:id` | Same fields as create, all optional |
| Schedule | `POST /marketing/campaigns/:id/schedule` `{ "scheduledAt": "2026-11-05T10:00:00.000Z" }` | → `status: "scheduled"` |
| Send now | `POST /marketing/campaigns/:id/send` | → `status: "sending"`. `422 INVALID_TRANSITION` if already `sending` or `completed` |
| Pause, cancel | `POST /marketing/campaigns/:id/pause`, `/cancel` | → `paused`, `cancelled` |

Sending runs in the background worker, which needs Redis. Show the PRD rules on the confirm dialog:
- sends only between 09:00 and 21:00 IST;
- at most one marketing message per customer per day;
- opted-out customers are skipped.

### 7.3 List and open

- `GET /marketing/campaigns` lists them, with `numberId`, `templateId` (`name`, `body`) and `offerId` (`code`, `title`) filled in.
- `GET /marketing/campaigns/:id` opens one.

### 7.4 Analytics

`GET /marketing/campaigns/:id/analytics` → **200** (captured, after one bill used the offer with this `campaignId`):

```json
{ "campaignId": "6ae9ad44730f68dfd722ca58", "name": "Diwali broadcast", "status": "scheduled", "scheduledAt": "2026-11-05T10:00:00.000Z",
  "stats": { "totalAudience": 1, "excluded": 0, "sent": 0, "delivered": 0, "read": 0, "failed": 0, "costPaise": 0,
             "deliveryRatePct": 0, "readRatePct": 0,
             "conversions": { "billsCount": 1, "revenuePaise": 75000, "discountGivenPaise": 25000, "conversionRatePct": 0 } } }
```

There's no `roiMetrics` block. Work out ROI in the UI if you want it: `revenuePaise / max(costPaise, 1)`.

---

## 8. Errors

| Status | Code | When | Show |
| --- | --- | --- | --- |
| 400 | `BAD_REQUEST` | `conversationId` missing | — (UI bug) |
| 400 | `VALIDATION_ERROR` | Body invalid. `error.fields` holds per-field messages, e.g. `discountValue: "Percentage is in basis points (2500 = 25 %); at most 10000"` | Under the field |
| 401 | `UNAUTHENTICATED` / `SESSION_REVOKED` | Token expired or revoked | Refresh or log out (sockets: `connect_error`) |
| 401 | `INVALID_SIGNATURE` | Webhook without the right secret | — (provider setup) |
| 403 | `FORBIDDEN` | Role or flag missing (`"Permission denied: missing manageMarketing privilege"`), or another branch | Hide the action |
| 404 | `NOT_FOUND` | Conversation (including another branch's), offer, campaign or segment | "Not found" |
| 422 | `WINDOW_CLOSED` | Free text after 24 h | Switch to the template picker |
| 422 | `TEMPLATE_NOT_APPROVED` | Template pending or rejected | Pick an approved one |
| 422 | `VALIDATION_ERROR` | Offer rules ([§5.2](#52-check-a-code-optional-for-instant-feedback)) | Under the code field |
| 422 | `INVALID_TRANSITION` | Campaign action not allowed in its status | Toast with the message |

---

## 9. Frontend implementation checklist

I checked `~/Desktop/Glox-Salon-Management-Frontend` (read only). There's no socket client and no WhatsApp or marketing screen yet; `/whatsapp`, `/whatsapp/campaigns` and `/whatsapp/automations` are placeholders in `src/lib/navigation.ts`.

### Step 1 — Socket (shared)

1. `npm install socket.io-client@4`.
2. Add `src/lib/socket.ts` ([§3.1](#31-connect)). `getAccessToken` is already in `src/lib/api/client.ts`; export it if it isn't exported.
3. Connect after login, or when the session is restored; disconnect on logout.
4. On `connect_error`: refresh the token, then reconnect.
5. On `reconnect`: invalidate the WhatsApp queries.
6. Add a hook such as `useSocketEvent(event, handler)` that subscribes and unsubscribes in `useEffect`.
7. Add the chime: `public/sounds/message-chime.mp3`, played on `wa:new_message` with `direction === "in"`. Add a mute toggle saved in `localStorage`. Browsers block audio until the user's first click, so ignore that failure.

### Step 2 — API layer (`src/lib/api/whatsapp.ts`, `src/lib/api/marketing.ts`)

TanStack Query hooks:

| Hook | Endpoint |
| --- | --- |
| `useConversations({ branchId, unreadOnly, search })` | `GET /whatsapp/conversations` |
| `useConversation(id)` | `GET /whatsapp/conversations/:id` |
| `useMessages(id)` | `useInfiniteQuery`, `skip` = messages loaded |
| `useSendMessage`, `useMarkRead`, `useAddNote` | mutations |
| `useTemplates()` | filtered to `status === "approved"` |
| `useOffers`, `useCreateOffer`, `useUpdateOffer`, `useValidateOffer` | §5 |
| `useSegments`, `useSegmentPreview` (debounced), `useCreateSegment`, `useSegmentCustomers` | §6 |
| `useCampaigns`, `useCampaign`, `useCreateCampaign`, `useScheduleCampaign`, `useSendCampaign`, `usePause`, `useCancel`, `useCampaignAnalytics` | §7 (`refetchInterval: 10000` while `sending`) |

In socket handlers, update the query cache directly with `queryClient.setQueryData` for the message list and the conversation list, and debounce the invalidations from raw provider events.

### Step 3 — `src/lib/permissions.ts`

| Action | Rule |
| --- | --- |
| `whatsapp.inbox` | Already `{ owner, manager, branch }` ✓ |
| `whatsapp.templatesSync` *(new)* | `{ owner: true }` |
| `marketing.view` *(new)* | `{ owner: true, manager: true }` |
| `marketing.manage` *(new)* | `{ owner: true, manager: (f) => Boolean(f.manageMarketing) }` |
| `whatsapp.campaigns` | Replace its uses with `marketing.manage` |

### Step 4 — `src/lib/navigation.ts`

| Route | Change |
| --- | --- |
| `/whatsapp` (Front Desk) | Keep `OMB`; the inbox page. Add `countKey` for the total unread |
| `/whatsapp/campaigns` → `/marketing/campaigns` | `OM`; list, create, analytics |
| New `/marketing/offers` | `OM` |
| New `/marketing/segments` | `OM` |
| `/whatsapp/automations` | Keep it or hide it; not covered here (birthday, anniversary and feedback automations are owner settings) |

### Step 5 — Inbox screen (`/whatsapp`)

Use the 3-pane layout from the old chat guide; the design is good.

**Left pane: conversations**
- Search (debounced, `search`), an "Unread" toggle (`unreadOnly`), and a branch picker for owners and multi-branch managers.
- Each row shows the name ([§4.1](#41-conversation-list)), the last message preview, the time and an unread pill.

**Centre pane: chat**
- Load with `useMessages`, and add "Load earlier" at the top.
- Show ticks from `status`.
- Show the 24-hour banner ([§4.4](#44-send-a-message)); when the window is closed, disable the text box and show the template picker.
- **Optimistic send:** show a "sending…" bubble, then replace it with the `201` message; show failed (`status: "failed"`) in red.
- Call mark-read on open and when an inbound message lands in the open chat.

**Right pane: customer**
- Name, phone, visits, spend, wallet and dues (from `customerId`), recent bills (`/customers/:id/history`), and notes with an "Add note" button.
- For a lead (no `customerId`), show "Convert to customer" (`POST /leads/:id/convert`) and "Book appointment" (go to the calendar with the phone filled in).

**Phone and mobile:** a list → chat → details stack.

### Step 6 — New bill: promo code (`src/pages/bills/new-bill-page.tsx`, `bill-draft.ts`)

1. Add `offerCode` (and an optional `campaignId`) to the bill draft.
2. In the body builder (`bill-draft.ts`, around line 147, next to `billDiscount`), add `...(draft.offerCode ? { marketingOffer: { code: draft.offerCode, campaignId: draft.campaignId } } : {})`.
3. Add a "Promo code" field with an Apply button. Applying just adds the code to the draft; the existing preview call returns `offer` and the new totals.
4. Show "DIWALI25 − ₹250" from `preview.offer.discountPaise`. If the preview fails with a `404`/`422` offer error, show the message under the field and drop the code from the draft.
5. Don't add the offer to `billDiscount`. The backend applies it, and it doesn't count towards the limit hint.

### Step 7 — Marketing screens

- **Offers** (`/marketing/offers`):
  - a table (code, title, discount, validity, used / limit, active);
  - a create or edit sheet; the percentage input is in % and sent ×100;
  - a branch multi-select from `GET /business/branches/directory`, and a segment picker;
  - gate the buttons with `marketing.manage`.
- **Segments** (`/marketing/segments`):
  - the predefined cards, plus your own segments;
  - a builder for the [§6.2](#62-criteria-keys-all-optional-combined-with-and) keys with a live debounced preview: "142 customers · 138 on WhatsApp · 4 opted out";
  - "View customers" opens `/marketing/segments/:id/customers`.
- **Campaigns** (`/marketing/campaigns`):
  - a 4-step wizard: (1) name and template, (2) audience (segment, selection or saved), (3) variables, with a live preview of the template body, (4) offer and send-now or schedule;
  - a list with a status chip;
  - a detail view with analytics (delivery %, read %, bills, revenue, discount);
  - pause and cancel buttons.

### Step 8 — How to test

1. Run the backend locally. To simulate an inbound message, call the webhook:

   ```bash
   curl -X POST "http://localhost:4000/webhooks/instantbroadcast/<uid>?secret=<secret>" -H 'Content-Type: application/json' -d '{"from":"+919876543210","text":"Hi, slot at 4?","providerMessageId":"wamid.test1"}'
   ```

   The secret comes from the `wa-config` response ([§2](#2-setup-connecting-a-whatsapp-number-super-admin)).
2. Open the inbox as `owner@glox.test` and `branch@glox.test` side by side. The message appears in both, with a chime and an unread pill. `branch2@glox.test` must **not** see it.
3. Reply, add a note, and mark read. The other window updates live.
4. Create `DIWALI25` (2500 = 25 %) as the owner. Apply it on New bill as `branch@glox.test`: the total drops by 25 %, and the bill saves as paid, not held.

---

## 10. Corrections to the two old guides

| Old guide said | Correct |
| --- | --- |
| URLs under `/api/v1/…` | No prefix: `/whatsapp/…`, `/marketing/…` |
| Create bills at `POST /billing/bills` | `POST /branches/:branchId/bills`, with `marketingOffer: { code, campaignId? }` |
| Bill sends `marketingOffer.discountPaise` | Ignored; the backend works out and applies the discount |
| `discountValue: 25` = 25 % | Basis points: `2500` = 25 % |
| Validate returns `{ valid, offer: {...} }` or `valid: false` | Flat `{ valid, offerId, code, title, discountType, discountValue, discountPaise }`; a failing code returns a `404`/`422` error |
| Segment criteria `minVisits`, `lastVisitWithinDays`, `servicesTaken`, `min_total_spend` | Don't exist; see [§6.2](#62-criteria-keys-all-optional-combined-with-and) |
| Preview returns `totalMatching`, `waOptedIn`, `optedOut` | `totalMatched`, `eligibleForWa`, `excludedOptOut`, `sampleCustomers` |
| Analytics `roiMetrics` | Not returned; rates are inside `stats` |
| `socket.emit('join:business', id)` | Not needed; the server joins the rooms |
| `marketing:campaign_progress` event | Doesn't exist; poll analytics |
| Status hook matches `m._id === providerMessageId` | Match `payload.messageId === m._id` |
| Messages oldest-first with `limit`/`skip` | Now true (it wasn't before this fix) |
| `unreadOnly`, `search`, `status` filters | `unreadOnly` and `search` work now; there's no `status` (open/resolved) |
| Mark read returns `{ success: true }` | Returns the conversation |
| Play the chime on `wa:ring` | Play it on `wa:new_message` with `direction: "in"` (avoids double chimes) |
| Templates list = approved | Filter `status === "approved"` yourself |

---

## 11. Backend changes (2026-11-03)

| Area | Change |
| --- | --- |
| Inbox (**security**) | Every conversation endpoint checks the user's branches. Another branch's chat → 404; `?branchId=` of another branch → 403. Before, a branch login could read and **send** in any branch's chats |
| Sockets (**security**) | Auth now matches HTTP: revoked sessions and inactive users are refused. Owners join `owners:<businessId>`; managers and branch logins join `branch:<id>` for each of their branches. Every chat event goes to the owners plus that chat's branch only; before, it went to everyone in the business. Provider events tied to a chat follow the same routing; the rest go to owners only |
| Webhooks (**security**) | The number's secret is required (`?secret=` or `x-webhook-secret`, constant-time compare). Configuring a number generates a 48-hex secret, keeps it on re-save, replaces old placeholder secrets and returns `webhookUrl` |
| Super Admin WA config (**bug**) | `POST /admin/businesses/:id/wa-config` always failed (`TENANT_SCOPE_MISSING` on template sync); fixed |
| Offers on bills (**bug**) | The offer discount was stored but **never taken off the bill**, and the client's amount was trusted. Now the server re-checks the code, applies it to service and product lines, skips the discount-limit hold, and returns `offer` on preview. Use and campaign conversions count when the bill takes effect and are taken back on cancel |
| Offers | A percentage above `10000` bps is refused with a clear message |
| Messages | Paged with `limit`/`skip`, returned oldest → newest. Loading no longer marks the chat read. `unreadOnly` and `search` (name, customer name, phone digits) work |
| Events | `wa:message_status` now carries `conversationId` and `messageId`. `wa:chat_note_saved` carries the full note |
| Multi-business | One WhatsApp account (`uid`) or phone per business (409 otherwise). An ambiguous legacy uid drops the webhook. All active numbers reconnect at server start. The provider message id is unique **per business** (index `businessId + providerMessageId`) |

**Tests:**
- [tests/integration/whatsapp-marketing.test.ts](../tests/integration/whatsapp-marketing.test.ts) has 13 tests:
  - inbox scope for branch logins and managers, plus the owner;
  - paging order and no read on load;
  - filters and search;
  - the 24-hour window and templates;
  - webhook secrets (query, header, wrong, missing) and secret generation;
  - **live socket delivery** (owner and branch A get the event, branch B doesn't);
  - socket refusal of inactive users and revoked sessions;
  - offer basis points;
  - offers applied on bills without a limit hold, with client amounts ignored;
  - counting on approval and reversal on cancel;
  - offer error cases;
  - segment and campaign access and scheduling.
- The file also has 5 multi-business tests: two salons with their own numbers, with webhooks, REST, sends and live events never crossing over; the 409 on a shared uid or phone; ambiguous legacy uids dropped; reconnect at start for every business; and the same provider message id stored in two businesses. That makes 18 tests in the file.
- The existing WhatsApp tests (29) still pass.

**Atlas, not done yet (needs your go-ahead):**
- **Drop the old index:** `waMessages` still has the old global unique index `providerMessageId_1`. The new per-business index is created by `npx tsx scripts/build-indexes.ts`, but the old one has to be dropped by hand (`db.waMessages.dropIndex("providerMessageId_1")`). This is the same index behind the deferred index conflict.
- **Check for shared accounts:** run a read-only check for numbers whose `uid` or phone is shared between businesses, before relying on the 409.
