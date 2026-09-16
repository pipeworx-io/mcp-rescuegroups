interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * RescueGroups.org MCP — adoptable animals and the rescues/shelters that list
 * them, from the RescueGroups.org v5 public API.
 * (https://api.rescuegroups.org/v5/public/docs)
 *
 * BYO-key, and BYO-key ONLY. Pipeworx holds no RescueGroups key and this pack
 * never reads a platform one — `_apiKey` is required on every tool. A free
 * public key is issued on request from
 * https://rescuegroups.org/services/request-an-api-key/ (see `KEY_HELP`).
 *
 * Tools:
 * - rescuegroups_adoptable      — available animals by species (+ postal-code radius)
 * - rescuegroups_animal         — one animal by id, with pictures/breeds/org
 * - rescuegroups_organizations  — rescues and shelters (+ postal-code radius)
 * - rescuegroups_species        — the species vocabulary the other tools accept
 * - rescuegroups_breeds         — breeds for a species (for exact breed filters)
 */


const BASE_URL = 'https://api.rescuegroups.org/v5';

// RescueGroups requires this exact content type on EVERY request, GET included
// ("The only content type supported is application/vnd.api+json").
const JSON_API = 'application/vnd.api+json';

// The Workers runtime sends no User-Agent by default, and an upstream behind a
// bot filter answers 403 to that — which reads as "they closed their API"
// rather than as a missing header. Identify honestly; RescueGroups is a
// non-profit that asks callers not to flood it.
const UA = 'pipeworx-mcp-rescuegroups/1.0 (+https://pipeworx.io)';

// Bound every fetch() to a fixed timeout — an upstream that degrades without
// erroring would otherwise hold the Worker until its own budget kills it.
// Mirrors the abstract-phone / epoFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'RescueGroups');
}

// ── The refusal wording ────────────────────────────────────────────────
//
// This sentence is the whole product for a caller who has no key: a model
// relays it verbatim to a user, so it has to be actionable standing alone.
// It names the thing needed, where to get it, what getting it actually
// involves (a reviewed form, not an instant self-serve token — a caller told
// "get a free key" who then waits on a human email will think we lied), and
// the argument to pass it in.
const KEY_HELP =
  'Request a free public API key at https://rescuegroups.org/services/request-an-api-key/ ' +
  '— a short form (name, email, organisation, site URL). It is open to individual ' +
  'developers: "not incorporated" is an accepted answer and you do not need to be a ' +
  'rescue or shelter. RescueGroups staff review it and email the key back, so it is not ' +
  'instant. Then pass the key as the `_apiKey` argument.';

const MISSING_KEY_MESSAGE = `RescueGroups requires an API key, and Pipeworx does not supply one. ${KEY_HELP}`;

// Species accepted as a URL "view". Straight from the documented view list on
// the animals endpoint; RescueGroups spells them plural and lower-case.
const SPECIES = [
  'alpacas', 'birds', 'cats', 'chickens', 'chinchillas', 'cows', 'degus', 'dogs',
  'donkeys', 'ducks', 'ferrets', 'fish', 'frogs', 'geckos', 'geese', 'gerbils',
  'goats', 'groundhogs', 'guineapigs', 'hamsters', 'hedgehogs', 'hermitcrabs',
  'horses', 'iguanas', 'lizards', 'llama', 'mice', 'otters', 'pigs', 'ponies',
  'prairiedogs', 'rabbits', 'rats', 'sheep', 'skunks', 'snakes', 'sugargliders',
  'tarantulas', 'tortoises', 'turkeys', 'turtles',
] as const;

// Non-species animal views that can be stacked onto a search URL alongside
// `available` and a species (documented under the animals endpoint).
const TRAIT_VIEWS = [
  'haspic', 'isspecialneeds', 'isneedingfoster', 'urgent', 'iscourtesylisting', 'attending',
] as const;

