// Entrepreneur Lyon - Worker entry point
//
// Dynamic routes on top of the static site:
//   GET  /connect.html        -> renders member-to-member connect form
//   POST /api/connect         -> members-only gate + mediated email via Resend
//   POST /api/signup          -> duplicate-email guard + Formspark forward
//   GET  /api/events          -> returns all events from Airtable Events table (with RSVP counts from KV)
//   POST /api/rsvp            -> honeypot + KV store + email notification to Chairman
//   GET  /request-event.html  -> renders the event-request form
//   POST /api/request-event   -> honeypot + email notification to Chairman
//
// Cron trigger (every 2 hours):
//   scheduled -> sendEventReminders: checks for events starting within 24 hours,
//                sends reminder emails to all RSVPs via Resend, skips already-sent
//
// Everything else falls through to env.ASSETS.fetch(request) for static files.
//
// Required secrets (set with `wrangler secret put <NAME>`, never committed):
//   AIRTABLE_TOKEN        Personal Access Token, data.records:read scope
//   RESEND_API_KEY
// Non-secret vars (wrangler.jsonc):
//   AIRTABLE_BASE_ID, AIRTABLE_TABLE_NAME, AIRTABLE_EVENTS_TABLE,
//   RESEND_FROM_ADDRESS, ADMIN_EMAIL
// KV namespace (wrangler.jsonc, create with wrangler kv namespace create RSVP_STORE):
//   RSVP_STORE

const RECORD_ID_PATTERN = /^rec[a-zA-Z0-9]{14}$/;

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendEventReminders(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/connect.html" && request.method === "GET") {
      return renderConnectForm(url);
    }

    if (url.pathname === "/api/connect" && request.method === "POST") {
      return handleConnectSubmit(request, env);
    }

    if (url.pathname === "/api/signup" && request.method === "POST") {
      return handleSignupSubmit(request, env);
    }

    if (url.pathname === "/api/events" && request.method === "GET") {
      return handleGetEvents(env);
    }

    if (url.pathname === "/api/rsvp" && request.method === "POST") {
      return handleRsvpSubmit(request, env);
    }

    if (url.pathname === "/request-event.html" && request.method === "GET") {
      return renderRequestEventForm();
    }

    if (url.pathname === "/api/request-event" && request.method === "POST") {
      return handleRequestEventSubmit(request, env);
    }

    return env.ASSETS.fetch(request);
  }
};

