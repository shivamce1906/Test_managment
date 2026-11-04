# Leads API Guide

The backend contract for the **Leads** screen (`/leads`, front-desk group, owner / manager / branch).

**Contents**
- What the API does
- What the frontend needs to build
- The JSON below, captured from the real API on 2026-11-03
- Tests: `tests/integration/leads.test.ts` and `leads-whatsapp.test.ts`, 15 lead tests passing

## 1. Who sees what

| Role | Leads they see | Phone | Can create / edit / follow up / convert |
| --- | --- | --- | --- |
| Owner | Every branch | Full | Yes, any branch |
| Manager | Their assigned branches only | Full | Yes, their branches |
| Branch login | **Its own branch only** | **Full** | Yes, its own branch |

Branch scope follows the same convention as the rest of the app:
- **Another branch's list** (`?branchId=<other>`) gets **403** "You do not have access to this branch".
- **Another branch's lead** (`/leads/:id`, edit, follow-up, note, convert) gets **404** "Lead not found".
- **Moving a lead** (`PATCH branchId`) to a branch you don't have gets **403**.

## 2. Endpoints

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `GET` | `/leads` | query, see §5 | `Lead[]`, newest first. Includes `serviceIds` and `assignedTo` with names |
| `POST` | `/leads` | §3 | **201** `LeadDetail` |
| `GET` | `/leads/:id` | — | `LeadDetail` |
| `PATCH` | `/leads/:id` | any §3 field, plus `stage` and `lostReason` | `LeadDetail` |
| `POST` | `/leads/:id/follow-ups` | §4 | **201** `LeadDetail` |
| `POST` | `/leads/:id/notes` | `{ "text": "Prefers evenings" }` | **201** `LeadDetail` |
| `POST` | `/leads/:id/convert` | — | the **Customer** (created, or the existing one with that phone) |

`LeadDetail` is a lead with everything filled in for the detail screen:
- services and the assignee (with `name`);
- the customer (`name`, `phone`);
- each follow-up's and note's `by` (with `name`).

## 3. Lead fields (create and edit)

The details are the same as a customer's, so **convert copies them all**: name, email, gender, date of birth, anniversary, address and source.

| Field | Type | Create | Notes |
| --- | --- | --- | --- |
| `branchId` | id | **required** | Must be a branch you have |
| `phone` | string | **required** | 10 digits; stored as `+91…` |
| `name` | string | | |
| `email` | string | | `""` clears it |
| `gender` | `male` \| `female` \| `other` | | |
| `dob` | `YYYY-MM-DD` | | Not in the future |
| `anniversary` | `YYYY-MM-DD` | | |
| `address` | `{ line1?, line2?, city?, state?, pincode? }` | | Can be partial on a lead |
| `source` | `walk_in` \| `phone` \| `whatsapp` | default `phone` | WhatsApp leads are created automatically from unknown numbers |
| `serviceIds` | id[] | default `[]` | Services they asked about |
| `budgetPaise` | integer | | Paise |
| `assignedTo` | user id | | Must be a user of the business; `null` (PATCH) clears it |
| `followUpDate` | `YYYY-MM-DD` | | The **next** follow-up due; `null` (PATCH) clears it |
| `notes` | string | create only | Becomes the **first note** in the timeline |
| `stage` | `new` \| `contacted` \| `interested` \| `booked` \| `lost` | PATCH only | New leads start at `new` |
| `lostReason` | string | PATCH only | **Required** when setting `lost` |

**Stage rules:**
- Lost needs a reason: **400**, `fields.lostReason`.
- A lost lead can still be edited.
- Setting any other stage **reopens** a lost lead and clears `lostReason`.
- Convert sets `booked`.
- A lost lead can't be converted, and can't take a follow-up until it's reopened: **409**.

## 4. Follow-ups (1st, 2nd, 3rd …)

Each call records the next numbered follow-up. There's no limit on how many.

```http
POST /leads/:id/follow-ups
{ "channel": "call", "outcome": "interested", "note": "Coming Saturday", "nextFollowUpDate": "2026-11-05" }
```

| Field | Values |
| --- | --- |
| `channel` | `call` (default), `whatsapp`, `visit`, `other` |
| `outcome` | **required**: `no_answer`, `call_back`, `interested`, `not_interested`, `booked`, `other` |
| `note` | optional. Also added to the notes timeline, tagged with the follow-up number |
| `nextFollowUpDate` | optional `YYYY-MM-DD`. Sets the lead's `followUpDate`; **leaving it out clears it**, so nothing is due |