const tools: McpToolExport['tools'] = [
  {
    name: 'rescuegroups_adoptable',
    description:
      'Search adoptable animals listed by rescues and shelters on RescueGroups.org: name, breed, age, sex, size, temperament flags (good with kids/dogs/cats), photos, and the listing organization. Filter by species, postal-code radius, breed, sex, age group and size. Requires your own RescueGroups API key. Example: rescuegroups_adoptable({ species: "dogs", postalcode: "15206", miles: 50, limit: 5, _apiKey: "your-key" })',
    inputSchema: {
      type: 'object',
      properties: {
        species: {
          type: 'string',
          enum: [...SPECIES],
          description:
            'Species to search, spelled plural and lower-case as RescueGroups does (e.g. "dogs", "cats", "rabbits", "horses"). Omit to search every species at once. Call rescuegroups_species for the live list.',
        },
        postalcode: {
          type: 'string',
          description:
            'US or Canadian postal/zip code to search around, e.g. "15206". Requires `miles` or `kilometers`. RescueGroups uses the centre of the postal code, so this is less precise than lat/lon.',
        },
        lat: { type: 'number', description: 'Latitude to search around. Use with `lon` and `miles`/`kilometers`. More precise than `postalcode`.' },
        lon: { type: 'number', description: 'Longitude to search around. Use with `lat`.' },
        miles: { type: 'number', description: 'Radius in miles for a distance search. Provide exactly one of `miles` or `kilometers`; the returned `distance` field is in the same unit.' },
        kilometers: { type: 'number', description: 'Radius in kilometres for a distance search. Provide exactly one of `miles` or `kilometers`.' },
        breed: {
          type: 'string',
          description:
            'Breed to match, e.g. "Beagle". Matched as a substring against the animal\'s breed string, so "Retriever" matches "Golden Retriever". Call rescuegroups_breeds for exact names.',
        },
        sex: { type: 'string', enum: ['Male', 'Female'], description: 'Restrict to one sex.' },
        age_group: {
          type: 'string',
          enum: ['Baby', 'Young', 'Adult', 'Senior'],
          description: 'General age band as RescueGroups classifies it.',
        },
        size_group: {
          type: 'string',
          enum: ['Small', 'Medium', 'Large', 'X-Large'],
          description: 'Expected adult size band.',
        },
        name: { type: 'string', description: 'Match the animal\'s name (substring, e.g. "Curly").' },
        good_with_kids: { type: 'boolean', description: 'Only animals flagged good with children.' },
        good_with_dogs: { type: 'boolean', description: 'Only animals flagged OK with other dogs.' },
        good_with_cats: { type: 'boolean', description: 'Only animals flagged OK with cats.' },
        views: {
          type: 'array',
          items: { type: 'string', enum: [...TRAIT_VIEWS] },
          description:
            'Extra RescueGroups "views" to stack onto the search: "haspic" (has at least one photo), "isspecialneeds", "isneedingfoster", "urgent", "iscourtesylisting", "attending" (attending an adoption event).',
        },
        org_id: { type: 'string', description: 'Restrict the search to one organization id (see rescuegroups_organizations).' },
        include_adopted: {
          type: 'boolean',
          description:
            'Search already-adopted animals instead of available ones. Default false (only animals available for adoption).',
        },
        sort: {
          type: 'string',
          description:
            'Field to sort by, prefixed with "-" for descending, e.g. "-animals.updatedDate" (most recently updated first) or "animals.name". On a distance search "distance" sorts nearest-first. Fully-qualified names like "animals.name" are what the API expects.',
        },
        limit: { type: 'number', description: 'Rows per page, 1-250. Default 25.' },
        page: { type: 'number', description: 'Page of results, starting at 1. Use with `limit`; the response `pagination` block tells you how many pages there are.' },
        _apiKey: {
          type: 'string',
          description: `Your own RescueGroups API key. Pipeworx has no shared key for this pack. ${KEY_HELP}`,
        },
      },
      required: ['_apiKey'],
    },
  },
  {
    name: 'rescuegroups_animal',
    description:
      'Full record for one adoptable animal by RescueGroups id — description, all photos, breeds, adoption fee, temperament and the listing rescue/shelter with its contact details. Requires your own RescueGroups API key. Example: rescuegroups_animal({ animal_id: "8013243", _apiKey: "your-key" })',
    inputSchema: {
      type: 'object',
      properties: {
        animal_id: { type: 'string', description: 'RescueGroups animal id, as returned in the `id` field by rescuegroups_adoptable.' },
        _apiKey: {
          type: 'string',
          description: `Your own RescueGroups API key. ${KEY_HELP}`,
        },
      },
      required: ['animal_id', '_apiKey'],
    },
  },
  {
    name: 'rescuegroups_organizations',
    description:
      'Find animal rescues and shelters with RescueGroups.org accounts: name, type (Rescue or Shelter), address, phone, email, website, adoption process, areas served and services. Filter by postal-code radius, state or name. Requires your own RescueGroups API key. Example: rescuegroups_organizations({ postalcode: "15206", miles: 25, limit: 5, _apiKey: "your-key" })',
    inputSchema: {
      type: 'object',
      properties: {
        postalcode: { type: 'string', description: 'US or Canadian postal/zip code to search around. Requires `miles` or `kilometers`.' },
        lat: { type: 'number', description: 'Latitude to search around. Use with `lon`.' },
        lon: { type: 'number', description: 'Longitude to search around. Use with `lat`.' },
        miles: { type: 'number', description: 'Radius in miles. Provide exactly one of `miles` or `kilometers`.' },
        kilometers: { type: 'number', description: 'Radius in kilometres. Provide exactly one of `miles` or `kilometers`.' },
        name: { type: 'string', description: 'Match the organization name (substring).' },
        state: { type: 'string', description: 'Two-letter state or province code, e.g. "PA".' },
        city: { type: 'string', description: 'City name.' },
        type: {
          type: 'string',
          enum: ['rescue', 'shelter'],
          description: 'Restrict to rescues or to shelters. Omit for both.',
        },
        org_id: { type: 'string', description: 'Fetch one organization by id instead of searching.' },
        sort: { type: 'string', description: 'Field to sort by, "-" prefixed for descending, e.g. "orgs.name". On a distance search "distance" sorts nearest-first.' },
        limit: { type: 'number', description: 'Rows per page, 1-250. Default 25.' },
        page: { type: 'number', description: 'Page of results, starting at 1.' },
        _apiKey: {
          type: 'string',
          description: `Your own RescueGroups API key. ${KEY_HELP}`,
        },
      },
      required: ['_apiKey'],
    },
  },
  {
    name: 'rescuegroups_species',
    description:
      'The species vocabulary RescueGroups uses — singular, plural and young-animal words for each species it lists. Use it to get the exact `species` value rescuegroups_adoptable expects. Requires your own RescueGroups API key. Example: rescuegroups_species({ _apiKey: "your-key" })',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Rows per page, 1-250. Default 250 (the whole list is small).' },
        page: { type: 'number', description: 'Page of results, starting at 1.' },
        _apiKey: {
          type: 'string',
          description: `Your own RescueGroups API key. ${KEY_HELP}`,
        },
      },
      required: ['_apiKey'],
    },
  },
  {
    name: 'rescuegroups_breeds',
    description:
      'Breeds RescueGroups recognises for a species, for building an exact breed filter. Requires your own RescueGroups API key. Example: rescuegroups_breeds({ species: "dogs", limit: 50, _apiKey: "your-key" })',
    inputSchema: {
      type: 'object',
      properties: {
        species: {
          type: 'string',
          enum: [...SPECIES],
          description: 'Species whose breeds to list, plural and lower-case, e.g. "dogs". Omit for every breed across all species (thousands of rows — page it).',
        },
        limit: { type: 'number', description: 'Rows per page. This endpoint allows up to 10000. Default 250.' },
        page: { type: 'number', description: 'Page of results, starting at 1.' },
        _apiKey: {
          type: 'string',
          description: `Your own RescueGroups API key. ${KEY_HELP}`,
        },
      },
      required: ['_apiKey'],
    },
  },
];

