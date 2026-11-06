# Walkthrough B: Send Newsletter via Resend

## Prerequisites

- Task A is complete (the assemble endpoint outputs styled HTML)
- You have verified the styled output looks correct at the assemble URL
- Your Resend account is set up (it already is -- you use it for RSVPs and connection requests)

## What this adds

A new endpoint: `POST /api/newsletter/send`

It takes the same styled HTML from the assemble endpoint and sends it as an email to your mailing list via Resend, which you already use (free tier: 100 emails/day, 3,000/month).

## Step 1: Add a mailing list field to your Members table

In your Airtable Members table, add a checkbox field called `newsletter_opt_in`. Default it to unchecked. Members who want the newsletter get checked. This is your mailing list -- no new service needed.

Alternatively, if you want to start simpler: hardcode a small list of test emails in the Worker for the first send, then switch to the Airtable query later.

## Step 2: Add the send endpoint to worker.js

Bring this prompt back to your agent:

---

Add a new route to worker.js:

POST /api/newsletter/send

Request body (JSON):
- issue: Airtable record ID for the newsletter issue
- confirm: must be the string "send" (safety check to prevent accidental sends)

Behavior:
1. Validate issue ID and confirm field
2. Call the existing handleNewsletterAssemble logic to generate the styled HTML (refactor the HTML generation into a shared helper if needed)
3. Fetch all Members from Airtable where newsletter_opt_in is checked (use filterByFormula: {newsletter_opt_in}=1)
4. Send the newsletter to each member via Resend, individually (not CC/BCC -- each person gets their own email)
5. Use env.RESEND_FROM_ADDRESS as the from address
6. Subject line: "Entrepreneur Lyon -- [month]" (pull month from the issue record)
7. Rate limit: add a small delay between sends if the list exceeds 10 (Resend free tier has rate limits)
8. Return JSON: { success: true, sent_count: N, failed: [...] }
9. This endpoint must be protected: check for a secret header X-Newsletter-Key that matches a new env secret NEWSLETTER_SEND_KEY. Return 401 if missing or wrong.

Security:
- The confirm field prevents accidental POST requests from triggering a send
- The X-Newsletter-Key header prevents unauthorized sends
- Set the secret with: wrangler secret put NEWSLETTER_SEND_KEY

---

## Step 3: Set the send secret

Run: wrangler secret put NEWSLETTER_SEND_KEY

Enter a random string (e.g. generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

## Step 4: Test with yourself

Before sending to anyone:
1. Set only YOUR email as newsletter_opt_in in Airtable
2. Send a test:

curl -X POST https://entrepreneurlyon.fr/api/newsletter/send \
  -H "Content-Type: application/json" \
  -H "X-Newsletter-Key: YOUR_SECRET" \
  -d '{"issue": "rec88ufcesGQQGyk2", "confirm": "send"}'

3. Check your inbox. Verify the email looks correct in Gmail/Outlook/Apple Mail.

## Step 5: Send to the list

Once the test looks good:
1. Check newsletter_opt_in for all members who should receive it
2. Run the same curl command
3. Check the response for sent_count and any failures

## Resend limits to know

- Free tier: 100 emails/day, 3,000/month
- If your list exceeds 100, you need to either split sends across days or upgrade Resend ($20/month for 50,000 emails)
- For a community of 15-40 active members, the free tier is more than enough

## Future improvements (not needed now)

- Unsubscribe link in the footer (legally required for commercial email, but since this is a member community newsletter sent to opted-in members, it is lower priority)
- Track opens/clicks (Resend supports this on paid plans)
- Archive: save the final HTML to newsletter/issues/ as a file via a Worker endpoint
- Preview link: add a "View in browser" link at the top of the email pointing to the assemble URL
