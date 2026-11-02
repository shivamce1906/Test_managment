# Glox Salon Frontend Integration Guide
## Marketing Module & WhatsApp Live Messaging

This comprehensive integration guide outlines all the backend API endpoints, payload structures, query parameters, error responses, and real-time Socket.IO events required to build the frontend interfaces for:
1. **Shared WhatsApp Inbox & Live 1-on-1 Chat**
2. **Customer Segmentation Engine**
3. **Marketing Offers & POS Discount Validation**
4. **Bulk WhatsApp Marketing Campaigns**
5. **Inbound & Outbound Webhooks & Delivery Receipts**

---

## 1. Authentication & Global Headers

All API endpoints (except public webhooks) require a Bearer token in the request header.

### Global Headers
| Header | Value | Description |
|---|---|---|
| `Content-Type` | `application/json` | Required for all `POST`, `PATCH`, `PUT` requests |
| `Authorization` | `Bearer <ACCESS_TOKEN>` | JWT access token obtained during login |

### Login Endpoint
* **Method**: `POST`
* **URL**: `{{BASE_URL}}/auth/login`
* **Request Body**:
```json
{
  "email": "owner@glox.test",
  "password": "Test@1234"
}
```
* **Response (`200 OK`)**:
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsIn...",
  "refreshToken": "6ae1fb64c8565d76aab89ac5.77c5...",
  "user": {
    "id": "6ae1fb64c8565d76aab89ac5",
    "name": "Test Owner",
    "email": "owner@glox.test",
    "role": "owner",
    "kind": "tenant",
    "businessId": "6ae1fb64c8565d76aab89ab8",
    "branchIds": []
  }
}
```

---

## 2. Shared WhatsApp Inbox & Live Chat

The Shared Inbox allows salon staff and managers to interact directly with customers via WhatsApp in real time.

---

### 2.1 Get All Conversations
Fetches all open chats with unread counts and customer details.

* **Method**: `GET`
* **URL**: `{{BASE_URL}}/whatsapp/conversations`
* **Query Parameters**:
  * `branchId` *(optional, ObjectId)*: Filter conversations assigned to a specific branch.
  * `status` *(optional)*: Filter by conversation status (`open`, `resolved`).
* **Response (`200 OK`)**:
```json
[
  {
    "_id": "6ae867e91e71fcde0aa8a871",
    "phone": "+917016620542",
    "numberId": "6ae867e81e71fcde0aa8a862",
    "branchId": "6ae1fb64c8565d76aab89abb",
    "customerId": {
      "_id": "6ae867e91e71fcde0aa8a86e",
      "name": "Priya Sharma",
      "phone": "+917016620542"
    },
    "unread": 1,
    "lastMessageAt": "2026-11-02T12:30:00.000Z",
    "lastInboundAt": "2026-11-02T12:30:00.000Z",
    "contactMeta": {
      "pushName": "Priya",
      "profilePicUrl": "https://..."
    }
  }
]
```

---

### 2.2 Get Chat Message History
Fetches the full back-and-forth chat history for a specific conversation in chronological order.

* **Method**: `GET`
* **URL**: `{{BASE_URL}}/whatsapp/messages?conversationId={{CONVERSATION_ID}}`
* **Response (`200 OK`)**:
```json
[
  {
    "_id": "6ae86a4d1b6559619037a342",
    "conversationId": "6ae867e91e71fcde0aa8a871",
    "direction": "in",
    "kind": "text",
    "text": "Hi, do you have any appointments available today?",
    "status": "delivered",
    "createdAt": "2026-11-02T12:25:00.000Z"
  },
  {
    "_id": "6ae876147c8b56899ab66f39",
    "conversationId": "6ae867e91e71fcde0aa8a871",
    "direction": "out",
    "kind": "text",
    "text": "Hello Priya! Yes, we have an opening at 4:30 PM.",
    "status": "sent",
    "providerMessageId": "wamid.HBgMOTE3MDE2NjIwNTQy...",
    "createdAt": "2026-11-02T12:26:00.000Z"
  }
]
```

---

### 2.3 Send 1-on-1 Outbound Chat Message
Sends a message from the salon staff to the customer.

* **Method**: `POST`
* **URL**: `{{BASE_URL}}/whatsapp/messages`

#### A. Free-form Session Text (Allowed inside 24-hour window):
```json
{
  "conversationId": "6ae867e91e71fcde0aa8a871",
  "text": "We have booked your appointment for 4:30 PM today!"
}
```

#### B. Template Message (Allowed anytime):
```json
{
  "conversationId": "6ae867e91e71fcde0aa8a871",
  "templateId": "6ae8876e705c0a0841395884",
  "variables": [
    "Priya",
    "Main Branch",
    "Today",
    "4:30 PM"
  ]
}
```

* **Response (`201 Created`)**:
```json
{
  "_id": "6ae876147c8b56899ab66f39",
  "conversationId": "6ae867e91e71fcde0aa8a871",
  "direction": "out",
  "kind": "text",
  "text": "We have booked your appointment for 4:30 PM today!",
  "status": "sent",
  "providerMessageId": "wamid.HBgMOTE3MDE2NjIwNTQyFQIAERgSQjVBMzQ3MUE5RTVEMDcxQjk4AA=="
}
```

---

### 2.4 Mark Conversation as Read
Clears the unread badge for a conversation.

* **Method**: `POST`
* **URL**: `{{BASE_URL}}/whatsapp/conversations/:id/read`
* **Response (`200 OK`)**:
```json
{
  "success": true
}
```

---

### 2.5 Save Internal Staff Chat Note
Allows staff to attach private internal notes to a conversation (not visible to customer).

* **Method**: `POST`
* **URL**: `{{BASE_URL}}/whatsapp/conversations/:id/notes`
* **Request Body**:
```json
{
  "note": "Prefers senior stylist Vikram. Sensitive scalp."
}
```
* **Response (`201 Created`)**:
```json
{
  "_id": "6ae867e91e71fcde0aa8a871",
  "notes": [
    {
      "note": "Prefers senior stylist Vikram. Sensitive scalp.",
      "authorId": "6ae1fb64c8565d76aab89ac5",
      "createdAt": "2026-11-02T12:40:00.000Z"
    }
  ]
}
```

---

## 3. Customer Segmentation Engine

The segmentation engine computes dynamic customer cohorts without multi-channel complexity. It strictly targets WhatsApp audiences and automatically excludes customers with `doNotMessage: true` or `waOptIn: false`.

---

### 3.1 Get All Customer Segments
Returns standard predefined system segments and custom salon segments.

* **Method**: `GET`
* **URL**: `{{BASE_URL}}/marketing/segments`
* **Response (`200 OK`)**:
```json
{
  "predefined": [
    {
      "key": "new_customers",
      "name": "New Customers",
      "description": "First visit within the last 30 days",
      "criteria": { "customerType": "new" }
    },
    {
      "key": "regular_customers",
      "name": "Regular Customers",
      "description": "3 or more visits with a visit in the last 90 days",
      "criteria": { "customerType": "regular" }
    },
    {
      "key": "inactive_30",
      "name": "Inactive Customers (30 Days)",
      "description": "No visit between 30 and 60 days",
      "criteria": { "inactivityDays": 30 }
    },
    {
      "key": "inactive_60",
      "name": "Inactive Customers (60 Days)",
      "description": "No visit between 60 and 90 days",
      "criteria": { "inactivityDays": 60 }
    },
    {
      "key": "inactive_90",
      "name": "Inactive Customers (90+ Days)",
      "description": "No visit for over 90 days",
      "criteria": { "inactivityDays": 90 }
    },
    {
      "key": "high_spenders_top10",
      "name": "High Spenders (Top 10%)",
      "description": "Top 10% highest spending salon clients",
      "criteria": { "spendTier": { "type": "top_percentile", "value": 10 } }
    },
    {
      "key": "active_members",
      "name": "Active Members",
      "description": "Customers with active packages/memberships",
      "criteria": { "membershipStatus": "active_any" }
    }
  ],
  "custom": []
}
```

---

### 3.2 Live Segment Preview (Audience Calculator)
Calculates real-time matching audience count before creating or scheduling a campaign.

* **Method**: `POST`
* **URL**: `{{BASE_URL}}/marketing/segments/preview`
* **Request Body**:
```json
{
  "criteria": {
    "customerType": "regular",
    "minVisits": 3,
    "lastVisitWithinDays": 60
  }
}
```
* **Response (`200 OK`)**:
```json
{
  "totalMatching": 42,
  "waOptedIn": 40,
  "optedOut": 2
}
```

---

### 3.3 Create Custom Segment
Saves custom segmentation criteria for reusable marketing campaigns.

* **Method**: `POST`
* **URL**: `{{BASE_URL}}/marketing/segments`
* **Request Body**:
```json
{
  "name": "VIP Hair Spa Lovers",
  "description": "High spending clients who take hair spa services",
  "criteria": {
    "servicesTaken": ["6ae1fb64c8565d76aab89acc"],
    "spendTier": {
      "type": "min_total_spend",
      "value": 500000
    }
  }
}
```
* **Response (`201 Created`)**:
```json
{
  "_id": "6ae88f01705c0a0841395890",
  "name": "VIP Hair Spa Lovers",
  "criteria": { ... },
  "estimatedReach": 18
}
```

---

## 4. Marketing Offers & Discounts

Manages promo codes, percentage or flat discounts, and POS checkout validation.

---

### 4.1 Create Marketing Offer
* **Method**: `POST`
* **URL**: `{{BASE_URL}}/marketing/offers`
* **Request Body**:
```json
{
  "code": "DIWALI25",
  "title": "Diwali Glow 25% Off",
  "description": "Exclusive festival offer on premium services",
  "offerType": "festival",
  "discountType": "percentage",
  "discountValue": 25,
  "maxDiscountPaise": 150000,
  "minBillAmountPaise": 50000,
  "usageLimitPerCustomer": 1,
  "totalUsageLimit": 500,
  "validFrom": "2026-11-01T00:00:00.000Z",
  "validTill": "2026-11-30T23:59:59.000Z",
  "targetSegmentId": "6ae88f01705c0a0841395890",
  "active": true
}
```
* **Response (`201 Created`)**:
```json
{
  "_id": "6ae889a07347af7ee5eea3b5",
  "code": "DIWALI25",
  "title": "Diwali Glow 25% Off",
  "discountType": "percentage",
  "discountValue": 25,
  "active": true
}
```

---

### 4.2 Validate Offer at POS Billing Checkout
Pre-validates a promo code during bill generation, checking expiry, usage limits, minimum bill spend, and segment eligibility.

* **Method**: `POST`
* **URL**: `{{BASE_URL}}/marketing/offers/validate`
* **Request Body**:
```json
{
  "code": "DIWALI25",
  "customerId": "6ae867e91e71fcde0aa8a86e",
  "grossPaise": 80000,
  "items": [
    {
      "kind": "service",
      "itemId": "6ae1fb64c8565d76aab89acc",
      "amountPaise": 80000
    }
  ]
}
```
* **Response (`200 OK`)**:
```json
{
  "valid": true,
  "offer": {
    "id": "6ae889a07347af7ee5eea3b5",
    "code": "DIWALI25",
    "discountType": "percentage",
    "discountValue": 25,
    "discountPaise": 20000
  }
}
```

---

### 4.3 POS Bill Checkout Integration with Marketing Offer
To apply the marketing offer and record campaign conversion attribution, pass the `marketingOffer` object when creating the bill.

* **Method**: `POST`
* **URL**: `{{BASE_URL}}/billing/bills`
* **Request Body**:
```json
{
  "customerId": "6ae867e91e71fcde0aa8a86e",
  "lines": [
    {
      "kind": "service",
      "refId": "6ae1fb64c8565d76aab89acc",
      "name": "Hair Spa Ritual",
      "qty": 1,
      "unitPricePaise": 80000
    }
  ],
  "payments": [
    {
      "mode": "upi",
      "amountPaise": 60000
    }
  ],
  "marketingOffer": {
    "offerId": "6ae889a07347af7ee5eea3b5",
    "code": "DIWALI25",
    "campaignId": "6ae888f47347af7ee5eea3a1",
    "discountPaise": 20000
  }
}
```
* **Attribution Result**:
  * Increments `offer.timesUsed`.
  * Increments `campaign.stats.conversions.billsCount`.
  * Accumulates `campaign.stats.conversions.revenuePaise`.

---

## 5. Bulk WhatsApp Marketing Campaigns

Allows scheduling and dispatching bulk WhatsApp campaigns. Enforces:
* Quiet hours protection (09:00 - 21:00 IST).
* 1 marketing message per customer per day anti-spam deduplication.
* WhatsApp balance deduction and ROI tracking.

---

### 5.1 Create Marketing Campaign
* **Method**: `POST`
* **URL**: `{{BASE_URL}}/marketing/campaigns`

#### A. Target by Customer Selection (Specific user list):
```json
{
  "name": "Festive Multi-Customer Broadcast",
  "numberId": "6ae867e81e71fcde0aa8a862",
  "templateId": "6ae8876e705c0a0841395884",
  "offerId": "6ae889a07347af7ee5eea3b5",
  "audience": {
    "kind": "selection",
    "customerIds": [
      "6ae867e91e71fcde0aa8a86e",
      "6ae8848eda5427c6d424c139",
      "6ae8848eda5427c6d424c13a"
    ]
  },
  "variableMap": {
    "1": "Welcome to Glox Salon!",
    "2": "Enjoy 20% OFF on all salon services.",
    "3": "Use promo code DIWALI25 upon visit.",
    "4": "Valid till Sunday."
  }
}
```

#### B. Target by Dynamic Segment:
```json
{
  "name": "Inactive Client Reactivation",
  "numberId": "6ae867e81e71fcde0aa8a862",
  "templateId": "6ae8876e705c0a0841395884",
  "audience": {
    "kind": "segment",
    "segmentCriteria": {
      "inactivityDays": 60
    }
  },
  "variableMap": {
    "1": "{{customer_name}}",
    "2": "We miss you at Glox Salon!",
    "3": "Enjoy 25% OFF your next haircut.",
    "4": "Valid for next 7 days."
  }
}
```

* **Response (`201 Created`)**:
```json
{
  "_id": "6ae888f47347af7ee5eea3a1",
  "name": "Festive Multi-Customer Broadcast",
  "status": "draft",
  "stats": {
    "total": 3,
    "sent": 0,
    "delivered": 0
  }
}
```

---

### 5.2 Trigger Campaign Immediate Send
Dispatches the campaign immediately to BullMQ queue.

* **Method**: `POST`
* **URL**: `{{BASE_URL}}/marketing/campaigns/:id/send`
* **Response (`200 OK`)**:
```json
{
  "_id": "6ae888f47347af7ee5eea3a1",
  "status": "sending",
  "stats": {
    "total": 3,
    "sent": 3
  }
}
```

---

### 5.3 Schedule Campaign for Future Date
* **Method**: `POST`
* **URL**: `{{BASE_URL}}/marketing/campaigns/:id/schedule`
* **Request Body**:
```json
{
  "scheduledAt": "2026-11-05T10:00:00.000Z"
}
```
* **Response (`200 OK`)**:
```json
{
  "_id": "6ae888f47347af7ee5eea3a1",
  "status": "scheduled",
  "scheduledAt": "2026-11-05T10:00:00.000Z"
}
```

---

### 5.4 Get Campaign Analytics & ROI
Fetches comprehensive delivery performance and sales conversion attribution.

* **Method**: `GET`
* **URL**: `{{BASE_URL}}/marketing/campaigns/:id/analytics`
* **Response (`200 OK`)**:
```json
{
  "campaignId": "6ae888f47347af7ee5eea3a1",
  "name": "Festive Multi-Customer Broadcast",
  "status": "completed",
  "stats": {
    "total": 5,
    "sent": 5,
    "delivered": 5,
    "read": 3,
    "failed": 0,
    "costPaise": 75
  },
  "conversions": {
    "billsCount": 2,
    "revenuePaise": 350000,
    "discountGivenPaise": 50000
  },
  "roiMetrics": {
    "deliveryRatePct": 100,
    "readRatePct": 60,
    "conversionRatePct": 40,
    "netRoiMultiple": 46.6
  }
}
```

---

## 6. Real-Time Socket.IO Events

The frontend can establish a Socket.IO connection to receive instant updates without polling:

```typescript
import { io } from 'socket.io-client';