// ── Request plumbing ───────────────────────────────────────────────────

interface JsonApiResource {
  type?: string;
  id?: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: JsonApiRef | JsonApiRef[] }>;
}
interface JsonApiRef { type?: string; id?: string }
interface JsonApiBody {
  meta?: Record<string, unknown>;
  data?: JsonApiResource | JsonApiResource[];
  included?: JsonApiResource[];
  errors?: { status?: number; title?: string; detail?: string; source?: unknown }[];
}

interface RgRequest {
  path: string;
  tool: string;
  apiKey: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

/**
 * One request to the v5 API, returning the parsed JSON:API body.
 *
 * The interesting part is the invalid-key branch. Probed live 2026-09-05:
 *
 *   no Authorization header  -> 401 application/vnd.api+json, a real JSON:API
 *                               error naming the missing header
 *   junk Authorization value -> 200 OK, Content-Length: 0, text/plain
 *
 * So a REJECTED key is a silent zero, not an error — the shape that
 * docs/silent-zero-policy.md exists about. Passed through naively it reads as
 * "there are no adoptable dogs near you", which is both wrong and unfixable by
 * the user, because nothing tells them their key is the problem. Every empty
 * non-JSON 200 is therefore treated as an auth failure here.
 */
async function rgRequest({ path, tool, apiKey, query, body }: RgRequest): Promise<JsonApiBody> {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  }