function renderConnectForm(url) {
  const to = url.searchParams.get("to") || "";

  if (!RECORD_ID_PATTERN.test(to)) {
    return htmlResponse(
      errorPage("This connection link is missing or invalid. Please go back to the member directory and try again."),
      400
    );
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Connect - Entrepreneur Lyon</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <header class="site-header">
    <a href="/" class="site-title">Entrepreneur Lyon</a>
    <nav class="site-nav">
      <a href="/become-a-member.html">Become A Member</a>
      <a href="/events.html">Events</a>
      <a href="/members.html">Member Services</a>
    </nav>
  </header>

  <div class="container">
    <h1>Send a Connection Request</h1>
    <p class="subtitle">Your message will be emailed directly to this member, with your email included so they can reply to you. We only accept connection requests from registered members, and we never show this member's email address to you.</p>

    <form action="/api/connect" method="POST">
      <input type="hidden" name="to" value="${escapeHtml(to)}">
      <input type="text" name="_honeypot" style="display:none" tabindex="-1" autocomplete="off">

      <div class="field">
        <label>Your Name <span class="required">*</span></label>
        <input type="text" name="requester_name" required placeholder="Your name">
      </div>

      <div class="field">
        <label>Your Email <span class="required">*</span></label>
        <input type="email" name="requester_email" required placeholder="The email you signed up with">
      </div>

      <div class="field">
        <label>Message <span class="required">*</span></label>
        <input type="text" name="message" required placeholder="Say hello and why you would like to connect">
      </div>

      <button type="submit">Send Connection Request</button>
    </form>
  </div>

  <footer class="site-footer">
    <span>Entrepreneur Lyon</span>
    <a href="/privacy.html">Privacy</a>
  </footer>
</body>
</html>`;

  return htmlResponse(html, 200);
}

async function handleConnectSubmit(request, env) {
  let form;
  try {
    form = await request.formData();
  } catch (err) {
    return htmlResponse(errorPage("We could not read your submission. Please go back and try again."), 400);
  }

  // Honeypot: pretend success so bots get no signal either way.
  if ((form.get("_honeypot") || "").toString().trim() !== "") {
    return Response.redirect(new URL("/connect-sent.html", request.url), 303);
  }

  const to = (form.get("to") || "").toString().trim();
  const requesterName = (form.get("requester_name") || "").toString().trim();
  const requesterEmail = (form.get("requester_email") || "").toString().trim();
  const message = (form.get("message") || "").toString().trim();

  if (!RECORD_ID_PATTERN.test(to) || !requesterName || !requesterEmail || !message) {
    return htmlResponse(errorPage("Please fill in all fields and try again."), 400);
  }

  const baseUrl = `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${encodeURIComponent(env.AIRTABLE_TABLE_NAME)}`;
  const airtableHeaders = { Authorization: `Bearer ${env.AIRTABLE_TOKEN}` };

  // Step 1 - members-only gate: the requester must already have a record
  // (i.e. they already submitted the sign-up form) matching the email they
  // entered here.
  const escapedEmail = requesterEmail.toLowerCase().replace(/'/g, "\\'");
  const filterFormula = `LOWER({email})='${escapedEmail}'`;
  const lookupUrl = `${baseUrl}?filterByFormula=${encodeURIComponent(filterFormula)}&maxRecords=1`;

  const lookupRes = await fetch(lookupUrl, { headers: airtableHeaders });
  if (!lookupRes.ok) {
    return htmlResponse(errorPage("We could not process your request right now. Please try again shortly."), 502);
  }
  const lookupData = await lookupRes.json();
  if (!lookupData.records || lookupData.records.length === 0) {
    return htmlResponse(
      errorPage("We could not find a member account matching that email address. Please sign up on the home page first, then try connecting again."),
      403
    );
  }

  // Step 2 - look up the target member's real email server-side. This value
  // never reaches the browser at any point.
  const targetRes = await fetch(`${baseUrl}/${to}`, { headers: airtableHeaders });
  if (!targetRes.ok) {
    return htmlResponse(errorPage("This member could not be found. Please go back to the directory and try again."), 404);
  }
  const targetRecord = await targetRes.json();
  const targetEmail = targetRecord.fields && targetRecord.fields.email;
  const targetConsent = (targetRecord.fields && targetRecord.fields.directory_consent) || "";

  if (!targetEmail || targetConsent.toLowerCase() !== "yes") {
    return htmlResponse(errorPage("This member is not available for connection requests."), 403);
  }

  // Step 3 - send the mediated introduction via Resend. reply_to is set to
  // the requester's address so the target can reply in one hop with no
  // further relay needed.
  const emailRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: env.RESEND_FROM_ADDRESS,
      to: [targetEmail],
      reply_to: requesterEmail,
      subject: `${requesterName} would like to connect with you - Entrepreneur Lyon`,
      html: `<p><strong>${escapeHtml(requesterName)}</strong> (${escapeHtml(requesterEmail)}) would like to connect with you through the Entrepreneur Lyon member directory.</p><p>${escapeHtml(message)}</p><p>Reply directly to this email to respond to them.</p>`
    })
  });

  if (!emailRes.ok) {
    return htmlResponse(errorPage("We could not send your connection request right now. Please try again shortly."), 502);
  }

  return Response.redirect(new URL("/connect-sent.html", request.url), 303);
}

async function handleSignupSubmit(request, env) {
  let form;
  try {
    form = await request.formData();
  } catch (err) {
    return htmlResponse(errorPage("We could not read your submission. Please go back and try again."), 400);
  }

  // Honeypot: pretend success so bots get no signal either way.
  if ((form.get("_honeypot") || "").toString().trim() !== "") {
    return Response.redirect(new URL("/thank-you", request.url), 303);
  }

  const email = (form.get("email") || "").toString().trim();

  // Duplicate check: fail OPEN on any Airtable error. A read hiccup here
  // should never block a brand new member from signing up - at worst, a
  // rare duplicate slips through and can be cleaned up manually, which is
  // far better than blocking real signups during an outage.
  if (email) {
    try {
      const baseUrl = `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${encodeURIComponent(env.AIRTABLE_TABLE_NAME)}`;
      const airtableHeaders = { Authorization: `Bearer ${env.AIRTABLE_TOKEN}` };
      const escapedEmail = email.toLowerCase().replace(/'/g, "\\'");
      const filterFormula = `LOWER({email})='${escapedEmail}'`;
      const lookupUrl = `${baseUrl}?filterByFormula=${encodeURIComponent(filterFormula)}&maxRecords=1`;

      const lookupRes = await fetch(lookupUrl, { headers: airtableHeaders });
      if (lookupRes.ok) {
        const lookupData = await lookupRes.json();
        if (lookupData.records && lookupData.records.length > 0) {
          return htmlResponse(alreadySignedUpPage(), 200);
        }
      }
    } catch (err) {
      // Swallow and fall through to forwarding the signup below.
    }
  }

  // Forward every submitted field (including repeated checkbox-group
  // entries like availability_monday) to Formspark server-side, exactly as
  // the browser submitted them. The existing Zapier automation keeps
  // handling Airtable record creation downstream, unchanged.
  const forwardBody = new FormData();
  for (const [key, value] of form.entries()) {
    if (key === "_honeypot") continue;
    forwardBody.append(key, value);
  }

  let formsparkRes;
  try {
    formsparkRes = await fetch("https://submit-form.com/9epwvWIJT", {
      method: "POST",
      redirect: "manual",
      headers: { Accept: "application/json" },
      body: forwardBody
    });
  } catch (err) {
    return htmlResponse(errorPage("We could not submit your signup right now. Please try again shortly."), 502);
  }

  if (formsparkRes.status >= 400) {
    return htmlResponse(errorPage("We could not submit your signup right now. Please try again shortly."), 502);
  }

  return Response.redirect(new URL("/thank-you", request.url), 303);
}

async function handleGetEvents(env) {
  const baseUrl = `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${encodeURIComponent(env.AIRTABLE_EVENTS_TABLE)}`;
  const airtableHeaders = { Authorization: `Bearer ${env.AIRTABLE_TOKEN}` };

  let allRecords = [];
  let offset = null;

  // Paginate through all records (Airtable returns max 100 per page)
  do {
    let pageUrl = baseUrl;
    if (offset) {
      pageUrl += `?offset=${encodeURIComponent(offset)}`;
    }
    const res = await fetch(pageUrl, { headers: airtableHeaders });
    if (!res.ok) {
      return new Response(JSON.stringify({ error: "Failed to fetch events" }), {
        status: 502,
        headers: { "Content-Type": "application/json" }
      });
    }
    const data = await res.json();
    if (data.records) {
      allRecords = allRecords.concat(data.records);
    }
    offset = data.offset || null;
  } while (offset);

  // Fetch RSVP counts from KV in parallel for all records.
  // Fails open: any KV error returns 0 so events still render.
  const rsvpCounts = await Promise.all(
    allRecords.map(async r => {
      if (!env.RSVP_STORE) return 0;
      try {
        const val = await env.RSVP_STORE.get(`rsvp:${r.id}`);
        if (!val) return 0;
        const arr = JSON.parse(val);
        return Array.isArray(arr) ? arr.length : 0;
      } catch {
        return 0;
      }
    })
  );

  const events = allRecords.map((r, i) => ({
    id: r.id,
    title: r.fields.event_name || "Untitled Event",
    start: r.fields.start_date || null,
    end: r.fields.end_date || null,
    extendedProps: {
      location: r.fields.location || "",
      description: r.fields.description || "",
      rsvp_count: rsvpCounts[i]
    }
  }));

  return new Response(JSON.stringify(events), {
    status: 200,
    // No caching: response now includes live RSVP counts from KV.
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}

async function handleRsvpSubmit(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid request body." }, 400);
  }

  // Honeypot: pretend success so bots get no signal.
  if ((body._honeypot || "").toString().trim() !== "") {
    return jsonResponse({ success: true, rsvp_count: 0 }, 200);
  }

  const eventId = (body.event_id || "").toString().trim();
  const eventName = (body.event_name || "").toString().trim();
  const name = (body.name || "").toString().trim();
  const email = (body.email || "").toString().trim();

  if (!eventId || !eventName || !name || !email) {
    return jsonResponse({ error: "Please fill in all required fields." }, 400);
  }

  if (!RECORD_ID_PATTERN.test(eventId)) {
    return jsonResponse({ error: "Invalid event reference." }, 400);
  }

  if (!email.includes("@") || !email.includes(".")) {
    return jsonResponse({ error: "Please enter a valid email address." }, 400);
  }

  if (!env.RSVP_STORE) {
    return jsonResponse({ error: "RSVP storage is not available right now. Please try again later." }, 503);
  }

  const kvKey = `rsvp:${eventId}`;
  let rsvps = [];

  try {
    const existing = await env.RSVP_STORE.get(kvKey);
    if (existing) {
      const parsed = JSON.parse(existing);
      rsvps = Array.isArray(parsed) ? parsed : [];
    }
  } catch {
    rsvps = [];
  }

  // Duplicate check: same email for the same event.
  const alreadyRsvped = rsvps.some(r => r.email.toLowerCase() === email.toLowerCase());
  if (alreadyRsvped) {
    return jsonResponse({ error: "You have already RSVP'd to this event." }, 409);
  }

  rsvps.push({ name, email, timestamp: new Date().toISOString() });

  try {
    await env.RSVP_STORE.put(kvKey, JSON.stringify(rsvps));
  } catch {
    return jsonResponse({ error: "Could not save your RSVP right now. Please try again shortly." }, 502);
  }

  const newCount = rsvps.length;

  // Send notification email to the Chairman. Non-fatal: RSVP is already
  // persisted in KV so we continue even if the email call fails.
  const emailHtml = `
<h2>${escapeHtml(name)} is going to ${escapeHtml(eventName)}</h2>
<table style="border-collapse:collapse;margin:16px 0;">
  <tr><td style="padding:4px 12px 4px 0;font-weight:600;">Name</td><td style="padding:4px 0;">${escapeHtml(name)}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:600;">Email</td><td style="padding:4px 0;">${escapeHtml(email)}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:600;">Event</td><td style="padding:4px 0;">${escapeHtml(eventName)}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:600;">Total RSVPs</td><td style="padding:4px 0;">${newCount}</td></tr>
</table>
<p>Reply directly to this email to contact the attendee.</p>`;

  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: env.RESEND_FROM_ADDRESS,
        to: [env.ADMIN_EMAIL],
        reply_to: email,
        subject: `${name} is going to ${eventName} - Entrepreneur Lyon`,
        html: emailHtml
      })
    });
  } catch {
    // Email notification failed but RSVP is saved - continue.
  }

  return jsonResponse({ success: true, rsvp_count: newCount }, 200);
}

async function sendEventReminders(env) {
  if (!env.RSVP_STORE) return;

  // Fetch all events from Airtable
  const baseUrl = `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${encodeURIComponent(env.AIRTABLE_EVENTS_TABLE)}`;
  const airtableHeaders = { Authorization: `Bearer ${env.AIRTABLE_TOKEN}` };

  let allRecords = [];
  let offset = null;
  do {
    let pageUrl = baseUrl;
    if (offset) pageUrl += `?offset=${encodeURIComponent(offset)}`;
    const res = await fetch(pageUrl, { headers: airtableHeaders });
    if (!res.ok) return;
    const data = await res.json();
    if (data.records) allRecords = allRecords.concat(data.records);
    offset = data.offset || null;
  } while (offset);

  const now = Date.now();
  const twentyFourHours = 24 * 60 * 60 * 1000;

  for (const record of allRecords) {
    const startStr = record.fields.start_date;
    if (!startStr) continue;

    const startTime = new Date(startStr).getTime();
    if (isNaN(startTime)) continue;

    // Only events starting within the next 24 hours (and not already past)
    if (startTime <= now || startTime > now + twentyFourHours) continue;

    const sentKey = `reminder-sent:${record.id}`;
    const alreadySent = await env.RSVP_STORE.get(sentKey);
    if (alreadySent) continue;

    // Get RSVPs for this event
    const rsvpData = await env.RSVP_STORE.get(`rsvp:${record.id}`);
    if (!rsvpData) continue;

    let rsvps;
    try {
      rsvps = JSON.parse(rsvpData);
      if (!Array.isArray(rsvps) || rsvps.length === 0) continue;
    } catch {
      continue;
    }

    const eventName = record.fields.event_name || "Upcoming Event";
    const location = record.fields.location || "";
    const description = record.fields.description || "";
    const startDate = new Date(startStr);
    const dateOpts = { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" };
    const dateFormatted = startDate.toLocaleDateString("en-GB", dateOpts);

    // Send a reminder to each RSVP. Individual sends so each person
    // gets a personal email and we stay within Resend best practices.
    for (const rsvp of rsvps) {
      if (!rsvp.email) continue;

      const reminderHtml = `
<h2>Reminder: ${escapeHtml(eventName)} is coming up</h2>
<p>Hi ${escapeHtml(rsvp.name || "there")},</p>
<p>This is a friendly reminder that you RSVP'd to an upcoming event:</p>
<table style="border-collapse:collapse;margin:16px 0;">
  <tr><td style="padding:4px 12px 4px 0;font-weight:600;">Event</td><td style="padding:4px 0;">${escapeHtml(eventName)}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:600;">When</td><td style="padding:4px 0;">${escapeHtml(dateFormatted)}</td></tr>
  ${location ? `<tr><td style="padding:4px 12px 4px 0;font-weight:600;">Where</td><td style="padding:4px 0;">${escapeHtml(location)}</td></tr>` : ""}
</table>
${description ? `<p>${escapeHtml(description)}</p>` : ""}
<p>See you there!</p>
<p style="color:#888;font-size:12px;">Entrepreneur Lyon - <a href="https://entrepreneurlyon.fr/events.html">View all events</a></p>`;

      try {
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.RESEND_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            from: env.RESEND_FROM_ADDRESS,
            to: [rsvp.email],
            subject: `Reminder: ${eventName} is tomorrow - Entrepreneur Lyon`,
            html: reminderHtml
          })
        });
      } catch {
        // Individual email failure should not stop other reminders
      }
    }

    // Mark this event's reminder as sent. TTL of 48 hours for auto-cleanup.
    await env.RSVP_STORE.put(sentKey, "1", { expirationTtl: 172800 });
  }
}

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function renderRequestEventForm() {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Request to Add an Event - Entrepreneur Lyon</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <header class="site-header">
    <a href="/" class="site-title">Entrepreneur Lyon</a>
    <nav class="site-nav">
      <a href="/become-a-member.html">Become A Member</a>
      <a href="/events.html">Events</a>
      <a href="/members.html">Member Services</a>
    </nav>
  </header>

  <div class="container">
    <h1>Request to Add an Event</h1>
    <p class="subtitle">Have an event you think the community would enjoy? Fill in the details below and we will review it. If approved, it will appear on the events calendar.</p>

    <form action="/api/request-event" method="POST">
      <input type="text" name="_honeypot" style="display:none" tabindex="-1" autocomplete="off">

      <div class="section-label">Event Details</div>

      <div class="field">
        <label>Event Name <span class="required">*</span></label>
        <input type="text" name="event_name" required placeholder="Name of the event">
      </div>

      <div class="row">
        <div class="field">
          <label>Proposed Date and Time <span class="required">*</span></label>
          <input type="datetime-local" name="proposed_date" required>
        </div>
        <div class="field">
          <label>End Date and Time</label>
          <input type="datetime-local" name="proposed_end_date">
        </div>
      </div>

      <div class="field">
        <label>Location <span class="required">*</span></label>
        <input type="text" name="location" required placeholder="Where will the event take place?">
      </div>

      <div class="field">
        <label>Description <span class="required">*</span></label>
        <textarea name="description" required rows="4" placeholder="Tell us about the event, what to expect, who it is for..." style="width:100%;padding:10px 12px;border:1px solid #ddd;border-radius:6px;font-size:15px;font-family:inherit;background:#fafafa;resize:vertical;"></textarea>
      </div>

      <div class="section-label">Your Details</div>

      <div class="row">
        <div class="field">
          <label>Your Name <span class="required">*</span></label>
          <input type="text" name="requester_name" required placeholder="Your name">
        </div>
        <div class="field">
          <label>Your Email <span class="required">*</span></label>
          <input type="email" name="requester_email" required placeholder="your@email.com">
        </div>
      </div>

      <button type="submit">Submit Event Request</button>
    </form>
  </div>

  <footer class="site-footer">
    <span>Entrepreneur Lyon</span>
    <a href="/privacy.html">Privacy</a>
  </footer>
</body>
</html>`;

  return htmlResponse(html, 200);
}

async function handleRequestEventSubmit(request, env) {
  let form;
  try {
    form = await request.formData();
  } catch (err) {
    return htmlResponse(errorPage("We could not read your submission. Please go back and try again."), 400);
  }

  if ((form.get("_honeypot") || "").toString().trim() !== "") {
    return Response.redirect(new URL("/event-request-sent.html", request.url), 303);
  }

  const eventName = (form.get("event_name") || "").toString().trim();
  const proposedDate = (form.get("proposed_date") || "").toString().trim();
  const proposedEndDate = (form.get("proposed_end_date") || "").toString().trim();
  const location = (form.get("location") || "").toString().trim();
  const description = (form.get("description") || "").toString().trim();
  const requesterName = (form.get("requester_name") || "").toString().trim();
  const requesterEmail = (form.get("requester_email") || "").toString().trim();

  if (!eventName || !proposedDate || !location || !description || !requesterName || !requesterEmail) {
    return htmlResponse(errorPage("Please fill in all required fields and try again."), 400);
  }

  const endDateLine = proposedEndDate
    ? `<tr><td style="padding:4px 12px 4px 0;font-weight:600;">End</td><td style="padding:4px 0;">${escapeHtml(proposedEndDate)}</td></tr>`
    : "";

  const emailHtml = `
<h2>${escapeHtml(requesterName)} would like to add an event</h2>
<table style="border-collapse:collapse;margin:16px 0;">
  <tr><td style="padding:4px 12px 4px 0;font-weight:600;">Event</td><td style="padding:4px 0;">${escapeHtml(eventName)}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:600;">Date</td><td style="padding:4px 0;">${escapeHtml(proposedDate)}</td></tr>
  ${endDateLine}
  <tr><td style="padding:4px 12px 4px 0;font-weight:600;">Location</td><td style="padding:4px 0;">${escapeHtml(location)}</td></tr>
</table>
<p><strong>Description:</strong></p>
<p>${escapeHtml(description)}</p>
<hr style="margin:16px 0;">
<p><strong>Requested by:</strong> ${escapeHtml(requesterName)} (${escapeHtml(requesterEmail)})</p>
<p>Reply directly to this email to respond to them. If you approve this event, add it to the Events table in Airtable and it will appear on the calendar automatically.</p>`;

  const emailRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: env.RESEND_FROM_ADDRESS,
      to: [env.ADMIN_EMAIL],
      reply_to: requesterEmail,
      subject: `${requesterName} would like to add an event: ${eventName} - Entrepreneur Lyon`,
      html: emailHtml
    })
  });

  if (!emailRes.ok) {
    return htmlResponse(errorPage("We could not send your event request right now. Please try again shortly."), 502);
  }

  return Response.redirect(new URL("/event-request-sent.html", request.url), 303);
}

function alreadySignedUpPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Already Signed Up - Entrepreneur Lyon</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <header class="site-header">
    <a href="/" class="site-title">Entrepreneur Lyon</a>
    <nav class="site-nav">
      <a href="/become-a-member.html">Become A Member</a>
      <a href="/events.html">Events</a>
      <a href="/members.html">Member Services</a>
    </nav>
  </header>

  <div class="container">
    <div class="page-card">
      <h2>You are already signed up.</h2>
      <p>We found an existing member record with this email address, so we have not created a duplicate entry.</p>
      <p>If you would like to update your details, email us at contact@entrepreneurlyon.fr.</p>
      <p><a href="/">Back to home</a></p>
    </div>
  </div>

  <footer class="site-footer">
    <span>Entrepreneur Lyon</span>
    <a href="/privacy.html">Privacy</a>
  </footer>
</body>
</html>`;
}

function errorPage(message) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Error - Entrepreneur Lyon</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <header class="site-header">
    <a href="/" class="site-title">Entrepreneur Lyon</a>
    <nav class="site-nav">
      <a href="/become-a-member.html">Become A Member</a>
      <a href="/events.html">Events</a>
      <a href="/members.html">Member Services</a>
    </nav>
  </header>

  <div class="container">
    <div class="page-card">
      <h2>Something went wrong</h2>
      <p>${escapeHtml(message)}</p>
      <p><a href="/members.html">Back to the member directory</a></p>
    </div>
  </div>

  <footer class="site-footer">
    <span>Entrepreneur Lyon</span>
    <a href="/privacy.html">Privacy</a>
  </footer>
</body>
</html>`;
}

function htmlResponse(html, status) {
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
