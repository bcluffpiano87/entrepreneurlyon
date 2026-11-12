// Entrepreneur Lyon - Worker entry point
//
// Dynamic routes on top of the static site:
//   GET  /connect.html        -> renders member-to-member connect form
//   POST /api/connect         -> mediated email via Resend (open to anyone -
//                                 not members-only; target member's real email
//                                 is still never exposed to the browser)
//   POST /api/signup          -> duplicate-email guard + Formspark forward
//   GET  /api/events          -> returns all events from Airtable Events table (with RSVP counts from KV)
//   POST /api/rsvp            -> honeypot + KV store + email notification to Chairman
//   GET  /request-event.html  -> renders the event-request form
//   POST /api/request-event   -> honeypot + email notification to Chairman
//   GET  /api/newsletter/assemble?issue=RECORD_ID -> HTML newsletter from Airtable sections
//   POST /api/language-signup -> writes a record to the Language Specialists
//                                 Airtable table + notifies admin via Resend
//                                 (the form itself lives in the static page
//                                 register-language-specialist.html)
//   GET  /api/language-specialists -> returns all Language Specialists
//                                 records (no email field) for the
//                                 language-services.html directory page
//
// Cron trigger (every 2 hours):
//   scheduled -> sendEventReminders: checks for events starting within 24 hours,
//                sends reminder emails to all RSVPs via Resend, skips already-sent
//
// Everything else falls through to env.ASSETS.fetch(request) for static files.
//
// Required secrets (set with `wrangler secret put <NAME>`, never committed):
//   AIRTABLE_TOKEN        Personal Access Token - needs data.records:read
//                         scope, plus data.records:write scope (used to
//                         create new records in the Language Specialists table)
//   RESEND_API_KEY
// Non-secret vars (wrangler.jsonc):
//   AIRTABLE_BASE_ID, AIRTABLE_TABLE_NAME, AIRTABLE_EVENTS_TABLE,
//   AIRTABLE_LANGUAGE_TABLE, RESEND_FROM_ADDRESS, ADMIN_EMAIL
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

    if (url.pathname === "/api/newsletter/assemble" && request.method === "GET") {
      return handleNewsletterAssemble(request, env);
    }

    if (url.pathname === "/newsletter" && request.method === "GET") {
      return handleNewsletterPublic(env);
    }

    if (url.pathname === "/api/language-signup" && request.method === "POST") {
      return handleLanguageSignupSubmit(request, env);
    }

    if (url.pathname === "/api/language-specialists" && request.method === "GET") {
      return handleGetLanguageSpecialists(env);
    }

    return env.ASSETS.fetch(request);
  }
};