  const init: RequestInit = {
    method: body ? 'POST' : 'GET',
    headers: {
      // The key travels in a header and is never put in the URL: a URL is
      // logged by every hop whether or not the call succeeds
      // (cf. pwcall.sh's deny_credential_in_query).
      Authorization: apiKey,
      'Content-Type': JSON_API,
      Accept: JSON_API,
      'User-Agent': UA,
    },
  };
  if (body) init.body = JSON.stringify(body);

  let res: Response;
  try {
    res = await pwFetch(url, init);
  } catch (e) {
    throw new Error(`RescueGroups ${tool}: network error reaching api.rescuegroups.org — ${(e as Error).message}`);
  }

  const text = await res.text();

  // A rejected key: 200, empty body, text/plain instead of vnd.api+json.
  if (res.ok && text.trim() === '') {
    throw new Error(
      `RescueGroups ${tool}: the API key you passed as _apiKey was not accepted. RescueGroups signals this ` +
        `oddly — it answers HTTP ${res.status} with a completely empty body rather than a 401, so this is a ` +
        'rejected key and not an empty result set. (A missing key returns a JSON 401 instead, so the two are ' +
        'distinguishable.) Check the key was copied whole. Note also that RescueGroups scopes a key when it ' +
        'issues it, to a chosen species and to either your own organization or a national search, so a key ' +
        `issued for a narrower scope than this query can also come back empty. ${KEY_HELP}`,
    );
  }

  if (!res.ok) throw rgError(res.status, tool, text, apiKey);

  let parsed: JsonApiBody;
  try {
    parsed = JSON.parse(text) as JsonApiBody;
  } catch {
    throw new Error(
      `RescueGroups ${tool}: api.rescuegroups.org returned a non-JSON response (HTTP ${res.status}). Retry; if it persists the upstream is misbehaving.`,
    );
  }

  // 4XX bodies carry the useful text, but a 200 can also carry `errors`.
  if (parsed.errors?.length) {
    throw new Error(`RescueGroups ${tool}: ${redactKey(describeErrors(parsed.errors), apiKey)}`);
  }

  return parsed;
}

function describeErrors(errors: NonNullable<JsonApiBody['errors']>): string {
  return errors
    .map((e) => [e.title, e.detail].filter(Boolean).join(' — '))
    .filter(Boolean)
    .join('; ');
}

/**
 * Scrub the caller's key out of anything we relay from upstream.
 *
 * The key travels in a header, not the query string, so RescueGroups has no
 * ordinary reason to quote it back — but "no ordinary reason" is not a
 * guarantee, and an error message is a string we hand to a model, which may
 * put it in a transcript, a log line or a reply. Every upstream-derived string
 * in this pack goes through here, so the requirement ("never log or echo the
 * key back in any response, error, or usage record") holds even if the vendor
 * starts echoing it.
 */
function redactKey(text: string, apiKey: string): string {
  if (!apiKey || apiKey.length < 8) return text;
  return text.split(apiKey).join('[redacted _apiKey]');
}