**What happens on the server:**
- `number` = previous count + 1, and `by` = the user who logged it.
- **The stage moves automatically:** a `new` lead becomes `contacted`, and `interested` moves a `new` or `contacted` lead to `interested`. The server never sets Lost or Booked on its own. For `not_interested`, ask the user whether to mark it Lost (with a reason). For `booked`, offer **Convert**.

**Labels:** show `followUps[i].number` as "1st follow-up", "2nd follow-up" and so on:

```ts
function ordinal(n: number) {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${suffix}`; // 1st, 2nd, 3rd, 4th … 11th, 12th, 13th, 21st
}
```

## 5. List filters (`GET /leads`)

| Query | Meaning |
| --- | --- |
| `branchId` | One branch (must be yours, else 403). Leave it out for all of yours |
| `stage` | One stage |
| `source` | `walk_in`, `phone` or `whatsapp` |
| `assignedTo` | User id ("My leads") |
| `due=today` | Follow-up due **today (IST)**; open leads only (not booked or lost) |
| `due=overdue` | Follow-up date before today; open leads only |
| `followUpDate` | An exact date |
| `search` | Name or email (contains, any case), or 3+ digits of the phone |

Bad values (for example `branchId=nope`) get **400 VALIDATION_ERROR** with `fields`.

List rows include `followUps` and `noteLog`, but their `by` is a plain user id there. Use `followUps.length` for a "3 follow-ups" chip and open the detail for names.

## 6. Captured JSON

**Detail** after create (with `notes`), one follow-up and one note:

```json
{
  "_id": "6ae9f49741ceeedb40ddeb45",
  "branchId": "6ae9f49741ceeedb40ddeafd",
  "name": "Riya Mehta",
  "phone": "+919811100000",
  "email": "riya@example.com",
  "gender": "female",
  "dob": "1995-04-12",
  "address": { "line1": "4 Ring Road", "city": "Surat" },
  "source": "walk_in",
  "serviceIds": [{ "_id": "6ae9f49741ceeedb40ddeb2b", "name": "Global Colour" }],
  "budgetPaise": 150000,
  "stage": "interested",
  "followUpDate": "2026-11-05",
  "followUps": [
    {
      "_id": "6ae9f49741ceeedb40ddeb51",
      "number": 1,
      "at": "2026-11-03T14:49:59.252Z",
      "channel": "call",
      "outcome": "interested",
      "note": "Coming Saturday",
      "nextFollowUpDate": "2026-11-05",
      "by": { "_id": "6ae9f49741ceeedb40ddeb15", "name": "Vesu Login" }
    }
  ],
  "noteLog": [
    { "_id": "…46", "text": "Asked about keratin", "at": "2026-11-03T14:49:59.231Z", "by": { "_id": "…15", "name": "Vesu Login" } },
    { "_id": "…52", "text": "Coming Saturday", "at": "2026-11-03T14:49:59.252Z", "by": { "_id": "…15", "name": "Vesu Login" }, "followUpNumber": 1 },
    { "_id": "…62", "text": "Prefers evenings", "at": "2026-11-03T14:49:59.268Z", "by": { "_id": "…15", "name": "Vesu Login" } }
  ],
  "createdAt": "2026-11-03T14:49:59.232Z",
  "updatedAt": "2026-11-03T14:49:59.268Z"
}
```

`noteLog` is oldest first; show it reversed for "newest on top". `assignedTo` (when set) is `{ _id, name, role }`, and `customerId` (after convert) is `{ _id, name, phone }`.

**Convert** returns the customer, with the lead's details copied:

```json
{ "_id": "6ae9f49741ceeedb40ddeb8b", "name": "Riya Mehta", "phone": "+919811100000", "email": "riya@example.com",
  "gender": "female", "dob": "1995-04-12", "address": { "line1": "4 Ring Road", "city": "Surat" }, "source": "walk_in", "tags": ["lead_converted"] }
```

If a customer with that phone already exists, it's **linked and not overwritten**. The lead's WhatsApp chat switches from "Lead" to that customer.

**Errors:**

```json
{ "error": { "code": "FORBIDDEN", "message": "You do not have access to this branch" } }
{ "error": { "code": "NOT_FOUND", "message": "Lead not found" } }
{ "error": { "code": "VALIDATION_ERROR", "message": "Marking a lead Lost requires a reason", "fields": { "lostReason": "Required" } } }
{ "error": { "code": "INVALID_TRANSITION", "message": "Reopen this lost lead before adding a follow-up" } }
{ "error": { "code": "VALIDATION_ERROR", "message": "Assigned user not found", "fields": { "assignedTo": "Pick a user of this business" } } }
```

## 7. TypeScript types (`src/lib/api/leads.ts`)

```ts
type LeadStage = 'new' | 'contacted' | 'interested' | 'booked' | 'lost';
type LeadSource = 'walk_in' | 'phone' | 'whatsapp';
type FollowUpChannel = 'call' | 'whatsapp' | 'visit' | 'other';
type FollowUpOutcome = 'no_answer' | 'call_back' | 'interested' | 'not_interested' | 'booked' | 'other';
type UserRef = { _id: string; name: string; role?: string };

