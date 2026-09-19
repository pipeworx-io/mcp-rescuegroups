# @pipeworx/rescuegroups

Adoptable animals listed by rescues and shelters on RescueGroups.org, and the
organizations themselves — name, breed, age, sex, size, temperament flags,
photos, adoption fee, and the rescue's contact details, adoption process and
areas served. Searchable by species, postal-code radius, breed and trait.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1576+ live data sources.

## Tools

- `rescuegroups_adoptable(species?, postalcode?, lat?, lon?, miles?, kilometers?, breed?, sex?, age_group?, size_group?, name?, good_with_kids?, good_with_dogs?, good_with_cats?, views?, org_id?, include_adopted?, sort?, limit?, page?, _apiKey)` —
  the main search. Answers "adoptable beagles within 50 miles of 15206",
  "cats good with kids in Pittsburgh", "dogs needing a foster". Returns the
  animal's full attribute set with breeds, pictures, species and listing
  organization resolved inline.
- `rescuegroups_animal(animal_id, _apiKey)` — one animal in full, with every
  picture, colour, pattern, status and the listing org.
- `rescuegroups_organizations(postalcode?, lat?, lon?, miles?, kilometers?, name?, state?, city?, type?, org_id?, sort?, limit?, page?, _apiKey)` —
  rescues and shelters. Answers "shelters within 25 miles of me", "who is
  RescueGroups org 1234".
- `rescuegroups_species(limit?, page?, _apiKey)` — the species vocabulary, which
  is what `rescuegroups_adoptable`'s `species` argument expects.
- `rescuegroups_breeds(species?, limit?, page?, _apiKey)` — breeds per species,
  for building an exact breed filter.

## Auth

**BYO-key only.** Pipeworx holds no RescueGroups key and this pack never reads a
platform one — `_apiKey` is `required` in every tool's input schema, so the
gateway's disclosure surface tells a caller before the call, not after a
refusal.

Request a free public key at
<https://rescuegroups.org/services/request-an-api-key/>. It is a short form
(name, email, organisation, site URL, which species and whether you want a
national search). It is open to individual developers — "not incorporated" is an
accepted incorporation status, and the API docs state plainly that you do *not*
need a RescueGroups account, only a public key. Staff review the form and email
the key back, so it is **not instant self-serve**; the refusal message says so
rather than promising a key in one click.

> Note for anyone reading `docs/paid-upgrade-watchlist.md`: its entry filing
> RescueGroups under "signup not obtainable by a normal dev — requires being an
> animal rescue with a vet, shelter, euthanasia policy" describes the *partner
> onboarding* at `/partner-requirements-and-expectations/`, which is how a
> rescue gets its animals **listed**. The public **API key** form is a different,
> open one. That entry has been corrected.

## Data source

- <https://api.rescuegroups.org/v5> — RescueGroups.org v5 public API, JSON:API
  over HTTPS. Full reference (unauthenticated, readable without a key):
  <https://api.rescuegroups.org/v5/public/docs>

## Things the next person would otherwise rediscover the hard way

**An invalid key is a silent zero, not an error.** Probed live 2026-09-05:

```
GET /v5/public/animals/search/available/dogs/?limit=1     (no Authorization)
  -> 401 application/vnd.api+json
     {"errors":[{"status":401,"source":{"header":"Authorization"},
       "title":"Missing authorization header",
       "detail":"Missing authorization header - apikey authentication required"}]}

GET /v5/public/animals/search/available/dogs/?limit=1     (Authorization: <junk>)
  -> 200 OK, Content-Length: 0, Content-Type: text/plain;charset=UTF-8
```

A *rejected* key returns **HTTP 200 with a completely empty body**, not a 401 —
and it does so whether or not the required `Content-Type` header is present
(checked both ways; the empty 200 is not an artefact of omitting it). Passed
through naively that reads as "there are no adoptable dogs near you", which is
both wrong and unfixable by the user because nothing points at their key. This
pack therefore treats any empty non-JSON 200 as an auth failure and says so.
See `docs/silent-zero-policy.md`.

Consequently the three states a caller can be in read differently, on purpose:

| State | What they see |
|---|---|
| No `_apiKey` at all | "RescueGroups requires an API key, and Pipeworx does not supply one." + where to request one |
| `_apiKey` rejected upstream | "the API key you passed as `_apiKey` was not accepted" + how RescueGroups signals it + key-scoping caveat |
| Upstream 401 with a key sent | "authorization failed (HTTP 401)" + the upstream's own detail |

**The key never leaves the Authorization header.** It is not put in a URL (a URL
is logged by every hop whether or not the call succeeds), it is deleted from
`args` before any handler runs so it cannot reach a usage record, and every
string relayed from upstream is passed through a redactor first — so even if
RescueGroups started quoting the key back in an error `detail`, the caller-facing
message would not carry it. Verified by a test that plants a recognisable secret
and asserts it appears in none of the URL, body, result or error paths.

**Keys are scoped at issue time.** The request form asks which species and
whether you want just your own organization or a national search. A key issued
narrowly returns fewer rows — or none — for a query outside its scope, which
looks identical to a genuinely empty result. The rejected-key message names this
possibility so a caller with a legitimately narrow key is not sent chasing a
bad-key theory.

**`Content-Type: application/vnd.api+json` is required on every request,
including GETs**, per the docs. Sent unconditionally here.

**Views stack in the URL path, filters go in a POST body.** `available`,
species (`dogs`), and traits (`haspic`, `urgent`, `isneedingfoster`) are
"views" and concatenate: `/public/animals/search/available/dogs/haspic/`.
Anything else — breed, sex, size, postal-code radius — is a `filters` /
`filterRadius` object POSTed to the same search URL. The pack picks GET or POST
based on whether the caller supplied anything needing a body.

**Distance searches need a location *and* a radius.** Half of one is rejected
locally rather than sent, because RescueGroups silently returns unfiltered
results for a location with no radius, which looks like the radius was honoured.

**Org search with no `type` needs two calls.** `rescue` and `shelter` are the
only org views, a filtered org search requires a view in the path, and the two
cannot be stacked (they would AND to nothing). With no `type` the pack queries
both and merges, and says so in a `note` — `pages` is not meaningful on that
path, so pass `type` if you need to page.

**Null attributes are omitted, not nulled** (v5 change log, 2019-10-03), and the
field set grows over time. The response mapper is deliberately generic — it
flattens JSON:API `attributes` wholesale and resolves `relationships` against
`included` one level deep — rather than listing fields, so new upstream fields
appear instead of being silently dropped. `raw` always carries the untouched
body.

**Rate limits are unpublished.** The docs say only that the API returns 429 for
"an abnormal number of requests" and asks callers to cache reference data. Cache
`rescuegroups_species` and `rescuegroups_breeds`; they change rarely.

**There is a test environment** at `test1-api.rescuegroups.org` with the same
routes, but it also requires a key, and its data may be weeks stale and may not
be used in production. Not wired up here.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "rescuegroups": {
      "url": "https://gateway.pipeworx.io/rescuegroups/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/rescuegroups/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1576+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

This pack takes your own API key (`_apiKey`) — we don't front one for it, so there's no curl here that would run without it. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/rescuegroups_adoptable`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "rescuegroups": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-rescuegroups"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-rescuegroups
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Rescuegroups data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