function rgError(status: number, tool: string, text: string, apiKey: string): Error {
  let detail = '';
  try {
    const body = JSON.parse(text) as JsonApiBody;
    if (body.errors?.length) detail = describeErrors(body.errors);
  } catch {
    detail = text.slice(0, 200);
  }
  detail = redactKey(detail, apiKey);

  if (status === 401) {
    // The documented 401 is "no Authorization header at all". Because callTool
    // refuses before we ever get here when _apiKey is absent, a 401 reaching
    // this point means the key was sent but rejected for permissions.
    return new Error(
      `RescueGroups ${tool}: authorization failed (HTTP 401)${detail ? ` — ${detail}` : ''}. Your _apiKey was sent but the API refused it for this endpoint. Public animal and organization data needs an API key, not a user token. ${KEY_HELP}`,
    );
  }
  if (status === 429) {
    return new Error(
      `RescueGroups ${tool}: rate-limited (HTTP 429). RescueGroups throttles keys sending an abnormal number of requests and does not publish the exact ceiling. Slow down and cache reference data (species, breeds) rather than re-fetching it.`,
    );
  }
  if (status === 400) {
    return new Error(
      `RescueGroups ${tool}: the API rejected the request (HTTP 400)${detail ? ` — ${detail}` : ''}. Check that \`limit\` is 1-250, that any \`sort\` names a real field, and that a distance search supplies both a location and a radius.`,
    );
  }
  if (status === 404) {
    return new Error(`RescueGroups ${tool}: not found (HTTP 404)${detail ? ` — ${detail}` : ''}.`);
  }
  if (status >= 500) {
    return new Error(
      `RescueGroups ${tool}: upstream error (HTTP ${status})${detail ? ` — ${detail}` : ''}. This is an error on the RescueGroups side; retry shortly.`,
    );
  }
  return new Error(`RescueGroups ${tool} error: HTTP ${status}${detail ? ` — ${detail}` : ''}`);
}

// ── Response shaping ───────────────────────────────────────────────────

/**
 * Flatten a JSON:API resource into a plain row, resolving `relationships`
 * against `included` so a caller sees `breeds: ["Beagle"]` rather than a pair
 * of dangling type/id references.
 *
 * Deliberately generic rather than a per-field mapping. The v5 change log
 * (2019-10-03) says null attributes are simply omitted from responses and that
 * the field set grew, so a hand-written field list would silently drop data as
 * the API moves; passing attributes through keeps the pack honest.
 */
function flatten(resource: JsonApiResource, includedIndex: Map<string, JsonApiResource>): Record<string, unknown> {
  const row: Record<string, unknown> = { id: resource.id, ...(resource.attributes ?? {}) };

  for (const [relName, rel] of Object.entries(resource.relationships ?? {})) {
    const refs = Array.isArray(rel?.data) ? rel.data : rel?.data ? [rel.data] : [];
    if (refs.length === 0) continue;

    const resolved = refs.map((ref) => {
      const hit = includedIndex.get(`${ref.type}:${ref.id}`);
      if (!hit) return { id: ref.id, type: ref.type };
      // One level deep only — enough for breeds/pictures/orgs, and it cannot
      // recurse into a cycle.
      return { id: hit.id, ...(hit.attributes ?? {}) };
    });

    row[relName] = resolved;
  }

  return row;
}

function indexIncluded(included: JsonApiResource[] | undefined): Map<string, JsonApiResource> {
  const map = new Map<string, JsonApiResource>();
  for (const inc of included ?? []) {
    if (inc.type && inc.id) map.set(`${inc.type}:${inc.id}`, inc);
  }
  return map;
}

function shape(body: JsonApiBody, extra?: Record<string, unknown>) {
  const included = indexIncluded(body.included);
  const data = body.data;
  const resources = Array.isArray(data) ? data : data ? [data] : [];
  const rows = resources.map((r) => flatten(r, included));
  const meta = body.meta ?? {};

  return {
    count: typeof meta.count === 'number' ? meta.count : rows.length,
    returned: rows.length,
    pagination: {
      page: meta.pageReturned,
      limit: meta.limit,
      pages: meta.pages,
      total: meta.count,
    },
    rows,
    ...extra,
    source: 'RescueGroups.org v5 public API (https://api.rescuegroups.org/v5/public/docs)',
    raw: body,
  };
}