type LeadFollowUp = {
  _id: string; number: number; at: string; channel: FollowUpChannel; outcome: FollowUpOutcome;
  note?: string; nextFollowUpDate?: string; by: UserRef | string;
};
type LeadNote = { _id: string; text: string; at: string; by: UserRef | string; followUpNumber?: number };

type Lead = {
  _id: string; branchId: string; stage: LeadStage; source: LeadSource;
  name?: string; phone: string; email?: string; gender?: 'male' | 'female' | 'other'; dob?: string; anniversary?: string;
  address?: { line1?: string; line2?: string; city?: string; state?: string; pincode?: string };
  serviceIds: { _id: string; name: string }[]; budgetPaise?: number;
  assignedTo?: UserRef; followUpDate?: string; lostReason?: string;
  followUps: LeadFollowUp[]; noteLog: LeadNote[];
  customerId?: { _id: string; name: string; phone: string };
  createdAt: string; updatedAt: string;
};

type LeadFilter = {
  branchId?: string; stage?: LeadStage; source?: LeadSource; assignedTo?: string;
  due?: 'today' | 'overdue'; followUpDate?: string; search?: string;
};
```

**Query keys:**
- `['leads', filter]` for lists and `['leads', id]` for the detail.
- Every mutation returns the full detail, so `setQueryData(['leads', id], res)` and invalidate `['leads']` for the lists.

## 8. What to build in the frontend

**List page (`/leads`):**
- Tabs: **Due today** (`due=today`, with a count badge), **Overdue** (`due=overdue`), **All**.
- Stage chips, source filter, "My leads" (`assignedTo=<me>`) and search.
- Each row shows: name, phone (a `tel:` link), services, stage badge, "*n* follow-ups", next follow-up date (red when overdue) and the assignee.
- The owner gets a branch filter from the active branch; managers and branch logins don't need one.
- **New lead** sheet with the §3 fields: name, phone, email, gender, date of birth, anniversary, address, services (multi-select), budget (`MoneyInput`), source, assignee, first follow-up date and a first note.

**Detail page or sheet:**
- **Details card:** every §3 field, with an Edit button that `PATCH`es only the changed fields.
- **Stage control:** Lost opens a reason prompt. A lost lead shows a **Reopen** button, which `PATCH`es `stage: 'contacted'`.
- **Log follow-up** button. Its form has channel, outcome (required), note, and the next follow-up date (default: in 2 days, and clearable). After `not_interested`, offer "Mark lost?". After `booked`, offer **Convert**.
- **Follow-up timeline:** "1st follow-up · Call · Interested · 03 Nov, 14:49 · Vesu Login", with the note under it.
- **Notes timeline:** newest first, with an "Add note" box. Notes from follow-ups show a "Follow-up #n" tag.
- **Convert to customer:** calls the convert endpoint, then goes to `/customers/:id`, or straight to New appointment or New bill with the customer filled in.
- **WhatsApp** (when `source` is `whatsapp`): link to the chat with `/whatsapp?search=<phone>`.

**Permissions:** everything is available to owner, manager and branch logins. Don't hide the phone for branch logins any more; it isn't masked now.

## 9. Backend changes in this round (2026-11-03)

- **Branch scope enforced everywhere:**
  - managers and branch logins only see their branches;
  - `?branchId` can no longer reach another branch;
  - get, edit, follow-up, note and convert all check the branch.
- **Full phone for branch logins.** The masking was removed by product decision, and the old test was updated.
- **Customer details on leads:** email, gender, dob, anniversary and address, all copied on convert along with the source.
- **New endpoints:** numbered follow-ups (`POST /:id/follow-ups`) and a notes timeline (`POST /:id/notes`). The old single `notes` string is kept for old leads but no longer written.
- **List filters:** `due=today|overdue`, `source` and `search`, all validated (400 instead of 500).
- **Lost leads:** they can be edited and reopened. The wrong "cannot be converted" message on edit is gone.
- **Assignee check:** it must be a user of the business.
- **Convert links the WhatsApp chat** to the customer.
