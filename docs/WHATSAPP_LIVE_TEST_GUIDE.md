# WhatsApp Live Test — Frontend + Real Instant Broadcast

How to test the WhatsApp inbox end to end:
- your phone,
- the real Instant Broadcast (IB) account,
- a separate test backend,
- the React frontend.

**Atlas is never touched.** The test backend has its own local database.

Related: [WHATSAPP_MARKETING_API_GUIDE.md](WHATSAPP_MARKETING_API_GUIDE.md) for the API and [WHATSAPP_MARKETING_FRONTEND_GUIDE.md](WHATSAPP_MARKETING_FRONTEND_GUIDE.md) for the frontend code.

## 0. What is real and what isn't

| Part | In this test |
| --- | --- |
| WhatsApp messages | **Real.** They go to and come from real phones through IB. Each template costs **₹0.15**; the IB balance was ₹13.60 on 2026-11-03 |
| Backend | The same code as `npm run dev`, but on **:4100**, with Redis DB 5 |
| Database | A local MongoDB in `~/.glox-live-test-db`, kept between runs. `--reset` wipes it |
| Logins | `superadmin@`, `owner@`, `manager@`, `manager2@`, `branch@` (Test Branch, TST1) and `branch2@glox.test` (Adajan, TST2). The password for all is `Test@1234` |
| WhatsApp number | Connected to **Glox Test Salon → Test Branch (TST1)**. New chats land in TST1 |
| Template | `multivariable_text_template_321`. Meta-approved utility template with **exactly 4 variables** |

Your dev server on :4000 (Atlas) can keep running; the two don't share a database or queues.

## 1. Start everything (3 terminals)

Redis must be running (`redis-cli ping` → `PONG`).

**Terminal 1: the test backend** (in the backend repo)

```bash
npx tsx scripts/live-test-server.ts          # first run: seeds the logins and sample data
# npx tsx scripts/live-test-server.ts --reset  # start over with an empty database
```

Wait for `Ready: API http://localhost:4100 …`. Leave it running; this terminal is the log you read while testing. **Ctrl+C** stops the API and the database.