// ── Filters ────────────────────────────────────────────────────────────

interface Filter { fieldName: string; operation: string; criteria: unknown }

function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Build the `filterRadius` object for a distance search. Documented shape:
 * one of {lat,lon} / {coordinates} / {postalcode}, plus one of {miles} /
 * {kilometers}. Returns undefined when the caller asked for no distance
 * search, and throws when they asked for half of one — a location with no
 * radius silently returns unfiltered results otherwise, which looks like the
 * radius was honoured and ignored.
 */
function buildRadius(args: Record<string, unknown>, tool: string): Record<string, unknown> | undefined {
  const postalcode = args.postalcode as string | undefined;
  const lat = num(args.lat);
  const lon = num(args.lon);
  const miles = num(args.miles);
  const kilometers = num(args.kilometers);

  const hasLocation = Boolean(postalcode) || (lat !== undefined && lon !== undefined);
  const hasDistance = miles !== undefined || kilometers !== undefined;

  if (!hasLocation && !hasDistance) return undefined;

  // Half a coordinate pair is its own mistake and gets its own message — it
  // would otherwise fall into the generic "no location" branch below, which
  // sends the caller looking for a missing argument they actually supplied.
  if (lat !== undefined && lon === undefined) {
    throw new Error(`RescueGroups ${tool}: \`lat\` needs \`lon\` alongside it (or use \`postalcode\`).`);
  }
  if (lon !== undefined && lat === undefined) {
    throw new Error(`RescueGroups ${tool}: \`lon\` needs \`lat\` alongside it (or use \`postalcode\`).`);
  }

  if (!hasLocation) {
    throw new Error(
      `RescueGroups ${tool}: a radius was given but no location. Add \`postalcode\` (US/Canadian zip) or both \`lat\` and \`lon\`.`,
    );
  }
  if (!hasDistance) {
    throw new Error(
      `RescueGroups ${tool}: a location was given but no radius. Add \`miles\` or \`kilometers\` — RescueGroups needs both, and without a radius it would return unfiltered results that look location-filtered.`,
    );
  }
  if (miles !== undefined && kilometers !== undefined) {
    throw new Error(`RescueGroups ${tool}: pass either \`miles\` or \`kilometers\`, not both — the returned \`distance\` field uses whichever unit you gave.`);
  }
  const radius: Record<string, unknown> = {};
  if (lat !== undefined && lon !== undefined) {
    radius.lat = lat;
    radius.lon = lon;
  } else {
    radius.postalcode = postalcode;
  }
  if (miles !== undefined) radius.miles = miles;
  else radius.kilometers = kilometers;

  return radius;
}

function paging(args: Record<string, unknown>, tool: string, maxLimit = 250) {
  const limit = num(args.limit);
  const page = num(args.page);
  if (limit !== undefined && (limit < 0 || limit > maxLimit)) {
    throw new Error(`RescueGroups ${tool}: \`limit\` must be between 1 and ${maxLimit} (0 returns counts only); got ${limit}.`);
  }
  if (page !== undefined && page < 1) {
    throw new Error(`RescueGroups ${tool}: \`page\` starts at 1; got ${page}.`);
  }
  return { limit, page };
}

// ── Tools ──────────────────────────────────────────────────────────────

