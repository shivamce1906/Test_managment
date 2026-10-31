# Glox Salon Backend — Test Failures & Fix List

**Run:** 2026-10-28 · `npx jest --runInBand` · in-memory MongoDB 6.0 replica set (no real data touched)
**Result:** **586 tests · 372 passed · 214 failed** · line coverage 73.6 %
**Tests assert the spec** (PRD, SRS, Backend SRS, Database Design). Every failure below was checked against the real API response or stack trace — they are backend defects, not test mistakes. No file in `src/` was changed.

How to use this file:
1. **Part 1** — fix list ordered by priority. Each item names the file/line, the fix, and which test files go green.
2. **Part 2** — known non-spec items and test notes.
3. **Part 3** — every one of the 214 failing tests, grouped by test file, with expected vs. actual.

Re-run one area after a fix, e.g. `npx jest tests/integration/billing.core`.

> **Progress — 2026-10-28 (Super Admin phase).** Fixed so far:
> - **#2** transactions (on replica sets / Atlas)
> - **#9** account creation
> - Super Admin password reset (`super_admin` role string)
> - `PATCH /admin/businesses/:id` accepting `status`
> - GSTIN required on onboarding
> - Redis startup (two bugs found after this report)
>
> Full suite now: **612 tests · 411 passed · 201 failed**. This includes 26 new Super Admin tests, all passing.
>
> 15 tests that failed before now pass, and none that passed before now fail. One exception: *"GET /bills/:id returns the bill with its versions"* passed only because a failed edit left its snapshot behind. It now waits on #7.
>
> **Progress — 2026-10-29 (Owner Phase 1: setup).**
> - Fixed the `.populate()` crash, part of #4. That one change fixed leaves, advances, dues, stock list, dashboard and inventory valuation.
> - Owner branch access is now checked against the business.
> - A malformed id now returns 400 instead of 500.
> - Fixed the staff, roster, attendance, leave, catalogue and team rules listed in [OWNER_API_GUIDE.md §10](OWNER_API_GUIDE.md#10-backend-changes-made-for-phase-1-2026-10-29).
>
> Full suite now: **637 tests · 460 passed · 177 failed**. No test that passed before now fails, apart from the case below.
>
> *"lead phone is masked for the branch login in lists"* used to pass only because `GET /leads` crashed. It now fails on the real bug (phones aren't masked) and waits for the leads phase.
>
> **Progress — 2026-10-29 (Owner Phases 2–3: front desk, plans, stock, money).** Fixed:
> - **#1:** router guard leak.
> - **#3:** indexes; the app can build them, and `scripts/check-duplicates.ts` found no duplicates on Atlas.
> - **#4:** the remaining tenant-scope crashes in these areas.
> - **#7:** bill edit.
> - **#10:** Idempotency-Key.
> - **Billing:** commission (slab, product, fallback); membership scope; loyalty valued by the server.
> - **Day-end:** expenses ignored; refund day.
> - **Stock and plans:** every inventory and plan rule in Part 3.
>
> **New bug found and fixed:** the compound sparse `customerPlans` voucher index allowed only one non-voucher plan per business. Atlas needs `scripts/build-indexes.ts` to replace it.
>
> Full suite now: **680 tests · 618 passed · 62 failed**. All 62 are in reports/dashboard, payroll, leads/WhatsApp, workers and auth hardening (Phase 4 and later). See [OWNER_API_GUIDE.md §19](OWNER_API_GUIDE.md#19-backend-changes-for-phases-23-2026-10-29).
>
> **Progress — 2026-10-29 (Owner Phase 4: insights, payroll).** Fixed:
> - **#8:** payroll create and mark-paid (the controller passed a bare string); statutory deductions, proration, stale check, partial mark-paid.
> - **Reports and dashboard:** rebuilt from source records (date range honoured, branch scope, margins, P&L, GSTR-1).
> - **Audit log:** append-only at the model level; the export is a real `.xlsx`.
> - **New:** bills in a locked payroll month are frozen (`PAYROLL_LOCKED`); payslip PDFs.
>
> On Atlas, `scripts/build-indexes.ts` replaced the voucher index. `waMessages` still fails to build: an existing non-unique `providerMessageId_1` has the same name. It was left as is for the WhatsApp phase.
>
> Full suite now: **700 tests · 652 passed · 48 failed**. The 48 are leads/WhatsApp (23), workers (13), reports-system (6: change polling, upload presign, CORS, body limit, unknown keys) and auth hardening (6). See [OWNER_API_GUIDE.md §25](OWNER_API_GUIDE.md#25-backend-changes-for-phase-4-2026-10-29).
>
> Parts 1 and 3 below still describe the original run. See [SUPERADMIN_API_GUIDE.md §10](SUPERADMIN_API_GUIDE.md#10-backend-changes-made-for-this-panel-2026-10-28) for the list of changes.

---

## Summary by test file

| Test file | Pass | Fail | Main causes (Part 1 #) |
| --- | ---: | ---: | --- |
| integration/access-control | 34 | 17 | 1, 4, 16, 17, 33 |
| integration/admin-catalogue-customer | 15 | 16 | 9, 2, 18, 34, 35 |
| integration/appointments | 34 | 8 | 4, 6, 24, 36 |
| integration/auth.admin | 5 | 4 | 4, 19 |
| integration/auth.login | 10 | 3 | 20, 37 |
| integration/auth.ratelimit | 0 | 1 | 37 |
| integration/auth.session | 12 | 2 | 21, 37 |
| integration/billing.atomicity | 1 | 3 | 2, 4 |
| integration/billing.core | 37 | 15 | 4, 10, 11, 13, 14, 15 |
| integration/billing.lifecycle | 16 | 12 | 7, 14 |
| integration/concurrency.billing | 1 | 11 | 2, 3, 5, 10 |
| integration/dayend | 21 | 10 | 22, 23 |
| integration/inventory | 16 | 15 | 4, 17, 25, 26 |
| integration/leads-whatsapp | 7 | 22 | 1, 4, 27, 28 |
| integration/prepaid | 17 | 19 | 4, 11, 12, 29 |
| integration/reports-system | 29 | 17 | 4, 30, 31, 32 |
| integration/staff-payroll | 26 | 17 | 8, 33, 38, 39, 40 |
| integration/workers | 1 | 13 | 4, 41 |
| unit/billing.compute | 33 | 5 | 12, 13, 42 |
| unit/money | 18 | 3 | 42 |
| unit/security-utils | 20 | 1 | 43 |
| unit/dates | 19 | 0 | — |

---

## Part 1 — Fix list (priority order)

Severity: **P0** = core feature broken / data corruption · **P1** = wrong money, security or spec rule · **P2** = validation, status codes, polish.

### P0 — fix first (unblocks the most tests)

#### 1. Router middleware leaks into every later route
- **Where:** [src/routes/payroll.routes.ts:15](../src/routes/payroll.routes.ts#L15) `payrollRouter.use(authenticate(), requireRole('owner','manager'), requirePermission('viewPayroll'))`, [src/routes/audit.routes.ts:8](../src/routes/audit.routes.ts#L8) `auditRouter.use(... requireRole('owner','super_admin'))`, plus every router's `router.use(authenticate())`, mounted at root in [src/app.ts:48-64](../src/app.ts#L48-L64).
- **Effect:** branch logins get **403** on stock, expenses, day-end, WhatsApp inbox, notifications; managers get 403 on notifications/`/changes`; the public AiSensy webhook gets **401**; unknown `/admin/*` paths give 403.
- **Fix:** mount each router on its own prefix (`app.use('/payroll-runs', …)`) **or** move guards from `router.use()` onto each route; mount the webhook router **before** any router that calls `authenticate()`.
- **Tests:** access-control (8), leads-whatsapp (webhook), reports-system (polling), staff-payroll (branch leave).

#### 2. Transactions are disabled
- **Where:** [src/config/db.ts:59-91](../src/config/db.ts#L59-L91) — `withTransaction` just runs `fn(session)`; real code is commented out.
- **Effect:** any failure mid-save leaves partial data: a bill saved "paid" with stock deducted while the API returns 500; onboarding leaves a half business; parallel same-stylist bookings double-book (3/8 runs); a rejected wallet bill is still saved.
- **Fix:** restore `session.withTransaction(...)` (needs a replica set — Atlas or `--replSet rs0` locally). Make `bill.save()` happen **after** all validations.
- **Tests:** billing.atomicity (3), concurrency.billing (3), appointments (parallel booking), admin-catalogue-customer (half onboarding).

#### 3. Unique indexes are never built
- **Where:** [src/config/db.ts:15](../src/config/db.ts#L15) `autoIndex: false`, and nothing calls `syncIndexes()`.
- **Effect:** duplicate invoice numbers, duplicate customer phones, two owners per business, duplicate login emails, duplicate attendance/day-closures are all accepted.
- **Fix:** run `Model.syncIndexes()` once at deploy (migration script) or on startup in non-prod. The control test `CONTROL: once indexes are synced, duplicates ARE rejected` already passes.
- **Tests:** concurrency.billing (6).

#### 4. Tenant-scoped models queried without `businessId` → 500 `TENANT_SCOPE_MISSING`
The `tenantScope` plugin throws on any query without `businessId` (`findById`, `populate`, cross-tenant worker scans). Fix each by adding `businessId` to the filter, or `{ skipTenantScope: true }` for genuine cross-tenant jobs, or `populate({ path, match: { businessId } })`.

| Location | Breaks |
| --- | --- |
| [billing.service.ts:592](../src/services/billing.service.ts#L592), [:634](../src/services/billing.service.ts#L634) `Plan.findById` | Selling membership / package / voucher / wallet top-up |
| billing.service.ts `CustomerPlan.updateOne({ _id: red.refId, ... })` in `applyBillEffects` and `cancelBill` | Package redemption & its reversal |
| [billing.service.ts:1356](../src/services/billing.service.ts#L1356) `.populate('billId')` | `GET /customers/:id/dues` once dues exist |
| [appointment.service.ts:343](../src/services/appointment.service.ts#L343) `Service.findById` | Walk-in appointments |
| [inventory.service.ts:46](../src/services/inventory.service.ts#L46), [:73](../src/services/inventory.service.ts#L73) `.populate('productId')` | Branch stock list, stock movements |
| [report.service.ts:73](../src/services/report.service.ts#L73), [:324](../src/services/report.service.ts#L324) `.populate('productId')` | Dashboard, inventory-valuation report |
| [lead.service.ts:113](../src/services/lead.service.ts#L113), [:125](../src/services/lead.service.ts#L125) `.populate(...)` | Lead list / detail |
| [whatsapp.service.ts:320](../src/services/whatsapp.service.ts#L320) `WaNumber.findById` | Every inbound webhook |
| [workers/jobs/whatsapp.worker.ts:24,35,60](../src/workers/jobs/whatsapp.worker.ts#L24) `findById` | Every WhatsApp send |
| [workers/jobs/automation.worker.ts:53](../src/workers/jobs/automation.worker.ts#L53) `Customer.findById` | Reminders / automations |
| [workers/jobs/dayend.worker.ts:110](../src/workers/jobs/dayend.worker.ts#L110) `Branch.findById` | Daily-summary rebuild |
| [workers/jobs/maintenance.worker.ts:26,54,94,135](../src/workers/jobs/maintenance.worker.ts#L26) global `updateMany`/`find` | Plan expiry, recurring expenses, stock alerts, ledger check |
| Same pattern, not yet hit by a test: appointment.service.ts:490-492, inventory.service.ts:457/761-762, staff.service.ts:489/583, whatsapp.service.ts:181-196/458/467, prepaid.service.ts:475, migration.service.ts:105 | Appointment detail, PO/transfer lists, leave/advance lists, inbox, campaigns, voucher lookup, imports |

Also: a **platform (Super Admin) token on tenant routes** hits this and returns 500 — add `requireKind('tenant')` to tenant routers.

#### 5. Parallel bills for the same customer fail with `VersionError`
- **Where:** `applyBillEffects` → `customer.save()` with `optimisticConcurrency: true` ([models/plugins/baseFields.plugin.ts](../src/models/plugins/baseFields.plugin.ts)).
- **Effect:** 50 parallel bills for one customer → 48 return 500 but all 50 are stored (shared "Walk-in" customer = real risk). Stats lose updates.
- **Fix:** update customer stats/wallet/dues with atomic `$inc` (`Customer.updateOne`) instead of `customer.save()`; wallet debit is already conditional — keep it inside the transaction (#2).
- **Tests:** concurrency.billing (2).

#### 6. Booking slot lock does not serialize bookings
- **Where:** [appointment.service.ts:262-267](../src/services/appointment.service.ts#L262-L267) counter `$inc` before `checkSlotClash`.
- **Effect:** same stylist double-booked in ~40 % of parallel runs (test is intentionally racy).
- **Fix:** works only inside a real transaction (#2) — the `$inc` on `<biz>:<staff>:slotlock:<date>` creates a write conflict that forces the second booking to retry and re-check.

#### 7. Bill edit always fails
- **Where:** [billing.service.ts:1208](../src/services/billing.service.ts#L1208) `bill.__v += 1` with optimistic concurrency → `VersionError` (500); with payments → 400 (`payments.businessDate required`, raw payments assigned at [line 1205](../src/services/billing.service.ts#L1205)).
- **Also missing:** reversal + re-application of effects (comment only at 1186-1188), `reason` validation (no Zod on `PATCH /bills/:id`), block editing cancelled bills, audit `before/after`.
- **Fix:** remove manual `__v` change; map payments like `createBill`; implement reverse → recompute → re-apply; add `validate({ body: editBillSchema })` on the route.
- **Tests:** billing.lifecycle (7).

#### 8. Payroll API cannot create or pay a run
- **Where:** [controllers/payroll.controller.ts:16](../src/controllers/payroll.controller.ts#L16) passes `req.body.month` (string) — service expects `{ month }` → 500. `markPaid` controller passes the string `'bank_transfer'` instead of `{ mode, date, staffIds }`.
- **Fix:** `createMonthlyRun(req.ctx, req.params.branchId, req.body)` and `markPaid(req.ctx, req.params.id, req.body)` + Zod validation (`createPayrollRunSchema` month regex accepts `2026-13` → also tighten to `0[1-9]|1[0-2]`).

#### 9. Account creation fails (onboarding, new branch, new manager)
- **Where:** [business.service.ts:124-125](../src/services/business.service.ts#L124-L125) and the branch/manager create paths write `accountId`; model [emailRegistry.model.ts](../src/models/emailRegistry.model.ts) requires `userId`.
- **Effect:** Super Admin cannot onboard any salon or add branches; owner cannot create managers; data half-created (see #2).
- **Fix:** write `userId` (or rename model field to `accountId` per Database Design).

### P1 — wrong money, security, broken rules

#### 10. Idempotency-Key ignored
- [billing.controller.ts:22](../src/controllers/billing.controller.ts#L22) never reads the header; Zod strips `idempotencyKey` from body. Pass `req.header('Idempotency-Key')` as 4th arg. Needs the unique index (#3) for parallel taps.

#### 11. Loyalty: client decides the discount, nothing is earned
- [billing.service.ts:394](../src/services/billing.service.ts#L394) uses `red.amountPaise` from the client. Compute `points × business.loyalty.redeemValuePaise`; enforce `loyalty.enabled` and `minRedeem`; post `earn` on paid bills (`earnPer100`); reverse `redeem`/`earn` on cancel.

#### 12. Membership discount applied to every line
- [billing.compute.ts:113-119](../src/services/billing.compute.ts#L113-L119) applies one bps to all lines (products, wallet top-ups: ₹10,000 credit for ₹8,000). Pass `serviceDiscountBps` + `productDiscountBps` and apply only to `service` / `product` lines. Check membership `validTill`, `frozen`, `branchScope`.

#### 13. Commission rules incomplete
- Slab type returns 0 ([billing.compute.ts:218-227](../src/services/billing.compute.ts#L218-L227)); product lines hard-code `productBps: 0` ([billing.service.ts:230](../src/services/billing.service.ts#L230)); staff default commission ignored (only `svc.commission` used, [billing.service.ts:202](../src/services/billing.service.ts#L202)); staff name not snapshotted ("Staff"); staff id not validated (other business accepted). Split rounding over-pays (see #42).

#### 14. Bill validation gaps
- **Cancel / refund:** cancel doesn't reverse customer visit stats or daily-summary collections; cancelling an `awaiting_approval` bill adds back stock that was never deducted (and a `rejected` bill can be cancelled); refund is allowed on an `awaiting_approval` bill. Only reverse effects that were applied (status `paid` / `partly_paid`).
- Overpayment accepted (payments > total + tips); branch-deactivated service (`branchPrices[].active=false`) still billable; `collectDues` settles old dues without the money being paid; consumable `costPaise` always 0 (should be `qty × purchasePrice / unitsPerPurchase`); per-manager `flags.maxDiscountBps` ignored in `checkDiscountLimit`; wallet check is read-then-write (rely on conditional update inside transaction).

#### 15. Approval flow
- `decide` controller treats any value except `'approve'` as reject → validate `decision` enum. Manager can approve bills of branches they don't manage → check `bill.branchId ∈ ctx.branchIds`.

#### 16. Branch scoping on `/:id` routes
- `GET /bills/:id`, `POST /bills/:id/cancel`, `PATCH /appointments/:id/status` (and similar `/:id` routes) check only `businessId`. Add a branch check for `manager` / `branch` roles.

#### 17. Cross-tenant references accepted
- Appointment with another business's `customerId` ([appointment.service.ts:193](../src/services/appointment.service.ts#L193)); manager adds staff to an unassigned branch; transfer to another business's branch; PO with another business's vendor; campaign with another business's number/template; manager assigned to another business's branch. Validate every referenced id against `businessId` (and branch access).

#### 18. Customer merge broken
- [customer.controller.ts:42-43](../src/controllers/customer.controller.ts#L42-L43) passes `(duplicateId, primaryId)` to a service expecting `(target, duplicate)`; `mergeCustomerSchema` strips `primaryId`. Add `primaryId` to the schema and pass `(primaryId, duplicateId)`.

#### 19. Password management missing
- No `POST /business/users/:id/password` or `POST /admin/users/:id/password`; `setPassword` checks `'superadmin'` but middleware sets `'super_admin'` ([auth.service.ts:323](../src/services/auth.service.ts#L323)).

#### 20. Suspended business / deactivated branch keep working
- `authenticate` checks only `user.status`; refresh doesn't check business/branch. Check both (cache in Redis).

#### 21. Forged refresh token logs out any user
- [auth.service.ts:87-90](../src/services/auth.service.ts#L87-L90) revokes all sessions when the key is missing — anyone sending `<victimId>.x.y` logs the victim out. Only revoke on reuse of a token that was really issued (keep a short-lived "used" set) — otherwise just 401.

#### 22. Day-end expected cash wrong
- [dayend.service.ts:183](../src/services/dayend.service.ts#L183), [:372](../src/services/dayend.service.ts#L372) `deletedAt: { $exists: false }` never matches (base plugin sets `deletedAt: null`) → **expenses never subtracted and expense list always empty**. Use `deletedAt: null`.
- Opening float ignores `branch.pettyCashFloatPaise`; refunds are read only from bills dated today (use `refunds.businessDate`); approve allowed on an `open` (never submitted) closure; reopen has no Zod (reason optional); invalid `:date` creates a closure; denominations not checked against counted cash.

#### 23. Day-end status codes
- `DAY_CLOSED` for expenses / re-submit returns 400 (spec 409).

#### 24. Appointment rules
- "Any available" picks the receptionist (filter to service-performing designations / `staff.serviceIds`); eligibility should use `staff.serviceIds` (Database Design) not only `service.eligibleStaffIds`; two lines of one appointment can overlap for the same stylist; manual status `completed → billed` allowed without a bill; staff block `end < start` accepted (no Zod on route); `PATCH /appointments/:id` (reschedule) and `GET /branches/:id/availability` not implemented; calendar change-scope bump is commented out ([appointment.service.ts:321](../src/services/appointment.service.ts#L321), [:418](../src/services/appointment.service.ts#L418)).

#### 25. Inventory
- Stock audit creation ignores `pool` (400) — pass `input.pool`; stock-audit counts route has no Zod (negative counts); PO over-receipt allowed; purchase movement `costPaise` is a fractional per-unit value (store integer total `round(qty × rate / unitsPerPurchase)`); vendor bill `paidPaise > amountPaise` accepted; transfer receive allows `receivedQty > qty` and short receipt without `mismatchReason`; receiving-branch manager can approve (should be sending branch); adjusting a retail-only product in the consumable pool allowed.

#### 26. Manager scope on PO / transfers
- Manager can raise a PO for an unassigned branch.

#### 27. WhatsApp webhook
- No signature verification ([aisensy.adapter.ts:41-42](../src/integrations/aisensy/aisensy.adapter.ts#L41-L42) always `true`); no dedupe by `providerMessageId`; no lead creation for unknown numbers; random `branchId` instead of `business.headBranchId`; no `STOP` opt-out; delivery-status callbacks not processed; low-rating alert not sent; plus #1 (401) and #4 (crash).

#### 28. WhatsApp inbox / campaigns / automations
- `POST /whatsapp/messages`: Zod strips `conversationId` from the body → 400 unless sent as query; window-closed returns 400 (spec 422 `WINDOW_CLOSED`); unapproved template usable; manager sees other branches' conversations; managers can create campaigns and edit automations (PRD: view); audience count ignores `doNotMessage` / `waOptIn` (`stats.excluded`); unknown automation key accepted; lead `lost` without `lostReason` accepted; lost lead convertible; branch login can create a lead for another branch.

#### 29. Prepaid plan rules
- Package redemption: no `validTill` / `branchScope` check (`PLAN_OUT_OF_SCOPE` never thrown); voucher redemption ignored in `createBill`; cancel doesn't restore loyalty; plan state errors return 400 (spec 422 `INVALID_TRANSITION`); wallet adjust below zero returns 400 (spec 422); wallet-top-up cancel doesn't reverse credit.

#### 30. Reports
- [report.controller.ts:24-25](../src/controllers/report.controller.ts#L24-L25) sends `from`/`to` but service reads `fromDate`/`toDate` → date range ignored. Manager can query any `branchId` and sees all branches without a filter; GSTR-1 runs for GST-off businesses.

#### 31. Dashboard
- Crashes (#4) and counts appointments with a non-existent `date` field (use `businessDate`); manager sees whole-business numbers.

#### 32. Hardening
- CORS `origin: true` ([app.ts:34](../src/app.ts#L34)) → use `env.APP_ORIGINS`; JSON limit 10 MB (spec 1 MB); `q[$ne]=x` query → 500 (sanitize / coerce query to string); unknown body keys accepted (use `.strict()` on Zod objects); letters-only phone accepted (`normalizePhone` returns `"+"`); `/uploads/presign` returns no `url` and accepts any content type; `/changes` returns 403 for managers (#1) and has no scope authorization; append-only audit log not enforced (add pre-hooks rejecting update/delete on `AuditLog`).

### P2 — role matrix, validation and status codes

#### 33. Role matrix vs PRD §3
- Managers can create plans (PRD: owner only); managers cannot mark attendance without `markAttendance` flag (that flag is for branch logins); managers cannot view the audit log for their branches; branch login can request leave (PRD: view only); managers can create campaigns / edit automations; stock audit approve is owner-only (Backend SRS: owner + manager).

#### 34. Owner settings & managers
- `PATCH /business/settings` with one discount limit fails — partial object replaces the sub-document (merge nested objects); `PATCH /business/branch-logins/:id` expects `{ flags: { markAttendance } }`, spec body `{ markAttendance }` → 500; manager assigned to another business's branch is accepted. `PATCH /business/managers/:id` and branch-login flags responses **include `passwordHash`** — add a `toJSON` transform on the User schema.

#### 35. Catalogue / customer validation
- Category with services can be deleted (should block); manager branch price change not audited and no assigned-branch check; negative branch price accepted (no Zod on `/services/:id/branch-prices`); invalid DOB `2026-02-30` accepted. GSTIN-required-when-GST-on can only be verified after #9 (onboarding currently fails for every input).

#### 36. Appointment endpoints missing
- See #24 (reschedule, availability).

#### 37. Auth polish
- Login rate limit 30 / 15 min (spec 5 / min, Redis store); refresh token not an httpOnly cookie; refresh response field `newRefreshToken` (spec `refreshToken`).

#### 38. Payroll statutory
- PF/ESI/PT applied when only the staff flag is on — must also require `business.payroll.<x>.enabled`; PF ignores `wageCeilingPaise` and `employeePct`; PT ignores slabs.

#### 39. Payroll lock
- Stale check compares bills with `run.createdAt` → after regenerating, lock fails forever (store `draftedAt` and update it on regenerate); stale returns 400 (spec 409 `PAYROLL_STALE`); bills in a locked payroll month can still be cancelled/edited.

#### 40. Staff / attendance
- Attendance default date uses UTC (`toISOString().slice(0,10)` in [staff.controller.ts:86](../src/controllers/staff.controller.ts#L86)) — use `getBusinessDate()`; overtime uses fixed 9 h instead of the rostered shift; clock-out before clock-in accepted; staff of another branch/business accepted in attendance; leave `to < from` accepted; roster `start > end` accepted; billed-by list returns all staff (filter `designation: 'receptionist'`); staff create allowed in another business's branch.

#### 41. Background jobs (after #4)
- Automation ignores the `Automation.enabled` switch and `waOptIn`; quiet hours use server local time (`now.getHours()`) — on UTC servers marketing goes out at 22:30 IST (verified with `TZ=UTC`); day-end report uses total revenue as "expected cash", never marks "Not closed", sends to `User.phone` instead of `business.ownerWhatsappPhone`; stock alerts sent to `userId = businessId` (nobody); ledger-check sign logic double-negates debits; recurring expense uses server-local day.

#### 42. Money helpers
- [money.ts `distributeProRata`](../src/utils/money.ts) gives the remainder to the **last** item, which can be negative (e.g. `distributeProRata(3,[1,1,0]) → [2,2,-1]`) — use largest-remainder allocation; 3-way commission split pays 1 paise more than earned (allocate split remainder, don't round each share); `rupeesToPaise(1.005)` → 100 (use string/decimal rounding).

#### 43. Phone normalisation
- [masking.ts `normalizePhone`](../src/utils/masking.ts) turns `"12345"` into `"+12345"` and letters into `"+"` — validate 10-digit Indian mobile and reject otherwise.

---

## Part 2 — Notes

- **Racy test:** `Appointments — concurrency › 5 parallel bookings of the SAME stylist` fails only in some runs while #2/#6 are open. It should pass every time once fixed.
- **Payroll tests** create drafts through the service because the HTTP create endpoint is broken (#8); one dedicated API test covers the endpoint.
- **Branch day-end submit** is tested at service level because HTTP is blocked by #1.
- **Timezone:** the suite runs in your machine's timezone (IST). Run `TZ=UTC npx jest tests/integration/workers` to reproduce server behaviour for #41.
- **Docs out of date:** `README.md` and `REQUIREMENTS_CHECKLIST.md` claim 9 passing suites and point to `packages/...` paths that don't exist. Update after fixes.
- **Not covered yet:** data-migration import jobs, PDF content, real AiSensy / S3 calls (both are mocks in `src/integrations`).

---

## Part 3 — All 214 failing tests


### tests/integration/access-control.test.ts — 17 failing

| # | Area | Test | Expected → Actual |
| ---: | --- | --- | --- |
| 1 | Routing — role middleware must not leak across routers | branch login can view its own stock (PRD matrix: Inventory = Branch) | expected 200 / got 403 |
| 2 | Routing — role middleware must not leak across routers | branch login can add an expense (PRD matrix: Expenses = Add) | expected 201 / got 403 |
| 3 | Routing — role middleware must not leak across routers | branch login can open its day-end closure (PRD matrix: Day-end = Submit) | expected 200 / got 403 |
| 4 | Routing — role middleware must not leak across routers | branch login can use the WhatsApp inbox (PRD matrix: Full own branch) | expected 200 / got 403 |
| 5 | Routing — role middleware must not leak across routers | branch login can read its notifications | expected 200 / got 403 |
| 6 | Routing — role middleware must not leak across routers | manager can read notifications and poll /changes | expected 200 / got 403 |
| 7 | Routing — role middleware must not leak across routers | manager WITHOUT viewPayroll can still use inventory and reports | expected 200 / got 403 |
| 8 | Routing — role middleware must not leak across routers | public AiSensy webhook is reachable without a bearer token | expected not 401 / got ? |
| 9 | Branch scoping (manager / branch login) | branch login A cannot open a bill that belongs to branch B by id | expected 200 / got [403, 404] |
| 10 | Branch scoping (manager / branch login) | manager of A cannot cancel a bill of branch B | expected 200 / got [403, 404] |
| 11 | Branch scoping (manager / branch login) | branch login A cannot change the status of a branch B appointment | expected 200 / got [403, 404] |
| 12 | Tenant isolation (Backend SRS §12: other business -> 404) | cannot book an appointment for another business's customer | expected 201 / got [404, 422] |
| 13 | Tenant isolation (Backend SRS §12: other business -> 404) | invalid ObjectId in URL -> 400, not 500 | expected 400 / got 500 |
| 14 | Role permission matrix (PRD §3) | manager cannot create prepaid plans (write O) | expected 403 / got 201 |
| 15 | Role permission matrix (PRD §3) | manager can view the audit log for assigned branches | expected 200 / got 403 |
| 16 | Role permission matrix (PRD §3) | manager can mark attendance without any extra flag | expected 403 / got [200, 201] |
| 17 | Role permission matrix (PRD §3) | manager without manageStaff cannot add staff to a branch they do not manage | expected 201 / got [403, 404] |

### tests/integration/admin-catalogue-customer.test.ts — 16 failing

| # | Area | Test | Expected → Actual |
| ---: | --- | --- | --- |
| 18 | Super Admin onboarding (PRD §3, SRS 5.1) | creates business + owner + head branch + branch login in one call; owner can log in | expected 201 / got 400 |
| 19 | Super Admin onboarding (PRD §3, SRS 5.1) | duplicate owner email across businesses -> 409 DUPLICATE_EMAIL and nothing half-created | expected 409 / got 400 |
| 20 | Super Admin onboarding (PRD §3, SRS 5.1) | a failed onboarding leaves no half-created business, branch or users behind (transaction) | expected ? / got 03.313Z} |
| 21 | Super Admin onboarding (PRD §3, SRS 5.1) | super admin adds a second branch with its own login; duplicate branch code rejected | expected 201 / got 400 |
| 22 | Super Admin onboarding (PRD §3, SRS 5.1) | head branch cannot be deactivated; another branch can, and its login stops working | expected 200 / got 500 |
| 23 | Super Admin onboarding (PRD §3, SRS 5.1) | owner raises a branch deletion request; super admin approves it | expected 201 / got 400 |
| 24 | Owner: settings and managers | owner updates discount limits; branch limit then applies to bills | expected 200 / got 400 |
| 25 | Owner: settings and managers | owner creates a manager for selected branches; duplicate email -> 409 | expected 201 / got 400 |
| 26 | Owner: settings and managers | cannot assign a manager to a branch of another business | expected 400 / got [403, 404, 422] |
| 27 | Owner: settings and managers | owner toggles markAttendance on a branch login | expected 200 / got 500 |
| 28 | Catalogue rules (PRD §4) | a category that still has services cannot be deleted (Database Design: Block) | expected 200 / got [409, 422] |
| 29 | Catalogue rules (PRD §4) | manager with editBranchPrices sets the price for an assigned branch; change is audited | expected ? / got null |
| 30 | Catalogue rules (PRD §4) | manager cannot set the price for a branch they do not manage | expected 403 / got 200 |
| 31 | Catalogue rules (PRD §4) | branch price must be a non-negative integer | expected 400 / got 200 |
| 32 | Customer CRM (PRD §6) | invalid date of birth (2026-02-30) -> 400 | expected 400 / got 201 |
| 33 | Customer CRM (PRD §6) | merge moves the duplicate's bills to the primary and retires the duplicate | expected 200 / got 404 |

### tests/integration/appointments.test.ts — 8 failing

| # | Area | Test | Expected → Actual |
| ---: | --- | --- | --- |
| 34 | Appointments — slot rules (BR-04, per-staff clashes) | EDGE: two lines in ONE appointment overlapping for the same stylist -> clash | expected 409 / got 201 |
| 35 | Appointments — slot rules (BR-04, per-staff clashes) | staff block with end before start -> 400 | expected 400 / got 201 |
| 36 | Appointments — slot rules (BR-04, per-staff clashes) | service eligibility via staff.serviceIds (Database Design: "the only source") -> 409 | expected 409 / got 201 |
| 37 | Appointments — slot rules (BR-04, per-staff clashes) | "Any available" picks a free stylist, never the receptionist | expected "6ae1df33f9607848d2b53d32" / got "6ae1df33f9607848d2b53d2e" |
| 38 | Appointments — status lifecycle and walk-ins | a "billed" status cannot be set by hand without a bill | expected 422 / got 200 |
| 39 | Appointments — status lifecycle and walk-ins | walk-in creates an appointment starting now with the first free stylist | expected 201 / got 500 |
| 40 | Appointments — status lifecycle and walk-ins | reschedule endpoint PATCH /appointments/:id re-checks clashes (Backend SRS §6) | expected 409 / got 403 |
| 41 | Appointments — status lifecycle and walk-ins | availability endpoint lists free slots (Backend SRS §6) | expected 200 / got 403 |

### tests/integration/auth.admin.test.ts — 4 failing

| # | Area | Test | Expected → Actual |
| ---: | --- | --- | --- |
| 42 | Auth — Super Admin and password management | platform token cannot use tenant routes (requireKind tenant) | expected 403 / got 500 |
| 43 | Auth — Super Admin and password management | owner can set a manager password: POST /business/users/:id/password (Backend SRS §2) | expected 404 / got [200, 204] |
| 44 | Auth — Super Admin and password management | super admin can reset any password: POST /admin/users/:id/password | expected 403 / got [200, 204] |
| 45 | Auth — Super Admin and password management | AuthService.setPassword works for the super admin context the middleware actually builds | AppError: Permission denied to set user password] |

### tests/integration/auth.login.test.ts — 3 failing

| # | Area | Test | Expected → Actual |
| ---: | --- | --- | --- |
| 46 | Auth — login (Backend SRS §2, BR-09) | suspending a business also blocks already-issued access tokens | expected 200 / got [401, 403] |
| 47 | Auth — login (Backend SRS §2, BR-09) | deactivated branch login cannot keep using an existing access token | expected 200 / got [401, 403] |
| 48 | Auth — login (Backend SRS §2, BR-09) | refresh token should be an httpOnly cookie on /auth (Backend SRS §2 step 5) | expected true / got false |

### tests/integration/auth.ratelimit.test.ts — 1 failing

| # | Area | Test | Expected → Actual |
| ---: | --- | --- | --- |
| 49 | Auth — login rate limit (Backend SRS §12: 5 attempts / min / IP) | 6th login attempt within a minute from one IP is rejected with 429 RATE_LIMITED | expected 429 / got 401 |

### tests/integration/auth.session.test.ts — 2 failing

| # | Area | Test | Expected → Actual |
| ---: | --- | --- | --- |
| 50 | Auth — tokens and sessions | refresh response uses the documented field name `refreshToken` | expected ? / got undefined |
| 51 | Auth — tokens and sessions | SECURITY: a forged refresh token naming another user must NOT log that user out | expected 200 / got 401 |

### tests/integration/billing.atomicity.test.ts — 3 failing

| # | Area | Test | Expected → Actual |
| ---: | --- | --- | --- |
| 52 | Billing atomicity (transactions) | a bill that fails mid-save leaves no bill, no stock change and no used invoice number | expected 0 / got 1 |
| 53 | Billing atomicity (transactions) | a failed request never returns 500 for a business-rule problem | expected < 500 / got 500 |
| 54 | Billing atomicity (transactions) | retrying after a 500 must not create a duplicate paid bill | expected <= 1 / got 2 |

### tests/integration/billing.core.test.ts — 15 failing

| # | Area | Test | Expected → Actual |
| ---: | --- | --- | --- |
| 55 | Billing — create bill (PRD §7, Backend SRS §8) | snapshots the staff name on the service line (Database Design §1 "Snapshot names") | expected "Sam Stylist" / got "Staff" |
| 56 | Billing — create bill (PRD §7, Backend SRS §8) | falls back to the staff member's default commission when the service has none | expected 10000 / got 0 |
| 57 | Billing — create bill (PRD §7, Backend SRS §8) | product sales commission uses the staff member's productBps (5%) | expected 2500 / got 0 |
| 58 | Billing — create bill (PRD §7, Backend SRS §8) | rejects a staff member from another business on a bill line | expected 201 / got [404, 422] |
| 59 | Billing — create bill (PRD §7, Backend SRS §8) | a service deactivated for this branch cannot be billed there | expected 201 / got [404, 422] |
| 60 | Billing — create bill (PRD §7, Backend SRS §8) | EDGE: payments larger than the bill are rejected (payments must equal total + tips - due) | expected 201 / got [400, 422] |
| 61 | Billing — create bill (PRD §7, Backend SRS §8) | Idempotency-Key header: same key twice returns the same bill, not a duplicate | expected "6ae1defddfc5e0f0a48378b2" / got "6ae1defedfc5e0f0a48378ce" |
| 62 | Billing — side effects of a paid bill | consumable movement records a cost (PRD §15 service margin needs consumable cost) | expected 15000 / got 0 |
| 63 | Billing — side effects of a paid bill | earns loyalty points when loyalty is enabled (1 point per ₹100) | expected 11 / got 0 |
| 64 | Billing — discounts and approvals | per-manager maxDiscountBps override (5%) is enforced | expected "awaiting_approval" / got "paid" |
| 65 | Billing — discounts and approvals | a manager cannot approve a bill of a branch they do not manage | expected 200 / got [403, 404] |
| 66 | Billing — discounts and approvals | an unrecognised decision value must not silently reject the bill | expected 400 / got 200 |
| 67 | Billing — dues (BR-03) | EDGE: due receipt larger than total dues is rejected (no unallocated money) | expected 201 / got [400, 422] |
| 68 | Billing — dues (BR-03) | EDGE: collecting an old due inside a new bill requires the money to be paid | expected "open" / got "settled" |
| 69 | Billing — dues (BR-03) | GET /customers/:id/dues lists open dues | expected 200 / got 500 |

### tests/integration/billing.lifecycle.test.ts — 12 failing

| # | Area | Test | Expected → Actual |
| ---: | --- | --- | --- |
| 70 | Bill cancel (PRD §7: never deletes, reverses everything) | cancel reverses customer visit stats | expected 0 / got 1 |
| 71 | Bill cancel (PRD §7: never deletes, reverses everything) | cancel removes the bill's collections from the daily summary | expected 0 / got 413000 |
| 72 | Bill cancel (PRD §7: never deletes, reverses everything) | EDGE: cancelling a bill still awaiting approval must not add stock that was never deducted | expected 10 / got 12 |
| 73 | Bill cancel (PRD §7: never deletes, reverses everything) | EDGE: cancelling a rejected bill is not allowed (nothing to reverse) | expected 422 / got 200 |
| 74 | Bill refund | EDGE: cannot refund a bill that is still awaiting approval | expected 422 / got 200 |
| 75 | Bill edit (PRD §7: new version, reason mandatory) | edit creates version 2, stores a BillVersion snapshot and keeps the invoice number | expected 200 / got 400 |
| 76 | Bill edit (PRD §7: new version, reason mandatory) | reason is mandatory for an edit | expected 400 / got 500 |
| 77 | Bill edit (PRD §7: new version, reason mandatory) | edit that only changes lines (payments untouched) succeeds | expected 200 / got 500 |
| 78 | Bill edit (PRD §7: new version, reason mandatory) | a body without lines is a 400, not a 500 | expected 400 / got 500 |
| 79 | Bill edit (PRD §7: new version, reason mandatory) | edit reverses the old version's stock and applies the new one (2 bottles + colour -> 1 bottle) | expected 9 / got 8 |
| 80 | Bill edit (PRD §7: new version, reason mandatory) | cannot edit a cancelled bill | expected 422 / got 400 |
| 81 | Bill edit (PRD §7: new version, reason mandatory) | edit is audited with before/after | expected ? / got null |

### tests/integration/concurrency.billing.test.ts — 11 failing

| # | Area | Test | Expected → Actual |
| ---: | --- | --- | --- |
| 82 | Concurrency — billing (Backend SRS §12 concurrency gate) | 50 parallel bill saves on one branch -> 50 unique, gap-free invoice numbers | expected 50 / got 1 |
| 83 | Concurrency — billing (Backend SRS §12 concurrency gate) | customer stats stay correct under 20 parallel bills (no lost updates) | expected 20 / got 1 |
| 84 | Concurrency — billing (Backend SRS §12 concurrency gate) | two simultaneous bills each spending the full wallet: exactly one succeeds, wallet never negative, no orphan bill | expected 1 / got 2 |
| 85 | Concurrency — billing (Backend SRS §12 concurrency gate) | last package session redeemed twice at the same time: only one redemption succeeds | expected 1 / got 0 |
| 86 | Concurrency — billing (Backend SRS §12 concurrency gate) | same Idempotency-Key fired twice in parallel creates one bill | expected 1 / got 2 |
| 87 | Database integrity — unique indexes (Database Design §13 index list) | the app builds its unique indexes on startup (bills: businessId+invoiceNo) | expected true / got false |
| 88 | Database integrity — unique indexes (Database Design §13 index list) | the app builds its unique indexes on startup (customers: businessId+phone) | expected true / got false |
| 89 | Database integrity — unique indexes (Database Design §13 index list) | DB rejects a second customer with the same phone in the same business | see test |
| 90 | Database integrity — unique indexes (Database Design §13 index list) | DB rejects a duplicate invoice number in the same business | see test |
| 91 | Database integrity — unique indexes (Database Design §13 index list) | DB rejects a second owner for the same business | see test |
| 92 | Database integrity — unique indexes (Database Design §13 index list) | parallel customer creation with the same phone yields exactly one customer | expected 1 / got 2 |

### tests/integration/dayend.test.ts — 10 failing

| # | Area | Test | Expected → Actual |
| ---: | --- | --- | --- |
| 93 | Day-end — expected figures (PRD §14 formula) | opening cash = the branch's petty-cash float (₹5,000) when no separate entry exists | expected 500000 / got 0 |
| 94 | Day-end — expected figures (PRD §14 formula) | cash expenses paid from the till reduce expected cash | expected 20000 / got 0 |
| 95 | Day-end — expected figures (PRD §14 formula) | EDGE: a cash refund today on YESTERDAY's bill reduces TODAY's expected cash | expected 18000 / got 0 |
| 96 | Day-end — submit, approve, lock, reopen | denominations must add up to the counted cash | expected 400 / got 200 |
| 97 | Day-end — submit, approve, lock, reopen | cannot approve a day that was never submitted | expected 200 / got [404, 422] |
| 98 | Day-end — submit, approve, lock, reopen | approve locks the day: new bills 409 DAY_CLOSED, new expenses blocked | expected 409 / got 400 |
| 99 | Day-end — submit, approve, lock, reopen | approved day cannot be re-submitted | expected 409 / got 400 |
| 100 | Day-end — submit, approve, lock, reopen | reopen without a reason -> 400 | expected 400 / got 200 |
| 101 | Day-end — submit, approve, lock, reopen | invalid date in URL -> 400 | expected 400 / got 200 |
| 102 | Expenses and petty cash | creates and lists an expense with business date | expected "Oct rent" / got "[]" |

### tests/integration/inventory.test.ts — 15 failing

| # | Area | Test | Expected → Actual |
| ---: | --- | --- | --- |
| 103 | Inventory — stock and adjustments (PRD §10) | lists branch stock by pool | expected 200 / got 500 |
| 104 | Inventory — stock and adjustments (PRD §10) | cannot adjust a retail-only product in the consumable pool | expected 201 / got [400, 422] |
| 105 | Inventory — purchase orders | EDGE: cannot receive more than ordered | expected 200 / got [400, 422] |
| 106 | Inventory — purchase orders | purchase movement cost is an integer total in paise (Database Design: "rounded once") | expected 50000 / got 500 |
| 107 | Inventory — purchase orders | manager cannot raise a PO for a branch they do not manage | expected 201 / got [403, 404] |
| 108 | Inventory — purchase orders | PO with another business's vendor or product is rejected | expected 201 / got [404, 422] |
| 109 | Inventory — purchase orders | EDGE: vendor bill paid amount cannot exceed bill amount | expected 200 / got [400, 422] |
| 110 | Inventory — inter-branch transfers | EDGE: receiving MORE than dispatched is rejected | expected 200 / got [400, 422] |
| 111 | Inventory — inter-branch transfers | EDGE: a short receipt without a mismatch reason is rejected | expected 200 / got [400, 422] |
| 112 | Inventory — inter-branch transfers | cannot transfer to a branch of another business | expected 201 / got [403, 404] |
| 113 | Inventory — inter-branch transfers | manager of the RECEIVING branch only cannot approve (PRD: approver = sending branch) | expected 403 / got 200 |
| 114 | Inventory — stock audit | count sheet -> variance -> owner approval posts audit movements | expected 201 / got 400 |
| 115 | Inventory — stock audit | negative counted quantity -> 400 | expected 400 / got 500 |
| 116 | Inventory — stock audit | approving twice does not post the variance twice | expected 7 / got 10 |
| 117 | Inventory — stock audit | manager may approve a stock audit (Backend SRS: approve O, M) | expected 200 / got 403 |

### tests/integration/leads-whatsapp.test.ts — 22 failing

| # | Area | Test | Expected → Actual |
| ---: | --- | --- | --- |
| 118 | Leads (PRD §11) | branch login cannot add a lead to another branch | expected 403 / got 201 |
| 119 | Leads (PRD §11) | marking a lead Lost requires a reason | expected 400 / got 200 |
| 120 | Leads (PRD §11) | a lost lead cannot be converted | expected 200 / got [409, 422] |
| 121 | Leads (PRD §11) | branch login B cannot read branch A's leads | expected 200 / got 500 |
| 122 | WhatsApp inbox (PRD §12) | conversationId in the JSON body works (not only in the query string) | expected 201 / got 400 |
| 123 | WhatsApp inbox (PRD §12) | free-form text outside the 24 h window -> 422 WINDOW_CLOSED; template still allowed | expected 422 / got 400 |
| 124 | WhatsApp inbox (PRD §12) | cannot send with a template that is not approved | expected 201 / got [404, 422] |
| 125 | WhatsApp inbox (PRD §12) | manager of branch A does not see branch B conversations | TypeError: list.every is not a function |
| 126 | WhatsApp webhook processing (Backend SRS §9) | HTTP: webhook with a bad signature is rejected (401/403) | expected not "UNAUTHENTICATED" / got ? |
| 127 | WhatsApp webhook processing (Backend SRS §9) | HTTP: unknown numberId returns 200 quickly and stores nothing | expected 200 / got 401 |
| 128 | WhatsApp webhook processing (Backend SRS §9) | inbound message from a known customer opens a conversation on the customer | AppError: Tenant query for findOne missing businessId filter |
| 129 | WhatsApp webhook processing (Backend SRS §9) | inbound message from an unknown number creates a WhatsApp lead (PRD §11) | AppError: Tenant query for findOne missing businessId filter |
| 130 | WhatsApp webhook processing (Backend SRS §9) | new conversations land in the head branch inbox, not a random branch id | AppError: Tenant query for findOne missing businessId filter |
| 131 | WhatsApp webhook processing (Backend SRS §9) | duplicate delivery of the same provider message is stored once | AppError: Tenant query for findOne missing businessId filter |
| 132 | WhatsApp webhook processing (Backend SRS §9) | inbound "STOP" opts the customer out (waOptIn=false, doNotMessage=true) | AppError: Tenant query for findOne missing businessId filter |
| 133 | WhatsApp webhook processing (Backend SRS §9) | a 1–5 reply after a bill becomes feedback; low rating alerts the owner | AppError: Tenant query for findOne missing businessId filter |
| 134 | WhatsApp webhook processing (Backend SRS §9) | delivery status callback updates the outbound message status | AppError: Tenant query for findOne missing businessId filter |
| 135 | Campaigns and automations (PRD §12–13) | manager can only VIEW campaigns (PRD matrix) | expected 403 / got 201 |
| 136 | Campaigns and automations (PRD §12–13) | opted-out and do-not-message customers are excluded from the audience count | expected 2 / got 0 |
| 137 | Campaigns and automations (PRD §12–13) | cannot use another business's WhatsApp number or template | expected 201 / got [404, 422] |
| 138 | Campaigns and automations (PRD §12–13) | owner toggles an automation; manager can only read | expected 403 / got 200 |
| 139 | Campaigns and automations (PRD §12–13) | unknown automation key -> 400/404 | expected 200 / got [400, 404] |

### tests/integration/prepaid.test.ts — 19 failing

| # | Area | Test | Expected → Actual |
| ---: | --- | --- | --- |
| 140 | Selling prepaid instruments on a bill (PRD §8) | selling a membership creates an active customer plan valid for N days | expected 201 / got 500 |
| 141 | Selling prepaid instruments on a bill (PRD §8) | selling a package creates sessions with per-session value | expected 201 / got 500 |
| 142 | Selling prepaid instruments on a bill (PRD §8) | wallet offer: pay ₹10,000 get ₹12,000 credit (topup + bonus ledger rows) | expected 201 / got 500 |
| 143 | Selling prepaid instruments on a bill (PRD §8) | gift voucher sale issues a unique voucher code that can be looked up | expected 201 / got 500 |
| 144 | Selling prepaid instruments on a bill (PRD §8) | cancelling a bill that sold an unused package cancels the package | expected "cancelled" / got undefined |
| 145 | Selling prepaid instruments on a bill (PRD §8) | cancelling a bill that sold a wallet top-up removes the credit (or is blocked if spent) | expected 422 / got 500 |
| 146 | Redeeming prepaid instruments | package redemption zeroes the line and consumes one session | expected 201 / got 500 |
| 147 | Redeeming prepaid instruments | commission on a package session is paid on the per-session value (₹800 @10% = ₹80) | expected 8000 / got undefined |
| 148 | Redeeming prepaid instruments | EDGE: expired package (validTill in the past) cannot be redeemed | expected 422 / got 500 |
| 149 | Redeeming prepaid instruments | EDGE: package restricted to branch B cannot be used in branch A (PLAN_OUT_OF_SCOPE) | expected 422 / got 500 |
| 150 | Redeeming prepaid instruments | EDGE: expired membership gives no discount | expected true / got false |
| 151 | Redeeming prepaid instruments | SECURITY: loyalty redemption value is computed by the server, not trusted from the client | expected 90000 / got 0 |
| 152 | Redeeming prepaid instruments | loyalty redemption below the minimum is rejected | expected 422 / got 201 |
| 153 | Redeeming prepaid instruments | loyalty redemption when the business has loyalty switched off is rejected | expected 422 / got 201 |
| 154 | Redeeming prepaid instruments | gift voucher redemption reduces the bill and marks the voucher used (redeemable once) | expected 50000 / got 100000 |
| 155 | Redeeming prepaid instruments | cancelling a bill restores the redeemed package session | expected 201 / got 500 |
| 156 | Redeeming prepaid instruments | cancelling a bill restores redeemed loyalty points | expected 100 / got 50 |
| 157 | Customer plan management and wallet adjustments | invalid state transitions are 422 INVALID_TRANSITION (SRS error table) | expected 422 / got 400 |
| 158 | Customer plan management and wallet adjustments | wallet cannot be adjusted below zero | expected 422 / got 400 |

### tests/integration/reports-system.test.ts — 17 failing

| # | Area | Test | Expected → Actual |
| ---: | --- | --- | --- |
| 159 | Reports (PRD §15) | owner can run report "inventory-valuation" without error | expected 200 / got 500 |
| 160 | Reports (PRD §15) | date range is honoured: a range in the past returns no sales | expected not /100000\|250000/ / got 1}]" |
| 161 | Reports (PRD §15) | manager cannot run a report for a branch they do not manage | expected 403 / got 200 |
| 162 | Reports (PRD §15) | manager without a branch filter sees only assigned branches | expected not "6ae1df16572ec9e7c230e2ab" / got 250000}]" |
| 163 | Reports (PRD §15) | GSTR-1 is not available for a GST-off business | expected 200 / got [400, 404, 422] |
| 164 | Owner dashboard (PRD §15) | owner dashboard loads with today's sales across branches | expected 200 / got 500 |
| 165 | Owner dashboard (PRD §15) | dashboard counts today's appointments | expected 200 / got 500 |
| 166 | Owner dashboard (PRD §15) | manager dashboard is limited to assigned branches | expected 200 / got 500 |
| 167 | Audit log (PRD §16: append-only) | audit rows cannot be modified or deleted through the model (append-only) | see test |
| 168 | Notifications and change polling (Backend SRS §9) | booking an appointment bumps the calendar scope | expected 0}}" / got ? |
| 169 | Notifications and change polling (Backend SRS §9) | manager can poll own branch scopes but not another branch's | expected 200 / got 403 |
| 170 | Notifications and change polling (Backend SRS §9) | upload presign returns a URL and key; rejects disallowed types | expected ? / got undefined |
| 171 | Health and hardening (Backend SRS §12) | CORS only allows configured app origins | expected //evil.example.com" / got ? |
| 172 | Health and hardening (Backend SRS §12) | JSON body larger than 1 MB is rejected (413) | expected 413 / got 201 |
| 173 | Health and hardening (Backend SRS §12) | Mongo operator injection in query is neutralised | expected < 500 / got 500 |
| 174 | Health and hardening (Backend SRS §12) | unknown keys in a body are rejected (Backend SRS §2: "unknown keys rejected") | expected 400 / got 201 |
| 175 | Health and hardening (Backend SRS §12) | invalid customer phone (letters) -> 400 | expected 400 / got 201 |

### tests/integration/staff-payroll.test.ts — 17 failing

| # | Area | Test | Expected → Actual |
| ---: | --- | --- | --- |
| 176 | Staff records | cannot create staff in another business's branch | expected 201 / got [403, 404] |
| 177 | Staff records | billed-by list shows only active receptionists of the branch | see test |
| 178 | Staff records | roster with start after end -> 400 | expected 400 / got 200 |
| 179 | Attendance | cannot mark attendance for staff of another branch through this branch | expected 200 / got [403, 404, 422] |
| 180 | Attendance | cannot mark attendance for another business's staff | expected 200 / got [403, 404, 422] |
| 181 | Attendance | clock-out before clock-in -> 400 | expected 400 / got 200 |
| 182 | Attendance | overtime is measured beyond the ROSTERED shift (PRD §9), not a fixed 9 hours | expected 120 / got 0 |
| 183 | Attendance | EDGE: with no date given, attendance at 01:30 IST goes to the IST day, not the UTC day | expected 200 / got 401 |
| 184 | Leaves and advances | leave with to < from -> 400 | expected 400 / got 201 |
| 185 | Leaves and advances | branch login can only view leave, not request it (PRD: Roster and leave = View) | expected 403 / got 201 |
| 186 | Payroll (PRD §9) | API: POST /branches/:id/payroll-runs creates a draft run | expected 201 / got 500 |
| 187 | Payroll (PRD §9) | PF/ESI/PT are OFF by default even if a staff flag is set, unless the business switches them on | expected 0 / got 360000 |
| 188 | Payroll (PRD §9) | PF uses the business wage ceiling (12% of ₹15,000 = ₹1,800) | expected 180000 / got 360000 |
| 189 | Payroll (PRD §9) | a bill added after the draft makes lock fail with 409 PAYROLL_STALE | expected 409 / got 400 |
| 190 | Payroll (PRD §9) | after regenerating the stale draft, lock succeeds | expected 200 / got 400 |
| 191 | Payroll (PRD §9) | bills in a locked payroll month cannot be cancelled (Database Design concurrency rules) | expected 200 / got [409, 422] |
| 192 | Payroll (PRD §9) | invalid month string -> 400 | expected 400 / got 500 |

### tests/integration/workers.test.ts — 13 failing

| # | Area | Test | Expected → Actual |
| ---: | --- | --- | --- |
| 193 | Worker — whatsapp-send | sends a queued message and marks it sent with a provider id | AppError: Tenant query for findOne missing businessId filter |
| 194 | Worker — automation-scan (PRD §13) | queues a 24 h reminder once, even if the scan runs twice | AppError: Tenant query for findOne missing businessId filter |
| 195 | Worker — automation-scan (PRD §13) | does not send a reminder when the owner switched the automation OFF | AppError: Tenant query for findOne missing businessId filter |
| 196 | Worker — automation-scan (PRD §13) | skips customers marked do-not-message | AppError: Tenant query for findOne missing businessId filter |
| 197 | Worker — automation-scan (PRD §13) | marketing messages skip customers without WhatsApp opt-in | expected 0 / got 1 |
| 198 | Worker — day-end-report (PRD §14) | sends the report to the business owner WhatsApp number | expected ? / got null |
| 199 | Worker — day-end-report (PRD §14) | a branch that has not closed is reported as "Not closed" with system figures | expected /not.?closed/i / got "[]" |
| 200 | Worker — day-end-report (PRD §14) | report cash figure is CASH collections, not total revenue across all modes | expected 0 / got 118000 |
| 201 | Worker — maintenance jobs (Backend SRS §10) | plan-expiry marks past-validity plans expired (all businesses) | AppError: Tenant query for updateMany missing businessId filter |
| 202 | Worker — maintenance jobs (Backend SRS §10) | ledger-check runs cleanly when wallets match their ledgers | AppError: Tenant query for find missing businessId filter] |
| 203 | Worker — maintenance jobs (Backend SRS §10) | recurring-expense posts the month's rent once on its day | AppError: Tenant query for find missing businessId filter |
| 204 | Worker — maintenance jobs (Backend SRS §10) | stock-alerts notifies a real user (owner/manager) when stock is at or below reorder level | AppError: Tenant query for find missing businessId filter |
| 205 | Worker — maintenance jobs (Backend SRS §10) | daily-summary rebuild matches the live summary | AppError: Tenant query for findOne missing businessId filter |

### tests/unit/billing.compute.test.ts — 5 failing

| # | Area | Test | Expected → Actual |
| ---: | --- | --- | --- |
| 206 | computeBill — discounts in PRD order (line -> bill -> redemptions -> GST) | EDGE: bill discount is not lost/over-applied when a package-redeemed line is last | expected 197 / got 196 |
| 207 | computeBill — membership discount (PRD §8) | service-only membership must NOT discount retail products | expected 50000 / got 40000 |
| 208 | computeBill — membership discount (PRD §8) | membership must NOT discount a wallet top-up purchase | expected 1000000 / got 800000 |
| 209 | computeBill — commission (PRD §9: post-discount, pre-GST) | EDGE: 3-way split never pays out more than the line commission | expected 1001 / got 1002 |
| 210 | computeBill — commission (PRD §9: post-discount, pre-GST) | slab commission rule (PRD: "10% up to ₹50,000; 15% above") produces a commission | expected > 0 / got 0 |

### tests/unit/money.test.ts — 3 failing

| # | Area | Test | Expected → Actual |
| ---: | --- | --- | --- |
| 211 | money utils (BR-01: integer paise, bps) > distributeProRata | EDGE: never allocates a negative share | expected >= 0 / got -1 |
| 212 | money utils (BR-01: integer paise, bps) > distributeProRata | EDGE: zero-weight items get exactly zero | expected 0 / got -1 |
| 213 | money utils (BR-01: integer paise, bps) > rupee/paise conversion | EDGE: half-paisa rupee input rounds half-up (₹1.005 -> 101 paise) | expected 101 / got 100 |

### tests/unit/security-utils.test.ts — 1 failing

| # | Area | Test | Expected → Actual |
| ---: | --- | --- | --- |
| 214 | normalizePhone (+91XXXXXXXXXX) | EDGE: garbage input must not produce a stored "valid-looking" number | expected not /^\+\d{1,9}$/ / got "+12345" |