**Terminal 2: connect WhatsApp** (once per database; it's kept on restart)

```bash
IB_TOKEN='<the Instant Broadcast API key>' \
WA_PHONE='+91<the salon WhatsApp number>' \
TEST_PHONE='+917016620542' \
npx tsx scripts/live-test-server.ts --connect
```

It prints:
- `WhatsApp … connected`;
- `Template multivariable_text_template_321 (4 variables) is approved for sending`;
- `Customer "Live Test Customer" … added`.

Notes:
- Type the key in the terminal only. Never put it in a file or a commit.
- `TEST_PHONE` becomes a customer, so the chat shows the customer card. Leave it out to see the "new contact / lead" view instead.
- Template sync can't fetch your templates from IB yet: IB's template-list address is unknown. The script adds the template directly. Don't press **Sync templates** and expect the list to grow.

**Terminal 3: the frontend** (in `~/Desktop/Glox-Salon-Management-Frontend`)

```bash
VITE_API_BASE_URL=http://localhost:4100 npm run dev
```

Open http://localhost:5173. The variable on the command line wins over `.env`, so nothing in the repo changes.

## 2. Watch what IB sends (important on the first run)

The test backend logs **every raw IB event**. In a fourth terminal:

```bash
tail -f /private/tmp/claude-501/-Users-jagdishkumawat-Downloads-Test-managment/23bd31cf-cf95-4616-b5aa-c3586c780371/scratchpad/live.log | grep --line-buffered -E "raw event|rejected|update_conversation|Connected to Instant Broadcast"
```

If you started Terminal 1 yourself without a redirect, the same lines appear directly in Terminal 1.

> **Verified live on 2026-11-03.** IB delivers every change as `update_chat_list`: one entry per chat, with `sender_mobile`, `chat_id`, and `last_message` as a JSON string. That string holds `route` (`INCOMING` or `OUTGOING`), `metaChatId` (the wamid), `text.body`, `status` and `timestamp`. Incoming messages are stored from it, and our sent messages get their ticks from it. If a message doesn't appear, send Claude the `raw event` lines.

## 3. Test cases

Use two browser windows: a normal one and a private one, so you can be logged in twice. "Phone" means the phone with **70166 20542**.

### Connection

| # | Do | Expect | If not |
| --- | --- | --- | --- |
| L1 | Log in as `owner@glox.test`. DevTools → Network → **WS** | One `socket.io` connection, status **101**. The Terminal 1 log has `Connected to Instant Broadcast WebSocket engine` | No WS: check `VITE_API_BASE_URL`. No IB line: re-run the `--connect` step |

### Incoming messages

| # | Do | Expect | If not |
| --- | --- | --- | --- |
| L2 | From the phone, send **"Hi, live test 1"** to the salon number. The owner is on any page that **isn't** WhatsApp | Within a few seconds: a chime, a toast with **Open**, and the sidebar WhatsApp badge **+1** | Copy the raw-event lines (section 2) to Claude |
| L3 | Click **Open** in the toast | The inbox opens on that chat. The message is there, and the badge clears | — |
| L4 | Send a second message from the phone while the chat is open | It appears straight away, with no badge and no unread increase | — |
| L5 | Log in as `branch@glox.test` in the private window → WhatsApp | The same chat is listed (the number belongs to TST1) | — |
| L6 | Log in as `branch2@glox.test` (Adajan) | The chat is **not** listed. Opening `/whatsapp?chat=<id>` directly → "Conversation not found" | **Report: that's a security bug** |

### Replies

| # | Do | Expect | If not |
| --- | --- | --- | --- |
| L7 | As the owner, reply **"Got it — live reply"** | The bubble shows a clock, then ✓. **The phone receives it.** The branch window shows it instantly | ✓ shown but nothing on the phone: check the IB dashboard. A red "Not delivered": the reason is in the log as `Instant Broadcast rejected the message` |
| L8 | Templates → `multivariable_text_template_321` → fill all 4 fields → Send | The phone receives the template with your 4 values (₹0.15) | `Required parameter is missing` = a field was empty |
| L9 | Read the reply on the phone | The bubble goes ✓ → ✓✓ → blue ✓✓ within seconds. This comes over IB's live feed and needs no tunnel. Verified live | Send Claude the `raw event` lines |

### Team features

| # | Do | Expect | If not |
| --- | --- | --- | --- |
| L10 | Add a note in the right-hand panel | It shows in both windows. **It never reaches the phone** | — |
| L11 | Open the chat in window 1 while window 2 has it unread | Window 2's unread count clears by itself | — |
| L12 | As `manager2@glox.test` | Sees the chat (covers TST1 and TST2) and can reply | — |
| L13 | Customer card → **Create bill** | New bill opens with "Live Test Customer" filled in | — |

### 24-hour window and recovery

| # | Do | Expect | If not |
| --- | --- | --- | --- |
| L14 | 24-hour window. Wait a day, or ask Claude to move `lastInboundAt` back in the **test** database | The text box is disabled and the banner says the window is closed. Templates still send | — |
| L15 | Stop Terminal 1 for 10 s, then start it again | The frontend reconnects by itself and the chat list refreshes. A message sent from the phone while it was down shows up once IB redelivers it, or on the next message | — |

### Sending failures

| # | Do | Expect | If not |
| --- | --- | --- | --- |
| L16 | Make a send fail on purpose: Terminal 2 `--connect` again with `IB_TOKEN='bad.token.x'` (rejected by IB), then reply in the inbox | The bubble is red, "Not delivered". The log shows the reason | Before 2026-11-03 this showed a false ✓. Re-run `--connect` with the real key afterwards |

## 4. Known limits in this setup

- **Other contacts appear.** This IB account already has other chats. When IB sends its full list, their last incoming message is imported too, with its real time, so their 24-hour window is only open if they really wrote in the last 24 h.
- **Messages typed in IB's own dashboard** aren't copied into our inbox. Only messages sent from our app are shown as outgoing.
- **The webhook path is optional.** It's only needed if IB is set to call a URL; the live feed covers everything above. To try it:
  1. Run `cloudflared tunnel --url http://localhost:4100`.
  2. Set `https://<tunnel>/webhooks/instantbroadcast/<uid>?secret=<secret>` in IB's dashboard.
- **Template sync:** only works once IB's real template-list endpoint is known. Until then, templates are added by the script.
- **Campaigns, Offers and Segments screens** aren't in the frontend yet. Test campaigns through the API (API guide §7) with an audience of only the test customer. Every recipient costs ₹0.15.
- **Your own replies from the IB dashboard or the phone app:** these may come back through IB's event as if the customer sent them. Look at L7 in the log. If a reply you sent shows as an incoming bubble, tell Claude.

## 5. Automated frontend tests against the test backend

Your Playwright WhatsApp tests (`e2e/tests/whatsapp.spec.ts`) can run against the same backend once L2 has created a chat. They block every write, so nothing reaches the phone:

```bash
E2E_API_URL=http://localhost:4100 E2E_PASSWORD='Test@1234' \
E2E_OWNER_EMAIL=owner@glox.test E2E_MANAGER_EMAIL=manager@glox.test \
E2E_MANAGER2_EMAIL=manager2@glox.test E2E_SUPERADMIN_EMAIL=superadmin@glox.test \
E2E_BRANCH_EMAIL=branch@glox.test E2E_BRANCH2_EMAIL=branch2@glox.test \
npx playwright test e2e/tests/whatsapp.spec.ts
```

These are the names `e2e/support/env.ts` reads (`E2E_<ROLE>_EMAIL`).

## 6. Report back

For each failing row, send:
- the row number;
- what you saw;
- the matching lines from the Terminal 1 log (`raw event`, `rejected`, or any `"level":50`).

## 7. Backend changes made for this test (2026-11-03)

- **Instant Broadcast refusals.** IB answers a Meta refusal with HTTP 200 and `success: false`. The message is now saved as **failed**, with the reason in `error`. It used to be shown as sent. Network errors with a real key also fail, instead of pretending to send. This covers inbox sends and campaign sends.
- **No sample templates for a live account.** A live account whose template list can't be read gets **no** made-up templates. Before, it got 6 sample ones that Meta would refuse.
- **Chats always land in a real branch.** Chats created by campaigns, automations or a new contact go to the number's branch, else the head branch, else the oldest branch. They used to get the **business id** as their branch, which hid them from managers and branch logins. The frontend's `useChatBranch` workaround can stay but is no longer needed for new chats.
- **Raw event logging.** `IB_LOG_RAW=true` logs every raw IB event. The test backend turns it on.
- **IB live connection.** IB refuses a direct WebSocket (HTTP 400), so the backend now connects with polling first and then upgrades. Before this, the connection never worked.
- **IB message format.** `update_chat_list` is now read in IB's real format: incoming messages are stored once, and ticks move forward only (IB repeats old states). A replayed old message keeps its real time, so it doesn't reopen the 24-hour window.
- **Seed crash fixed.** `scripts/seed-sample-data.ts` crashed on a circular import from the socket module. Fixed.
- **Tests.** Five new tests in `tests/integration/whatsapp-marketing.test.ts`, one of them built from the captured IB payload; the file now has 23/23 passing.