async function adoptable(args: Record<string, unknown>, apiKey: string) {
  const tool = 'rescuegroups_adoptable';
  const { limit, page } = paging(args, tool);

  const species = args.species as string | undefined;
  if (species && !SPECIES.includes(species as (typeof SPECIES)[number])) {
    throw new Error(
      `RescueGroups ${tool}: "${species}" is not a species RescueGroups lists. It spells them plural and lower-case — try "dogs", "cats", "rabbits", "horses", or call rescuegroups_species for the full list.`,
    );
  }

  // Views stack in the URL path: /search/available/dogs/haspic/
  const views: string[] = [args.include_adopted ? 'adopted' : 'available'];
  if (species) views.push(species);
  for (const v of (args.views as string[] | undefined) ?? []) {
    if (!TRAIT_VIEWS.includes(v as (typeof TRAIT_VIEWS)[number])) {
      throw new Error(`RescueGroups ${tool}: "${v}" is not a valid view. Valid views: ${TRAIT_VIEWS.join(', ')}.`);
    }
    views.push(v);
  }

  const filters: Filter[] = [];
  const add = (fieldName: string, operation: string, criteria: unknown) => filters.push({ fieldName, operation, criteria });

  if (args.breed) add('animals.breedString', 'contains', args.breed);
  if (args.sex) add('animals.sex', 'equal', args.sex);
  if (args.age_group) add('animals.ageGroup', 'equal', args.age_group);
  if (args.size_group) add('animals.sizeGroup', 'equal', args.size_group);
  if (args.name) add('animals.name', 'contains', args.name);
  if (args.good_with_kids === true) add('animals.isKidsOk', 'equal', true);
  if (args.good_with_dogs === true) add('animals.isDogsOk', 'equal', true);
  if (args.good_with_cats === true) add('animals.isCatsOk', 'equal', true);

  const radius = buildRadius(args, tool);

  const orgId = args.org_id as string | undefined;
  const path = orgId
    ? `/public/orgs/${encodeURIComponent(orgId)}/animals/search/${views.map(encodeURIComponent).join('/')}/`
    : `/public/animals/search/${views.map(encodeURIComponent).join('/')}/`;

  // Filters and filterRadius only exist in a POST body; a plain listing is a
  // cheaper GET. Views work on both.
  const needsPost = filters.length > 0 || radius !== undefined;

  const body = needsPost
    ? {
        data: {
          ...(filters.length ? { filters } : {}),
          ...(radius ? { filterRadius: radius } : {}),
        },
      }
    : undefined;

  const parsed = await rgRequest({
    path,
    tool,
    apiKey,
    query: {
      limit,
      page,
      sort: args.sort as string | undefined,
      include: 'breeds,orgs,pictures,species,locations',
    },
    body,
  });

  return shape(parsed, {
    query: {
      views,
      filters: filters.length ? filters : undefined,
      radius,
      org_id: orgId,
    },
  });
}

async function animal(args: Record<string, unknown>, apiKey: string) {
  const tool = 'rescuegroups_animal';
  const id = args.animal_id as string | undefined;
  if (!id) throw new Error(`RescueGroups ${tool} requires an \`animal_id\` — the \`id\` field from a rescuegroups_adoptable row.`);

  const parsed = await rgRequest({
    path: `/public/animals/${encodeURIComponent(id)}`,
    tool,
    apiKey,
    query: { include: 'breeds,colors,patterns,species,statuses,orgs,pictures,videourls,locations' },
  });

  const shaped = shape(parsed);
  if (shaped.rows.length === 0) {
    throw new Error(
      `RescueGroups ${tool}: no animal with id "${id}". RescueGroups removes listings once an animal is adopted or the rescue withdraws it, so an id from an older search may simply be gone.`,
    );
  }
  return { animal: shaped.rows[0], source: shaped.source, raw: parsed };
}

