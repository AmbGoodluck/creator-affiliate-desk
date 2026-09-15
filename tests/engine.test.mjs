import { test } from "node:test";
import assert from "node:assert/strict";
import {
  firstName, personalize, buildFirst, buildFollowup,
  addDays, shouldArchiveGhost, dueFollowupStep, hasEmDash
} from "./core.mjs";

const settings = {
  from_name: "Osman",
  product: "Money Reset",
  address: "123 Main St, Berea, KY",
  footer: "You are getting this note because of your work in personal finance. If you would prefer I not reach out again, just reply and I will remove you.",
  subject_named: "quick idea for you, {name}",
  subject_generic: "a quick partnership idea",
  body_template: "Hi {name},\n\n{compliment}\n\n{problem} I am building something for exactly that.\n\nThanks,\n{fromName}",
  followup_max: 5,
  followup_window_days: 14,
};

const named = { name: "Erin", compliment: "Broke Millennial made money approachable.", problem: "Your readers want simple steps.", subject_override: "", email_override: "" };
const brand = { name: "there", compliment: "Great community.", problem: "They want one system.", subject_override: "", email_override: "" };

test("firstName picks first token, blanks 'there'", () => {
  assert.equal(firstName("Erin"), "Erin");
  assert.equal(firstName("Julien and Kiersten"), "Julien");
  assert.equal(firstName("there"), "");
});

test("named subject uses the name, brand falls back to generic", () => {
  assert.equal(buildFirst(named, settings).subject, "quick idea for you, Erin");
  assert.equal(buildFirst(brand, settings).subject, "a quick partnership idea");
});

test("first email fills placeholders and appends footer + address", () => {
  const { body } = buildFirst(named, settings);
  assert.ok(body.startsWith("Hi Erin,"));
  assert.ok(body.includes("Broke Millennial made money approachable."));
  assert.ok(body.includes("Your readers want simple steps."));
  assert.ok(body.includes("Thanks,\nOsman"));
  assert.ok(body.includes("123 Main St, Berea, KY"));
  assert.ok(!body.includes("{"));
});

test("subject and email overrides win", () => {
  const c = { ...named, subject_override: "custom subject", email_override: "custom body" };
  const { subject, body } = buildFirst(c, settings);
  assert.equal(subject, "custom subject");
  assert.equal(body, "custom body");
});

test("no em dashes in any generated copy", () => {
  assert.ok(!hasEmDash(buildFirst(named, settings).body));
  assert.ok(!hasEmDash(settings.body_template));
  assert.ok(!hasEmDash(settings.footer));
  const tpl = { subject: "quick follow up", body: "Hi {name},\n\nJust floating this back up.\n\nThanks,\n{fromName}" };
  assert.ok(!hasEmDash(buildFollowup(named, settings, tpl).body));
});

test("addDays advances UTC dates", () => {
  const d = new Date("2026-09-14T00:00:00Z");
  assert.equal(addDays(d, 3).toISOString(), "2026-09-17T00:00:00.000Z");
});

test("dueFollowupStep returns next step only when due", () => {
  const base = { first_sent_at: "2026-09-01T00:00:00Z", status: "Sent", reply_at: null, followups_sent: 1, next_followup_at: "2026-09-04T00:00:00Z" };
  assert.equal(dueFollowupStep(base, settings, "2026-09-05T00:00:00Z"), 2);
  assert.equal(dueFollowupStep(base, settings, "2026-09-03T00:00:00Z"), 0); // not due yet
  assert.equal(dueFollowupStep({ ...base, reply_at: "2026-09-03" }, settings, "2026-09-05T00:00:00Z"), 0); // replied
  assert.equal(dueFollowupStep({ ...base, followups_sent: 5 }, settings, "2026-09-05T00:00:00Z"), 0); // maxed
});

test("shouldArchiveGhost only fires after max follow-ups past the window with no reply", () => {
  const ghost = { first_sent_at: "2026-09-01T00:00:00Z", status: "Sent", reply_at: null, archived: false, followups_sent: 5 };
  assert.equal(shouldArchiveGhost(ghost, settings, "2026-09-20T00:00:00Z"), true);  // 19 days later
  assert.equal(shouldArchiveGhost(ghost, settings, "2026-09-10T00:00:00Z"), false); // inside window
  assert.equal(shouldArchiveGhost({ ...ghost, followups_sent: 3 }, settings, "2026-09-20T00:00:00Z"), false); // not maxed
  assert.equal(shouldArchiveGhost({ ...ghost, reply_at: "2026-09-05" }, settings, "2026-09-20T00:00:00Z"), false); // replied
});