const socket = io('http://localhost:4000', {
  auth: { token: '<YOUR_ACCESS_TOKEN>' }
});

// Join business notification room
socket.emit('join:business', '<BUSINESS_ID>');
```

### Supported Socket Events
| Event Name | Payload Description |
|---|---|
| `wa:new_message` | Triggered when a new inbound message arrives or an outbound message is created. Contains full `message` and `conversationId`. |
| `wa:message_status` | Delivery receipt callback (`sent`, `delivered`, `read`). Contains `providerMessageId` and new `status`. |
| `wa:chat_note_saved` | Internal note added by a staff member. |
| `marketing:campaign_progress` | Emitted when a background campaign finishes sending batches. |

---

## 7. Webhooks Configuration

* **Inbound URL**: `POST {{BASE_URL}}/webhooks/instantbroadcast/:uid`
* Instant Broadcast automatically forwards inbound customer messages and delivery status updates (`sent`, `delivered`, `read`) to this URL.
* Inbound payload from Instant Broadcast:
```json
{
  "from": "+917016620542",
  "text": "Hi, I want to book an appointment",
  "providerMessageId": "wamid.HBgM...",
  "senderName": "Priya Sharma"
}
```

---

## 8. Common HTTP Error Codes

| Status Code | Error Code | Description & Solution |
|---|---|---|
| `400` | `BAD_REQUEST` | Missing required payload parameter or invalid format. |
| `401` | `UNAUTHENTICATED` | Bearer token is missing, expired, or invalid. |
| `401` | `ACCOUNT_INACTIVE` | User is deleted or marked inactive. |
| `403` | `FORBIDDEN` | Role or permission missing (e.g., manager missing `manageMarketing`). |
| `404` | `RESOURCE_NOT_FOUND` | Conversation, Customer, Template, or Offer does not exist. |
| `422` | `WINDOW_CLOSED` | Attempted to send free-form session text outside Meta's 24-hour customer window. Use an approved template. |
| `422` | `TEMPLATE_NOT_APPROVED` | Specified template is rejected, pending, or does not exist. |
| `500` | `TENANT_SCOPE_MISSING` | Internal security guard triggered when business isolation filter is omitted. |