async function organizations(args: Record<string, unknown>, apiKey: string) {
  const tool = 'rescuegroups_organizations';
  const { limit, page } = paging(args, tool);

  const orgId = args.org_id as string | undefined;
  if (orgId) {
    const parsed = await rgRequest({ path: `/public/orgs/${encodeURIComponent(orgId)}`, tool, apiKey });
    const shaped = shape(parsed);
    if (shaped.rows.length === 0) throw new Error(`RescueGroups ${tool}: no organization with id "${orgId}".`);
    return { organization: shaped.rows[0], source: shaped.source, raw: parsed };
  }

  const filters: Filter[] = [];
  if (args.name) filters.push({ fieldName: 'orgs.name', operation: 'contains', criteria: args.name });
  if (args.state) filters.push({ fieldName: 'orgs.state', operation: 'equal', criteria: args.state });
  if (args.city) filters.push({ fieldName: 'orgs.city', operation: 'equal', criteria: args.city });

  const radius = buildRadius(args, tool);

  // `rescue` and `shelter` are the only documented org views. RescueGroups
  // requires a view name in the search path, so with no type filter we ask for
  // both by falling back to a filter-only search on the plain listing route.
  const type = args.type as string | undefined;
  const path = type ? `/public/orgs/search/${encodeURIComponent(type)}/` : '/public/orgs/';
  const needsPost = filters.length > 0 || radius !== undefined;

  if (needsPost && !type) {
    // The bare listing route is GET-only, so a filtered search with no type
    // needs a view. `rescue` and `shelter` between them cover every org, but
    // they cannot be stacked (they would AND to nothing), so ask for both and
    // merge.
    const both = await Promise.all(
      ['rescue', 'shelter'].map((v) =>
        rgRequest({
          path: `/public/orgs/search/${v}/`,
          tool,
          apiKey,
          query: { limit, page, sort: args.sort as string | undefined },
          body: { data: { ...(filters.length ? { filters } : {}), ...(radius ? { filterRadius: radius } : {}) } },
        }),
      ),
    );
    const merged = both.flatMap((b) => shape(b).rows);
    const total = both.reduce((n, b) => n + (typeof b.meta?.count === 'number' ? (b.meta.count as number) : 0), 0);
    return {
      count: total,
      returned: merged.length,
      pagination: { page: page ?? 1, limit, pages: undefined, total },
      rows: merged,
      query: { views: ['rescue', 'shelter'], filters: filters.length ? filters : undefined, radius },
      note: 'RescueGroups requires a view on a filtered org search, so rescues and shelters were fetched separately and merged; `pages` is therefore not meaningful. Pass `type` to page a single view.',
      source: 'RescueGroups.org v5 public API (https://api.rescuegroups.org/v5/public/docs)',
      raw: both,
    };
  }

  const parsed = await rgRequest({
    path,
    tool,
    apiKey,
    query: { limit, page, sort: args.sort as string | undefined },
    body: needsPost ? { data: { ...(filters.length ? { filters } : {}), ...(radius ? { filterRadius: radius } : {}) } } : undefined,
  });

  return shape(parsed, { query: { view: type, filters: filters.length ? filters : undefined, radius } });
}

async function species(args: Record<string, unknown>, apiKey: string) {
  const tool = 'rescuegroups_species';
  const { limit, page } = paging(args, tool);
  const parsed = await rgRequest({
    path: '/public/animals/species/',
    tool,
    apiKey,
    query: { limit: limit ?? 250, page },
  });
  return shape(parsed);
}

async function breeds(args: Record<string, unknown>, apiKey: string) {
  const tool = 'rescuegroups_breeds';
  const { limit, page } = paging(args, tool, 10000);

  const sp = args.species as string | undefined;
  if (sp && !SPECIES.includes(sp as (typeof SPECIES)[number])) {
    throw new Error(
      `RescueGroups ${tool}: "${sp}" is not a species RescueGroups lists. Try "dogs" or "cats", or call rescuegroups_species for the full list.`,
    );
  }

  const parsed = await rgRequest({
    path: sp ? `/public/animals/breeds/search/${encodeURIComponent(sp)}/` : '/public/animals/breeds/',
    tool,
    apiKey,
    query: { limit: limit ?? 250, page },
  });
  return shape(parsed, { species: sp });
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const apiKey = args._apiKey as string | undefined;
  // Drop the key from `args` immediately so nothing downstream can echo it
  // back in an error message or a usage record.
  delete args._apiKey;

  if (!apiKey || !apiKey.trim()) {
    throw new Error(MISSING_KEY_MESSAGE);
  }

  switch (name) {
    case 'rescuegroups_adoptable':
      return adoptable(args, apiKey);
    case 'rescuegroups_animal':
      return animal(args, apiKey);
    case 'rescuegroups_organizations':
      return organizations(args, apiKey);
    case 'rescuegroups_species':
      return species(args, apiKey);
    case 'rescuegroups_breeds':
      return breeds(args, apiKey);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