function renderConnectForm(url) {
  const to = url.searchParams.get("to") || "";
  const type = (url.searchParams.get("type") || "member").toLowerCase() === "language" ? "language" : "member";

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
      <a href="/members.html">Member Services</a>
      <a href="/events.html">Events</a>
      <a href="/register-language-specialist.html">Register As Language Specialist</a>
      <a href="/language-services.html">Language Services</a>
      <a href="/workshop-handouts.html">Workshop Handouts</a>
    </nav>
  </header>

  <div class="container">
    <h1>Send a Connection Request</h1>
    <p class="subtitle">Your message will be emailed directly to this member, with your email included so they can reply to you. We never show this member's email address to you.</p>

    <form action="/api/connect" method="POST">
      <input type="hidden" name="to" value="${escapeHtml(to)}">
      <input type="hidden" name="type" value="${escapeHtml(type)}">
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
  const type = ((form.get("type") || "member").toString().trim().toLowerCase() === "language") ? "language" : "member";
  const requesterName = (form.get("requester_name") || "").toString().trim();
  const requesterEmail = (form.get("requester_email") || "").toString().trim();
  const message = (form.get("message") || "").toString().trim();

  if (!RECORD_ID_PATTERN.test(to) || !requesterName || !requesterEmail || !message) {
    return htmlResponse(errorPage("Please fill in all fields and try again."), 400);
  }

  const tableName = type === "language" ? (env.AIRTABLE_LANGUAGE_TABLE || "Language Specialists") : env.AIRTABLE_TABLE_NAME;
  const baseUrl = `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}`;
  const airtableHeaders = { Authorization: `Bearer ${env.AIRTABLE_TOKEN}` };

  // Look up the target's real email server-side. This value never reaches
  // the browser at any point. Intentionally no members-only gate here -
  // anyone can send a connection request to a consenting member or
  // registered language specialist, not just people who already signed up
  // themselves.
  const targetRes = await fetch(`${baseUrl}/${to}`, { headers: airtableHeaders });
  if (!targetRes.ok) {
    return htmlResponse(errorPage("This contact could not be found. Please go back and try again."), 404);
  }
  const targetRecord = await targetRes.json();
  const targetEmail = targetRecord.fields && targetRecord.fields.email;

  if (type === "member") {
    const targetConsent = (targetRecord.fields && targetRecord.fields.directory_consent) || "";
    if (!targetEmail || targetConsent.toLowerCase() !== "yes") {
      return htmlResponse(errorPage("This member is not available for connection requests."), 403);
    }
  } else {
    if (!targetEmail) {
      return htmlResponse(errorPage("This specialist could not be found. Please go back to the Language Services page and try again."), 403);
    }
  }

  // Send the mediated introduction via Resend. reply_to is set to the
  // requester's address so the target can reply in one hop with no further
  // relay needed.
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
      html: `<p><strong>${escapeHtml(requesterName)}</strong> (${escapeHtml(requesterEmail)}) would like to connect with you through Entrepreneur Lyon.</p><p>${escapeHtml(message)}</p><p>Reply directly to this email to respond to them.</p>`
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
  // Cache Airtable response in KV for 5 minutes to reduce API calls
  const CACHE_KEY = "cache:events";
  const CACHE_TTL = 300; // 5 minutes in seconds
  if (env.RSVP_STORE) {
    try {
      const cached = await env.RSVP_STORE.get(CACHE_KEY);
      if (cached) {
        return new Response(cached, {
          status: 200,
          headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=60" }
        });
      }
    } catch { /* cache miss, continue to Airtable */ }
  }

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

  const eventsJson = JSON.stringify(events);

  // Cache in KV for 5 minutes
  if (env.RSVP_STORE) {
    try { await env.RSVP_STORE.put(CACHE_KEY, eventsJson, { expirationTtl: CACHE_TTL }); } catch { /* ignore */ }
  }

  return new Response(eventsJson, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=60"
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
      <a href="/members.html">Member Services</a>
      <a href="/events.html">Events</a>
      <a href="/register-language-specialist.html">Register As Language Specialist</a>
      <a href="/language-services.html">Language Services</a>
      <a href="/workshop-handouts.html">Workshop Handouts</a>
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

async function handleLanguageSignupSubmit(request, env) {
  let form;
  try {
    form = await request.formData();
  } catch (err) {
    return htmlResponse(errorPage("We could not read your submission. Please go back and try again."), 400);
  }

  // Honeypot: pretend success so bots get no signal either way.
  if ((form.get("_honeypot") || "").toString().trim() !== "") {
    return Response.redirect(new URL("/language-signup-sent.html", request.url), 303);
  }

  const name = (form.get("name") || "").toString().trim();
  const email = (form.get("email") || "").toString().trim();
  const languages = form.getAll("languages").map(v => v.toString().trim()).filter(Boolean);
  const otherLanguage = (form.get("other_language") || "").toString().trim();
  if (otherLanguage) languages.push(otherLanguage);
  const participationType = form.getAll("participation_type").map(v => v.toString().trim()).filter(Boolean);
  const background = (form.get("background") || "").toString().trim();
  const canHelpWith = (form.get("can_help_with") || "").toString().trim();
  const gdprConsent = (form.get("gdpr_consent") || "").toString().trim();

  if (!name || !email || languages.length === 0 || participationType.length === 0 || gdprConsent.toLowerCase() !== "yes") {
    return htmlResponse(errorPage("Please fill in all required fields and try again."), 400);
  }

  // Specialist / Business Language Specialist offerings require a background
  // or credential - Language Exchange (casual, club-based) does not.
  const needsBackground =
    participationType.includes("Specialist - Private Lessons") ||
    participationType.includes("Business Language Specialist");
  if (needsBackground && !background) {
    return htmlResponse(
      errorPage("Please describe your background or credentials for private lesson or business language specialist offerings."),
      400
    );
  }

  const tableName = env.AIRTABLE_LANGUAGE_TABLE || "Language Specialists";
  const baseUrl = `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}`;

  // typecast: true lets Airtable auto-create new select options (e.g. a
  // language or category that doesn't exist yet in the table) instead of
  // rejecting the write, so the table doesn't need every possible value
  // pre-configured ahead of time.
  const createRes = await fetch(baseUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.AIRTABLE_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      typecast: true,
      records: [
        {
          fields: {
            name,
            email,
            languages,
            participation_type: participationType,
            background,
            can_help_with: canHelpWith
          }
        }
      ]
    })
  });

  if (!createRes.ok) {
    return htmlResponse(errorPage("We could not save your submission right now. Please try again shortly."), 502);
  }

  // Notify the admin by email. Non-fatal: the record is already saved in
  // Airtable so we continue even if this call fails.
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
        subject: `${name} signed up for Language Services - Entrepreneur Lyon`,
        html: `
<h2>${escapeHtml(name)} signed up as a language helper</h2>
<table style="border-collapse:collapse;margin:16px 0;">
  <tr><td style="padding:4px 12px 4px 0;font-weight:600;">Name</td><td style="padding:4px 0;">${escapeHtml(name)}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:600;">Email</td><td style="padding:4px 0;">${escapeHtml(email)}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:600;">Languages</td><td style="padding:4px 0;">${escapeHtml(languages.join(", "))}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:600;">Category</td><td style="padding:4px 0;">${escapeHtml(participationType.join(", "))}</td></tr>
</table>
${background ? `<p><strong>Background:</strong> ${escapeHtml(background)}</p>` : ""}
${canHelpWith ? `<p><strong>Can help with:</strong> ${escapeHtml(canHelpWith)}</p>` : ""}
<p>Reply directly to this email to respond to them. Full record saved in the ${escapeHtml(tableName)} Airtable table.</p>`
      })
    });
  } catch {
    // Email notification failed but the record is saved - continue.
  }

  return Response.redirect(new URL("/language-signup-sent.html", request.url), 303);
}

