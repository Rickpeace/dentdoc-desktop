# Verification Checklist — Stripe Payment & Webhook Fixes

## Prerequisites
- [ ] Backend dev server running (`npm run dev` in saas-starter)
- [ ] Desktop app running (`npm start` in dentdoc-desktop)
- [ ] Stripe CLI installed (`stripe login`)
- [ ] Database migration applied (payment_failed_at column exists)

---

## Fix 1: Webhook Error Handling (try/catch)

**Goal:** Webhook handler errors return 200 (not 500), preventing Stripe retry storms.

- [ ] Start Stripe listener: `stripe listen --forward-to localhost:3000/api/stripe/webhook`
- [ ] Trigger any subscription event: `stripe trigger customer.subscription.updated`
- [ ] Check console — should show "Handling PC-based subscription" or similar
- [ ] Confirm Stripe CLI shows `200` response (not 500)

---

## Fix 2: Race Condition Fallback (metadata userId)

**Goal:** Subscription webhook works even if checkout.session.completed hasn't set stripeCustomerId yet.

Hard to test naturally. Visual code review:
- [ ] Open `lib/payments/dentdoc-stripe.ts`
- [ ] Confirm `handlePCSubscription()` (~line 216) has fallback: `if (!user && subscription.metadata?.userId)`
- [ ] Confirm `handleNewPlanSubscription()` (~line 343) has same fallback
- [ ] Confirm both fallbacks also set `stripeCustomerId` on the user

---

## Fix 3: Payment Failed Notification Flow

### 3a. Database field
- [ ] Query DB: `SELECT payment_failed_at FROM users WHERE id = YOUR_ID` — column should exist (value null)

### 3b. Webhook handler + email
- [ ] Start Stripe listener: `stripe listen --forward-to localhost:3000/api/stripe/webhook`
- [ ] Trigger payment failure: `stripe trigger invoice.payment_failed`
- [ ] Check console for: `[PAYMENT_FAILED] User X (email), attempt Y, €Z`
- [ ] Check console for: `[PAYMENT_FAILED] Email sent to ...`
- [ ] Check Resend dashboard (resend.com/emails) for "Zahlung fehlgeschlagen" email
- [ ] Query DB: `SELECT payment_failed_at FROM users WHERE id = YOUR_ID` — should now be non-null

### 3c. Flag cleared on active subscription
- [ ] Trigger subscription update: `stripe trigger customer.subscription.updated`
- [ ] Query DB: `SELECT payment_failed_at FROM users WHERE id = YOUR_ID` — should be null again

### 3d. Desktop notification
- [ ] Manually set flag in DB: `UPDATE users SET payment_failed_at = NOW() WHERE id = YOUR_ID`
- [ ] Restart desktop app (or wait for heartbeat refresh ~5 min)
- [ ] Verify persistent "Zahlung fehlgeschlagen" notification appears
- [ ] Verify clicking it opens dentdoc.de/dashboard/subscription
- [ ] Reset: `UPDATE users SET payment_failed_at = NULL WHERE id = YOUR_ID`

### 3e. API response includes field
- [ ] Call `GET /api/user` with JWT token
- [ ] Verify response includes `paymentFailedAt` field (null or timestamp)

---

## Fix 4: Minute Deduction Moved to Doc Completion

**Goal:** Minutes deducted AFTER documentation succeeds, not after transcription.

### Test with a free_trial user:
- [ ] Note current `minutes_remaining` in DB before recording
- [ ] Make a recording in the desktop app
- [ ] When status overlay shows "Transkription..." (step 3) — check DB: `minutes_remaining` should be UNCHANGED
- [ ] When status overlay shows "Fertig!" (green success) — check DB: `minutes_remaining` should now be REDUCED
- [ ] Check backend console for: `[agent-v2.1] Deducted X min from user Y, remaining: Z`

### Verify doc generation response:
- [ ] Check desktop app console (or backend logs) — doc generation response should include `minutesUsed` and `minutesRemaining`

### Edge case — doc generation fails:
- [ ] If documentation fails (500 error), minutes should NOT be deducted
- [ ] User can retry and minutes are only deducted on success

---

## Fix 5: Type Safety (current_period_end)

- [ ] Open `lib/payments/dentdoc-stripe.ts`
- [ ] Search for `(subscription as any)` — should find ZERO results
- [ ] All `current_period_end` accesses should use `subscription.current_period_end` directly
- [ ] Run `npm run build` in saas-starter — should compile without type errors on these lines

---

## Fix 6: Cancellation Pending Awareness (Desktop)

**Goal:** Desktop app shows warning when subscription is cancelled but still active (cancelAtPeriodEnd).

### 6a. API responses include new fields
- [ ] Call `GET /api/user` with JWT token
- [ ] Verify response includes `cancelAtPeriodEnd` (boolean) and `currentPeriodEnd` (timestamp or null)
- [ ] Login via desktop app — verify cached user object has these fields

### 6b. Desktop notification on cancellation
- [ ] Manually set in DB: `UPDATE users SET cancel_at_period_end = true, current_period_end = NOW() + INTERVAL '30 days' WHERE id = YOUR_ID`
- [ ] Restart desktop app (or wait for heartbeat refresh ~5 min)
- [ ] Verify "Abo gekündigt" warning notification appears with end date
- [ ] Verify clicking it opens dentdoc.de/dashboard/subscription

### 6c. Tray menu shows cancellation state
- [ ] With `cancel_at_period_end = true`: tray should show "⚠️ Abo gekündigt (bis [DATE])"
- [ ] Reset: `UPDATE users SET cancel_at_period_end = false WHERE id = YOUR_ID`
- [ ] Tray should revert to "✓ DentDoc Pro (X Arbeitsplätze)"

### 6d. Sidebar shows cancellation state
- [ ] With `cancel_at_period_end = true`: sidebar should show "Abo endet am [DATE]" in warning/orange
- [ ] After reset: sidebar should show "DentDoc Pro (X Arbeitsplätze)" in green

### 6e. Login response includes paymentFailedAt
- [ ] Fresh login with `payment_failed_at` set in DB
- [ ] Verify "Zahlung fehlgeschlagen" notification shows immediately (not after 5 min heartbeat)

---

## Smoke Test (Quick Full Flow)

- [ ] Login to desktop app — no errors
- [ ] Dashboard loads — subscription status shows correctly
- [ ] Make a recording — full flow completes (record → transcribe → document → "Fertig!")
- [ ] Tray menu shows correct subscription status
- [ ] No new console errors in either backend or desktop app
