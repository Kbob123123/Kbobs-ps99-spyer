# PS99 Pet Spyer

Tracks **Pet Simulator 99 pets** in Discord: hourly hatch rates by tier, RAP
swings, and hatch-rate spikes and drops.

Data source: the [PS99 public API](https://github.com/BIG-Games-LLC/ps99-public-api-docs)
(`/api/exists`, `/api/rap`, `/api/collection/Pets`) — no API key needed.

## What changed in 2.0

This was a full rewrite. The bot is now **pet-only** — everything clan- and
league-shaped moved to the sibling [ps99-clan-bot](../ps99-clan-bot) and
[ps99-league-bot](../ps99-league-bot) projects, which do it properly with
their own history, milestones, and player lookup.

Removed: `/clan`, `/clantop10`, `/league`, `/leaguetop10`, `/battle`, the clan
member tracker, clan inactivity alerts, Roblox game-update and new-gamepass /
dev-product watching, and per-alert ping roles. Nine setup commands collapsed
to **three**.

Two things are genuinely better, not just smaller:

**Exists alerts now measure the rate, not the count.** The old alert compared
a pet's cumulative exists count against its count 10 minutes earlier and fired
at 2x. For an established pet sitting at tens of millions of exists, that
ratio is unreachable — the alert could essentially never fire. It now compares
the **last hour's hatch rate** against the **previous six hours' average rate**,
which is the number that actually moves, and it catches **drops** as well as
spikes. A pet that suddenly stops being hatched is as interesting as one that
floods in.

**History survives restarts.** The old bot kept history in memory, so every
restart threw away all accumulated data and reset every rate to "gathering
data". History is now SQLite (`node:sqlite`, no native build), the same as the
sibling bots.

## Commands

| Command | Description |
|---|---|
| `/rap item:<name>` | Recent Average Price for an item or pet. Partial names work. Shows exists count alongside price. |
| `/pet name:<name>` | One pet: tier, rarity, every variant's exists + RAP, thumbnail, and 7-day history charts. |
| `/setratechannel tier:<huge\|titanic\|gargantuan> [channel:#channel]` | Where hourly hatch rates post for a tier. Omit the channel to turn it off. Requires "Manage Server". |
| `/setalertchannel type:<spikes\|rap> [channel:#channel]` | Where alerts post. Omit the channel to turn it off. Requires "Manage Server". |
| `/spyerconfig` | Current channel setup and how much history has been collected. |

## How the numbers work

**Hatch rates are exact, not estimated.** A rate is the difference between the
exists count now and the count exactly one hour ago, recalculated every 10
minutes. Rates only appear once a full hour of readings exists — expect up to
an hour of "collecting data" after a restart. That's deliberate: a partial
window would report a number that looks precise and is wrong.

**Rate spike/drop alerts run once an hour** and compare **this hour's hatch
rate against last hour's**. They fire at **2x or more** (spike) or **half or
less** (drop). Roughly 2 hours of history is needed before they can fire.
Pets hatching under 40/hour are skipped — a pet going from 1/h to 4/h is not
news.

Two properties of this design are worth knowing:

- **The hourly cadence is deliberate.** Both alert types compare windows
  measured in hours, so evaluating them on the 10-minute poll re-checked the
  same unchanged window six times an hour and re-sent the same alert each time.
  Firing hourly means one alert per genuine event.
- **Hour-over-hour is self-limiting.** Once a pet's rate settles at its new
  high, the next comparison is high-against-high (~1x) and the alerts stop. A
  long rolling baseline would keep firing for as long as the elevated rate
  stayed above the average.

**RAP alerts** fire when a value triples or falls to a third **within 24 hours**.
The comparison is against a day ago rather than the previous poll because
upstream RAP is cached for hours, so consecutive polls almost always show no
change at all.

Spike and RAP alerts cover **Titanic and Gargantuan only** — Huge pets hatch in
such volume that their alerts fire constantly and stop being signal. The hourly
rate *channels* still cover all three tiers.

## Storage

There are ~6,300 tiered pet variants. Storing all of them every 10 minutes
would be ~1 million rows per day, almost all identical to the row before.
Readings are therefore written **only when a value actually changes**.

This is lossless for everything the bot does, because every read is "the latest
reading at or before time T" — which returns the correct value whether or not a
row exists exactly at T. Charts draw a **stepped** line for the same reason: a
sloped line between two stored points would invent gradual drift that didn't
happen.

Pruning keeps the most recent reading at or before the cutoff for each pet, so
a pet whose count hasn't moved in weeks reads as *flat*, not as *missing*.

## Charts

Rendered locally with `chartjs-node-canvas` (no external service — the old
version used quickchart.io URLs).

Colours were chosen by running a palette validator against Discord's actual
dark surface (`#2b2d31`), not by eye. Worth knowing if you ever change them:
the obvious tier ramp of **gold → orange → red fails** accessibility checks —
orange↔gold sit at normal-vision ΔE 4.8 and red↔gold at 13.0, both under the
15 floor, meaning even full-colour-vision readers struggle to tell them apart.
The shipped ramp is **gold → magenta → violet** (worst pair ΔE 19.3), which
passes every check and still reads as escalating rarity.

Exists and RAP are never drawn on one pair of axes. They're different measures
on different scales, and twin y-axes would let the lines cross wherever the two
scales happened to land — a relationship that is pure artefact. `/pet` renders
them as two separate charts.

**Don't delete `assets/fonts/`.** Minimal Linux containers often ship with no
fonts at all, which renders every chart label as an empty box.

## Local setup

**Requires Node.js 22.5.0 or newer** (uses the built-in `node:sqlite` module —
no native compilation for the database).

```bash
npm install
cp .env.example .env
# fill in DISCORD_TOKEN and DISCORD_CLIENT_ID
npm run deploy-commands
npm start
```

`npm run deploy-commands` runs `npm run lint-commands` first, which checks every
command and option description against Discord's 100-character limit before
anything is sent. This exists because an oversized description once crashed the
sibling league bot on every startup — `SlashCommandBuilder` validates length at
module-load time, before any error handling can catch it.

Bot permissions needed: **Send Messages**, **Embed Links**, **Attach Files**.
No privileged intents.

## Deploying to Railway

1. Push to GitHub, then **New Project → Deploy from GitHub repo**.
2. Add a **Volume** mounted at `/data`.
3. Set `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DB_PATH=/data/spyer.db`.
4. Deploy, then run `npm run deploy-commands` once from a Railway shell.

**Don't delete `nixpacks.toml`.** It installs the cairo/pango/freetype/
fontconfig chain that `canvas` dlopen()s at require() time. Without it the bot
crashes on startup with `ERR_DLOPEN_FAILED` even though `npm install` succeeded
— see that file's comments for the specific errors it prevents.

## Known issues

- **Font registration fails on Windows.** `canvas` 3.x doesn't pick up the
  bundled DejaVu font on Windows and falls back to a system font, so charts
  render with slightly different type locally. Layout and data are unaffected,
  and Linux/Railway (where `nixpacks.toml` supplies fontconfig) is fine.
- Charts cover the last 7 days; history is retained for 30.