async function handleGetLanguageSpecialists(env) {
  const tableName = env.AIRTABLE_LANGUAGE_TABLE || "Language Specialists";
  const baseUrl = `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}`;
  const airtableHeaders = { Authorization: `Bearer ${env.AIRTABLE_TOKEN}` };

  let allRecords = [];
  let offset = null;

  do {
    let pageUrl = baseUrl;
    if (offset) {
      pageUrl += `?offset=${encodeURIComponent(offset)}`;
    }
    const res = await fetch(pageUrl, { headers: airtableHeaders });
    if (!res.ok) {
      return new Response(JSON.stringify({ error: "Failed to fetch language specialists" }), {
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

  // Intentionally omit email from this public response - contact must go
  // through the mediated /connect.html flow, never exposed directly.
  const specialists = allRecords
    .map(r => ({
      id: r.id,
      name: (r.fields && r.fields.name) || "",
      languages: Array.isArray(r.fields && r.fields.languages) ? r.fields.languages : [],
      participation_type: Array.isArray(r.fields && r.fields.participation_type) ? r.fields.participation_type : [],
      background: (r.fields && r.fields.background) || "",
      can_help_with: (r.fields && r.fields.can_help_with) || ""
    }))
    .filter(s => s.name);

  return new Response(JSON.stringify(specialists), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
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
      <a href="/members.html">Member Services</a>
      <a href="/events.html">Events</a>
      <a href="/register-language-specialist.html">Register As Language Specialist</a>
      <a href="/language-services.html">Language Services</a>
      <a href="/workshop-handouts.html">Workshop Handouts</a>
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
      <a href="/members.html">Member Services</a>
      <a href="/events.html">Events</a>
      <a href="/register-language-specialist.html">Register As Language Specialist</a>
      <a href="/language-services.html">Language Services</a>
      <a href="/workshop-handouts.html">Workshop Handouts</a>
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

async function handleNewsletterAssemble(request, env) {
  const url = new URL(request.url);
  const issueId = (url.searchParams.get("issue") || "").toString().trim();

  if (!issueId) {
    return jsonResponse({ error: "Missing issue query parameter." }, 400);
  }

  if (!RECORD_ID_PATTERN.test(issueId)) {
    return jsonResponse({ error: "Invalid issue record id." }, 400);
  }

  // Cache assembled newsletter in KV for 2 minutes to reduce API calls
  const NL_CACHE_KEY = "cache:newsletter:" + issueId;
  const NL_CACHE_TTL = 120;
  if (env.RSVP_STORE) {
    try {
      const cached = await env.RSVP_STORE.get(NL_CACHE_KEY);
      if (cached) {
        return new Response(cached, {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }
        });
      }
    } catch { /* cache miss */ }
  }

  const airtableHeaders = { Authorization: `Bearer ${env.AIRTABLE_TOKEN}` };
  const issuesTableUrl = `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${encodeURIComponent("Newsletter Issues")}`;

  const issueRes = await fetch(`${issuesTableUrl}/${issueId}`, { headers: airtableHeaders });
  if (issueRes.status === 404) {
    return jsonResponse({ error: "Newsletter issue not found." }, 404);
  }
  if (!issueRes.ok) {
    return jsonResponse({ error: "Failed to fetch newsletter issue." }, 502);
  }

  let issueData;
  try {
    issueData = await issueRes.json();
  } catch {
    return jsonResponse({ error: "Failed to fetch newsletter issue." }, 502);
  }

  const month =
    issueData.fields && issueData.fields.month != null ? String(issueData.fields.month).trim() : "";

  const sections = await fetchNewsletterSectionsForIssue(env, issueId, airtableHeaders);
  if (sections === null) {
    return jsonResponse({ error: "Failed to fetch newsletter sections." }, 502);
  }

  const sectionsByNumber = new Map();
  for (const rec of sections) {
    const num = rec.fields && rec.fields.section_number;
    if (typeof num === "number" && !Number.isNaN(num)) {
      sectionsByNumber.set(num, rec);
    }
  }

  function sectionBody(sectionNum) {
    const rec = sectionsByNumber.get(sectionNum);
    if (!rec || !rec.fields) {
      return "[Section not yet approved]";
    }
    const status = rec.fields.status != null ? String(rec.fields.status).trim() : "";
    if (status !== "Approved") {
      return "[Section not yet approved]";
    }
    const content = rec.fields.content != null ? String(rec.fields.content) : "";
    return content;
  }

  function sectionImageUrl(sectionNum) {
    const rec = sectionsByNumber.get(sectionNum);
    if (!rec || !rec.fields) return "";
    const url = rec.fields.image_url != null ? String(rec.fields.image_url).trim() : "";
    return url;
  }

  // Check if a skippable section should be included (approved + non-empty).
  function includeOptional(sectionNum) {
    const rec = sectionsByNumber.get(sectionNum);
    if (!rec || !rec.fields) return false;
    const status = rec.fields.status != null ? String(rec.fields.status).trim() : "";
    if (status !== "Approved") return false;
    const content = rec.fields.content != null ? String(rec.fields.content) : "";
    return content.trim() !== "";
  }

  // Section 3 uses its section_name as the heading (topic changes monthly).
  const s3Rec = sectionsByNumber.get(3);
  const topicHeading = (s3Rec && s3Rec.fields && s3Rec.fields.section_name)
    ? String(s3Rec.fields.section_name).trim()
    : "Topic of the Month";

  // Build HTML newsletter from section data

  function rm(rawText) {
    return renderMarkdown(escapeHtml(rawText));
  }

  function imgTag(url) {
    if (!url) return "";
    return '<div class="sec-img"><img src="' + escapeHtml(url) + '" alt=""></div>';
  }

  function placeholder(label, ratio) {
    return '<div class="ph ph--' + ratio + '"><span>' + escapeHtml(label) + '</span></div>';
  }

  function card(id, num, heading, bodyHtml, extra) {
    const idAttr = id ? ' id="' + id + '"' : "";
    const cls = extra || "";
    const kicker = num
      ? '<p class="kicker"><b>' + String(num).padStart(2, "0") + '</b> ' + escapeHtml(heading) + '</p>\n'
      : "";
    const h2 = heading ? '<h2>' + escapeHtml(heading) + '</h2>\n' : "";
    return '<div class="card' + (cls ? " " + cls : "") + '"' + idAttr + '>\n' + kicker + h2 + bodyHtml + '\n</div>';
  }

  // Nav pills (only sections that exist)
  const navItems = [];
  navItems.push({ id: "events", label: "Events" });
  navItems.push({ id: "topic", label: topicHeading });
  if (includeOptional(4)) navItems.push({ id: "partners", label: "Partners" });
  navItems.push({ id: "highlights", label: "Highlights" });
  navItems.push({ id: "need-to-know", label: "Need to Know" });
  navItems.push({ id: "coworking", label: "Coworking" });
  navItems.push({ id: "community", label: "Community" });
  const navPills = navItems.map(function(n) {
    return '<a href="#' + n.id + '">' + escapeHtml(n.label) + '</a>';
  }).join("\n    ");

  // Section images (from image_url field) or placeholders
  const s2Img = sectionImageUrl(2) ? imgTag(sectionImageUrl(2)) : placeholder("Event photos", "wide");
  const s3Img = sectionImageUrl(3) ? imgTag(sectionImageUrl(3)) : placeholder("Feature image", "wide");
  const s5Img = sectionImageUrl(5) ? imgTag(sectionImageUrl(5)) : placeholder("Entrepreneur photo", "wide");
  const s10Img = sectionImageUrl(10) ? imgTag(sectionImageUrl(10)) : placeholder("Coworking space photo", "3x2");

  // Partners grid (section 4)
  function partnersGrid() {
    const raw = sectionBody(4);
    const blocks = raw.split(/\n\n+/).filter(function(b) { return b.trim() !== ""; });
    return '<div class="grid3">' +
      blocks.map(function(b) { return "<div>" + rm(b) + "</div>"; }).join("") +
      "</div>";
  }

  // Need to Know sub-section block
  function n2kBlock(label, icon, sectionNum) {
    var text = sectionBody(sectionNum);
    var isPlaceholder = text === "[Section not yet approved]";
    var inner = isPlaceholder
      ? '<p class="n2k-empty">Coming this issue</p>'
      : rm(text);
    return '<div class="n2k-sub">' +
      '<div class="n2k-label"><span class="n2k-icon">' + icon + '</span> ' + escapeHtml(label) + '</div>' +
      inner + '</div>';
  }

  // Build cards array
  const cards = [];

  // 1: Opening blurb (no kicker, no nav anchor)
  cards.push(card("", 0, "", '<div class="opening">' + rm(sectionBody(1)) + '</div>', ""));

  // 2: Events
  cards.push(card("events", 2, "Events", s2Img + rm(sectionBody(2)), ""));

  // 3: Topic of the Month (dark band)
  cards.push(card("topic", 3, topicHeading, s3Img + rm(sectionBody(3)), "card--dark"));

  // 4: Partners (optional)
  if (includeOptional(4)) {
    cards.push(card("partners", 4, "Partners", partnersGrid(), ""));
  }

  // 5: Entrepreneur Highlights
  cards.push(card("highlights", 5, "Entrepreneur Highlights", s5Img + rm(sectionBody(5)), ""));

  // 6-9: Need to Know — one card, four sub-sections from four separate Airtable rows
  var n2kHtml = '<div class="n2k">' +
    n2kBlock("Money", "\u20AC", 6) +
    n2kBlock("Taxes", "\u25B6", 7) +
    n2kBlock("Regulations", "\u25A0", 8) +
    n2kBlock("Agencies", "\u2605", 9) +
    '</div>';
  cards.push(card("need-to-know", 0, "Entrepreneur Need to Know", n2kHtml, ""));

  // 10: Free Coworking
  cards.push(card("coworking", 10, "Free Coworking", s10Img + rm(sectionBody(10)), ""));

  // 11: Community Events
  cards.push(card("community", 11, "Community Events", rm(sectionBody(11)), ""));

  const safeMonth = escapeHtml(month || "Unknown month");

  const page = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Entrepreneur Lyon -- ${safeMonth}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html { scroll-behavior: smooth; scroll-padding-top: 64px; }
    @media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; color: #1a1a1a; line-height: 1.6; }

    .progress { position: fixed; top: 0; left: 0; right: 0; height: 3px; background: #1a1a1a; transform-origin: 0 50%; transform: scaleX(0); z-index: 11; }
    @supports (animation-timeline: scroll()) {
      .progress { animation: grow 1ms linear both; animation-timeline: scroll(root); }
    }
    @keyframes grow { to { transform: scaleX(1); } }

    .wrap { max-width: 640px; margin: 0 auto; padding: 16px 16px 60px; }

    .masthead { background: #fff; border-radius: 12px; padding: 28px; text-align: center; margin-bottom: 0; }
    .masthead-title { font-size: 32px; font-weight: 800; letter-spacing: -0.5px; }
    .masthead-issue { font-size: 15px; color: #666; margin-top: 6px; }

    .nav { position: sticky; top: 0; z-index: 10; background: rgba(245,245,245,.85); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); display: flex; gap: 6px; overflow-x: auto; padding: 10px 0; scrollbar-width: none; scroll-snap-type: x proximity; margin: 12px 0; }
    .nav::-webkit-scrollbar { display: none; }
    .nav a { flex: none; scroll-snap-align: start; padding: 7px 12px; border-radius: 999px; background: #fff; color: #1a1a1a; font-size: 13px; font-weight: 600; text-decoration: none; white-space: nowrap; }
    .nav a:hover { background: #1a1a1a; color: #fff; }

    .card { background: #fff; border-radius: 12px; padding: 28px; margin-bottom: 16px; }
    .card--dark { background: #1a1a1a; color: #fff; }
    .card--dark .kicker { color: #999; }
    .card--dark .kicker b { color: #fff; }
    .card--dark h2 { color: #fff; }
    .card--dark h3 { color: #fff; }
    .card--dark p { color: #eee; }
    .card--dark li { color: #eee; }
    .card--dark a { color: #fff; text-decoration: underline; }
    .card--dark blockquote { border-left-color: #666; }
    .card--dark .ph { border-color: #444; background: #222; color: #666; }

    .kicker { font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: #888; margin: 0 0 6px; }
    .kicker b { color: #1a1a1a; margin-right: 6px; }
    .card--dark .kicker b { color: #fff; }

    h2 { font-size: 24px; font-weight: 700; margin-bottom: 16px; }
    .card p { margin-bottom: 12px; color: #333; font-size: 17px; line-height: 1.6; }
    .card p:last-child { margin-bottom: 0; }
    .card h3 { font-size: 16px; font-weight: 700; margin: 16px 0 8px; }
    .card ul { margin: 8px 0 12px 20px; }
    .card li { margin-bottom: 6px; color: #333; font-size: 17px; line-height: 1.6; }
    .card a { color: #1a1a1a; }
    .card img { max-width: 100%; border-radius: 10px; display: block; }

    .opening p { font-size: 18px; }

    blockquote { margin: 24px 0 0; padding: 0 0 0 20px; border-left: 3px solid #1a1a1a; font-size: 20px; line-height: 1.45; font-style: italic; }
    blockquote p { font-size: 20px !important; line-height: 1.45 !important; font-style: italic; }

    .sec-img { margin: 0 0 20px; border-radius: 10px; overflow: hidden; }
    .sec-img img { width: 100%; height: auto; display: block; }

    .ph { border: 1.5px dashed #ccc; border-radius: 10px; background: #fafafa; display: flex; align-items: center; justify-content: center; text-align: center; color: #999; font-size: 13px; padding: 20px; margin: 0 0 20px; }
    .ph--wide { aspect-ratio: 16 / 9; }
    .ph--3x2 { aspect-ratio: 3 / 2; }

    .n2k { display: flex; flex-direction: column; gap: 0; }
    .n2k-sub { padding: 20px 0; border-top: 1px solid #eee; }
    .n2k-sub:first-child { border-top: none; padding-top: 0; }
    .n2k-sub:last-child { padding-bottom: 0; }
    .n2k-label { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #1a1a1a; margin-bottom: 10px; display: flex; align-items: center; gap: 6px; }
    .n2k-icon { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 6px; background: #f5f5f5; font-size: 12px; }
    .n2k-empty { font-style: italic; color: #999 !important; font-size: 14px !important; }
    .n2k-sub ul { margin: 8px 0 4px 20px; }
    .n2k-sub li { margin-bottom: 6px; }
    .n2k-sub strong { font-variant-numeric: tabular-nums; }

    .grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }

    .nl-footer { text-align: center; font-size: 12px; color: #999; margin-top: 8px; line-height: 1.8; }

    @supports (animation-timeline: view()) {
      @media (prefers-reduced-motion: no-preference) {
        .card { animation: reveal 1ms linear both; animation-timeline: view(); animation-range: entry 0% entry 40%; }
      }
    }
    @keyframes reveal { from { opacity: .3; transform: translateY(16px); } to { opacity: 1; transform: none; } }

    @media (max-width: 480px) {
      .wrap { padding: 8px 12px 40px; }
      .masthead { padding: 20px; }
      .masthead-title { font-size: 28px; }
      .card { padding: 20px; }
      .grid3 { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
<div class="progress"></div>
<div class="wrap">
  <div class="masthead">
    <div class="masthead-title">Entrepreneur Lyon</div>
    <div class="masthead-issue">${safeMonth}</div>
  </div>
  <nav class="nav" id="top">
    ${navPills}
  </nav>
  ${cards.join("\n  ")}
  <div class="nl-footer">
    <div>Entrepreneur Lyon -- entrepreneurlyon.fr</div>
    <div>The English-first working group for people building a business in France from Lyon.</div>
  </div>
</div>
</body>
</html>`;

  // Cache in KV for 2 minutes
  if (env.RSVP_STORE) {
    try { await env.RSVP_STORE.put(NL_CACHE_KEY, page, { expirationTtl: NL_CACHE_TTL }); } catch { /* ignore */ }
  }

  return new Response(page, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }
  });
}

async function handleNewsletterPublic(env) {
  const airtableHeaders = { Authorization: `Bearer ${env.AIRTABLE_TOKEN}` };
  const issuesTableUrl = `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${encodeURIComponent("Newsletter Issues")}`;

  let latestIssueId = null;
  try {
    const params = new URLSearchParams();
    params.set("filterByFormula", "{published}=1");
    params.append("sort[0][field]", "month");
    params.append("sort[0][direction]", "desc");
    params.set("maxRecords", "1");

    const res = await fetch(`${issuesTableUrl}?${params.toString()}`, { headers: airtableHeaders });
    if (res.ok) {
      const data = await res.json();
      if (data.records && data.records.length > 0) {
        latestIssueId = data.records[0].id;
      }
    }
  } catch {
    // Fall through to empty page
  }

  if (!latestIssueId) {
    const emptyPage = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Newsletter - Entrepreneur Lyon</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; color: #1a1a1a; line-height: 1.6; display: grid; place-items: center; min-height: 100vh; }
    .msg { text-align: center; padding: 40px; }
    .msg h1 { font-size: 24px; margin-bottom: 8px; }
    .msg p { color: #666; }
    .msg a { color: #1a1a1a; }
  </style>
</head>
<body>
  <div class="msg">
    <h1>Newsletter</h1>
    <p>No newsletter published yet. Check back soon.</p>
    <p style="margin-top:16px"><a href="/">Back to home</a></p>
  </div>
</body>
</html>`;
    return new Response(emptyPage, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" }
    });
  }

  // Reuse handleNewsletterAssemble logic with the found issue ID
  const fakeUrl = new URL("https://entrepreneurlyon.fr/api/newsletter/assemble?issue=" + latestIssueId);
  const fakeRequest = new Request(fakeUrl.toString(), { method: "GET" });
  const result = await handleNewsletterAssemble(fakeRequest, env);

  // Override cache header for public page
  const body = await result.text();
  return new Response(body, {
    status: result.status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" }
  });
}

async function fetchNewsletterSectionsForIssue(env, issueId, airtableHeaders) {
  const baseUrl = `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${encodeURIComponent("Newsletter Sections")}`;
  const escapedId = issueId.replace(/'/g, "\\'");
  const filterFormula = `FIND('${escapedId}', ARRAYJOIN({issue}))`;

  let allRecords = [];
  let offset = null;

  try {
    do {
      const params = new URLSearchParams();
      params.set("filterByFormula", filterFormula);
      params.append("sort[0][field]", "section_number");
      params.append("sort[0][direction]", "asc");
      if (offset) {
        params.set("offset", offset);
      }

      const res = await fetch(`${baseUrl}?${params.toString()}`, { headers: airtableHeaders });
      if (!res.ok) {
        return null;
      }
      const data = await res.json();
      if (data.records) {
        allRecords = allRecords.concat(data.records);
      }
      offset = data.offset || null;
    } while (offset);
  } catch {
    return null;
  }

  return allRecords;
}

// Converts minimal markdown (already HTML-escaped) to HTML.
// Handles: **bold**, *italic*, > blockquote, - list, [link](url), ![img](url), ### heading, blank-line paragraphs.
function renderMarkdown(text) {
  const lines = text.split("\n");
  const out = [];
  let inUl = false;
  let inBq = false;
  let pLines = [];

  function flushP() {
    if (pLines.length > 0) { out.push("<p>" + pLines.join(" ") + "</p>"); pLines = []; }
  }
  function closeUl() { if (inUl) { out.push("</ul>"); inUl = false; } }
  function closeBq() { if (inBq) { out.push("</blockquote>"); inBq = false; } }

  function inline(s) {
    s = s.replace(/!\[([^\]]*)\]\(([^)]*)\)/g, "<img src=\"$2\" alt=\"$1\">");
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<a href=\"$2\">$1</a>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    // Auto-link full URLs (https://... or http://...)
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]+)/g, function(m, pre, url) {
      var clean = url.replace(/[.,;:!?)]+$/, "");
      var trail = url.slice(clean.length);
      return pre + "<a href=\"" + clean + "\">" + clean + "</a>" + trail;
    });
    // Auto-link bare domains (e.g. culturefusion-lyon.com, rdi.asso.fr)
    s = s.replace(/(^|[\s(])([a-zA-Z0-9][\w-]*(?:\.[a-zA-Z0-9][\w-]*)*\.(?:com|fr|org|net|eu|io|co|uk|de|info|biz|ly|app|dev|tech|site|me|gov)(?:\/[^\s<]*)?)/gi, function(m, pre, url) {
      if (pre === "/") return m;
      var clean = url.replace(/[.,;:!?)]+$/, "");
      var trail = url.slice(clean.length);
      return pre + "<a href=\"https://" + clean + "\">" + clean + "</a>" + trail;
    });
    return s;
  }

  for (const raw of lines) {
    const t = raw.trim();
    if (t === "") { flushP(); closeUl(); closeBq(); continue; }
    if (t.startsWith("### ")) {
      flushP(); closeUl(); closeBq();
      out.push("<h3>" + inline(t.slice(4)) + "</h3>");
      continue;
    }
    // After escapeHtml, ">" becomes "&gt;" -- detect blockquote prefix accordingly
    if (t.startsWith("&gt; ")) {
      flushP(); closeUl();
      if (!inBq) { out.push("<blockquote>"); inBq = true; }
      out.push("<p>" + inline(t.slice(5)) + "</p>");
      continue;
    }
    if (t.startsWith("- ")) {
      flushP(); closeBq();
      if (!inUl) { out.push("<ul>"); inUl = true; }
      out.push("<li>" + inline(t.slice(2)) + "</li>");
      continue;
    }
    closeUl(); closeBq();
    pLines.push(inline(t));
  }
  flushP(); closeUl(); closeBq();
  return out.join("\n");
}

