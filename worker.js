// Entrepreneur Lyon - mediated "Connect" feature
//
// Handles two routes on top of the static site:
//   GET  /connect.html  -> renders the intermediary connect form for a given
//                          Airtable record id (?to=recXXXXXXXXXXXXXX)
//   POST /api/connect   -> validates the requester is an existing member,
//                          looks up the target member's email in Airtable,
//                          and sends a mediated introduction email via Resend
//
// Everything else falls through to the normal static-asset handler so the
// existing site (index.html, members.html, privacy.html, etc.) is untouched.
//
// Required secrets (set with `wrangler secret put <NAME>`, never committed):
//   AIRTABLE_TOKEN        Personal Access Token, data.records:read scope
//   AIRTABLE_BASE_ID       e.g. appXXXXXXXXXXXXXX
//   AIRTABLE_TABLE_NAME    e.g. Members
//   RESEND_API_KEY
//   RESEND_FROM_ADDRESS    a verified Resend sending address, e.g.
//                          "Entrepreneur Lyon <connect@entrepreneurlyon.fr>"

const RECORD_ID_PATTERN = /^rec[a-zA-Z0-9]{14}$/;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/connect.html" && request.method === "GET") {
      return renderConnectForm(url);
    }

    if (url.pathname === "/api/connect" && request.method === "POST") {
      return handleConnectSubmit(request, env);
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
      <a href="/members.html">Members</a>
      <a href="/privacy.html">Privacy</a>
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

function errorPage(message) {
  return `<!DOCTYPE html>
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
      <a href="/members.html">Members</a>
      <a href="/privacy.html">Privacy</a>
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
