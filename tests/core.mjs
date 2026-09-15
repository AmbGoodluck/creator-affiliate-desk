// Pure engine logic. Shared by the edge functions (copied inline there for Deno) and by the tests.
// No em dashes anywhere in generated copy is a hard rule.

export function firstName(n) {
  return (n && n !== "there") ? String(n).split(" ")[0] : "";
}

export function personalize(text, c, s) {
  const name = c.name || "there";
  return String(text || "")
    .replaceAll("{name}", name)
    .replaceAll("{compliment}", c.compliment || "")
    .replaceAll("{problem}", c.problem || "")
    .replaceAll("{fromName}", s.from_name || "");
}

export function buildFirst(c, s) {
  const fn = firstName(c.name);
  const subject = c.subject_override
    ? c.subject_override
    : (fn ? String(s.subject_named).replaceAll("{name}", fn) : s.subject_generic);
  const body = c.email_override
    ? c.email_override
    : (personalize(s.body_template, c, s) + "\n\n" + s.footer + "\n" + s.address);
  return { subject, body };
}

export function buildFollowup(c, s, tpl) {
  const subject = personalize(tpl.subject, c, s);
  const body = personalize(tpl.body, c, s) + "\n\n" + s.footer + "\n" + s.address;
  return { subject, body };
}

export function addDays(d, days) {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + Number(days));
  return x;
}

// A prospect who got the max follow-ups and is past the window, with no reply, is a ghost.
export function shouldArchiveGhost(c, s, now) {
  if (!c.first_sent_at || c.reply_at || c.archived) return false;
  if (c.status !== "Sent") return false;
  if (c.followups_sent < (s.followup_max || 5)) return false;
  const windowMs = (s.followup_window_days || 14) * 86400000;
  return (new Date(now) - new Date(c.first_sent_at)) > windowMs;
}

// Which follow-up step (1-based) is due now, or 0 if none.
export function dueFollowupStep(c, s, now) {
  if (!c.first_sent_at || c.reply_at || c.status !== "Sent") return 0;
  if (c.followups_sent >= (s.followup_max || 5)) return 0;
  if (!c.next_followup_at) return 0;
  if (new Date(c.next_followup_at) > new Date(now)) return 0;
  return c.followups_sent + 1;
}

export function hasEmDash(t) {
  return /[—–]/.test(String(t || ""));
}
