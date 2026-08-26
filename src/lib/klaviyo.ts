/**
 * Klaviyo subscription — consent, recorded where Klaviyo will honour it.
 *
 * The quiz already pushes `identify` from the browser, which creates the
 * profile and hangs the answers off it. What it cannot do is consent: identify
 * sets attributes, and Klaviyo keeps consent in a separate structure it will
 * not accept from onsite JS. The result was profiles carrying a phone number
 * with `sms consent: NONE` — a number collected against a promise to text it,
 * that nothing was permitted to text. This closes that.
 *
 * Server-side because it needs the private key, which must never reach theme
 * JS, and because consent should be written by something the shopper cannot
 * forge.
 *
 * Reading consent back: the profiles endpoint does NOT return subscriptions
 * unless asked. Without additional-fields[profile]=subscriptions it returns an
 * empty structure that reads as "no consent" for every profile in the account,
 * subscribed or not. Anything checking this work must pass that parameter or it
 * will conclude nothing is working.
 */

const KLAVIYO_API = "https://a.klaviyo.com/api";
const REVISION = "2024-10-15";

/** Where campaigns actually go. Verified against the last 100 campaigns: the
 *  audiences are engagement segments plus this one list, and it appears in
 *  every send since 2026-08-08. The Ops lists are paying-subscriber tooling and
 *  appear in no campaign at all. */
const EMAIL_LIST = process.env.KLAVIYO_EMAIL_LIST_ID ?? "ThXxvd";
/** The only SMS list. Note there is no established SMS sending pattern to join
 *  — one test campaign in Feb 2026, targeting nothing — so this records consent
 *  for a channel that is being started rather than continued. */
const SMS_LIST = process.env.KLAVIYO_SMS_LIST_ID ?? "SEWuSA";

/**
 * Klaviyo wants E.164. The quiz deliberately accepts loose input — strict
 * client-side phone validation rejects real numbers — so normalising is this
 * side's job. Returns null rather than guessing when the shape is not a US
 * number we can be confident about; a wrong number is worse than none, and the
 * profile still gets the email.
 */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  // Already international and plausible.
  if (String(raw).trim().startsWith("+") && digits.length >= 8 && digits.length <= 15) {
    return `+${digits}`;
  }
  return null;
}

interface SubscribeResult {
  email: "subscribed" | "skipped" | "failed";
  sms: "subscribed" | "skipped" | "failed";
  detail?: string;
}

async function subscribeToList(
  listId: string,
  profile: Record<string, unknown>,
  customSource: string
): Promise<{ ok: boolean; detail?: string }> {
  const key = process.env.KLAVIYO_API_KEY;
  if (!key) return { ok: false, detail: "no-api-key" };

  const res = await fetch(`${KLAVIYO_API}/profile-subscription-bulk-create-jobs/`, {
    method: "POST",
    headers: {
      Authorization: `Klaviyo-API-Key ${key}`,
      revision: REVISION,
      "Content-Type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      data: {
        type: "profile-subscription-bulk-create-job",
        attributes: {
          // Shows on the profile as how consent was obtained. Klaviyo surfaces
          // this in the consent record, so it is the audit trail.
          custom_source: customSource,
          profiles: { data: [profile] },
        },
        relationships: { list: { data: { type: "list", id: listId } } },
      },
    }),
    cache: "no-store",
  });

  if (res.status === 202 || res.ok) return { ok: true };
  const body = await res.text();
  return { ok: false, detail: `${res.status} ${body.slice(0, 200)}` };
}

/**
 * Subscribe a quiz completer.
 *
 * Two jobs, not one: a subscription job carries a single list relationship, and
 * email and SMS belong on different lists. They fail independently — a bad
 * phone number must not cost the email subscription, which is the one that
 * happens on every completion.
 */
export async function subscribeQuizCompleter(opts: {
  email: string | null;
  phone: string | null;
}): Promise<SubscribeResult> {
  const out: SubscribeResult = { email: "skipped", sms: "skipped" };

  if (opts.email) {
    const r = await subscribeToList(
      EMAIL_LIST,
      {
        type: "profile",
        attributes: {
          email: opts.email,
          subscriptions: {
            /* No consented_at. Klaviyo rejects it on a live subscription —
               "Non-historical email subscription cannot have consented_at
               timestamp" — because it stamps the moment itself; that field is
               for back-dating an import, which this is not. */
            email: { marketing: { consent: "SUBSCRIBED" } },
          },
        },
      },
      "Hair quiz — discount"
    );
    out.email = r.ok ? "subscribed" : "failed";
    if (!r.ok) out.detail = r.detail;
  }

  const phone = toE164(opts.phone);
  if (phone) {
    const r = await subscribeToList(
      SMS_LIST,
      {
        type: "profile",
        attributes: {
          // The email rides along so the number lands on the profile the quiz
          // answers are already on, rather than creating a second, phone-only
          // one that never joins up.
          ...(opts.email ? { email: opts.email } : {}),
          phone_number: phone,
          subscriptions: {
            sms: { marketing: { consent: "SUBSCRIBED" } },
          },
        },
      },
      "Hair quiz — SMS bonus"
    );
    out.sms = r.ok ? "subscribed" : "failed";
    if (!r.ok) out.detail = (out.detail ? out.detail + " | " : "") + r.detail;
  }

  return out;
}
