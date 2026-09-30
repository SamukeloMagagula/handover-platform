# Onsite Call Book

Who is reachable, where they are, and who has been called. A standby and
on-site roster for a support team: it says who is on cover today, holds every
way of reaching them in the order to try them, records what happened when
somebody rang, and shouts when a night has nobody on it.

**Architecture:** a static HTML/CSS/vanilla-JS frontend talking to a single
JSON API (`api.php`). PHP's only job is `api.php` plus the library files it
requires (`auth.php`, `db.php`, `helpers.php`, `validation.php`,
`config.php`) — every page you actually navigate to (`login.html`,
`app.html`, `install.html`, `index.html`) is a plain static file with no
server-side rendering. Data lives in MariaDB. No framework, no build step,
no Composer.

## Roles

A role is a list of capabilities, and the API checks the capability rather
than the role name — so inventing a role is a matter of adding an entry to the
`ROLES` array at the top of `auth.php`. Enforcement is on the server, on every
request. The page also hides controls a role has not got, but that is only so
nobody is offered work that would be refused; it stops nobody who means it.

- **superadmin** — everything, including handing out accounts and clearing the roster.
- **admin** — run the roster: people, duties, sites, rotations, escalation.
- **lead** — a shift leader: everything an editor can do, plus signing off
  somebody else's handover and posting the shift report. Deliberately short of
  admin — running the roster and handing out accounts are a different job.
- **editor** — log calls, arrange cover, leave a handover, fix a note. Cannot
  add or remove people.
- **viewer** — read only: who is on, their numbers, the reports, and the
  handover. Reading what to look out for is not a privilege.

`super_admins` in `config.php` names accounts that are superadmin whatever role
the `users` table stores against them, checked on every request. An entry is
either a whole address (`owner@example.com`) or just the name before the `@`
(`owner`), which matches that name on any domain.
It raises an existing account rather than creating one, so the address still
needs a real row to sign in with. Accounts on that list show a **config** badge
in the Accounts tab and their role and status cannot be edited there — the file
would override the change, so the form refuses it rather than reporting a
success that did nothing. It is the way back in when the database ends up with
no administrator, which is why it lives somewhere that needs server access.

## Setup

1. **Create the database.** Run the schema against MariaDB:
   ```
   mysql -u root -p < db/schema.sql
   ```
   The same file builds a new database and upgrades an existing one, and is
   safe to run again — do it after every deployment, since the `UPGRADES`
   section at its foot is what applies changes to tables that already exist.

   This creates the `callbook` database and its tables, and seeds the meta
   rows — the roster version, the team calendar key, and a 24-month retention
   window. No account is seeded and there is deliberately no default password.

   Then create the account the app connects as. Do not let it connect as root,
   and do not grant it DDL — the app never creates or alters a table:
   ```
   CREATE USER 'callbook'@'localhost' IDENTIFIED BY 'a-real-password';
   GRANT SELECT, INSERT, UPDATE, DELETE ON callbook.* TO 'callbook'@'localhost';
   FLUSH PRIVILEGES;
   ```

2. **Copy `config.php.example` to `config.php`** and set your database
   credentials (host, port, name, user, password). The same file holds the
   HTTPS, proxy, session-timeout, two-factor and notification settings — every
   value is commented in place.

   **`mfa_key` is required**, and nobody can sign in without it — every sign-in
   needs a second factor, and that key is what the stored authenticator keys are
   encrypted with:

   ```
   openssl rand -hex 32
   ```

   Back it up with `config.php`. Changing it invalidates every enrolled
   authenticator and every unused recovery code, so everybody re-enrols; losing
   it does the same.

3. **Point your web server's document root at the project folder itself.**
   On Apache, the included `.htaccess` redirects to HTTPS, sets the security
   headers and Content-Security-Policy for the static pages, and blocks direct
   browser access to the PHP library files (`config.php`, `db.php`, `auth.php`,
   `helpers.php`, `validation.php`) since only `api.php` needs to load them.
   **nginx ignores `.htaccess` entirely** — the equivalent server block is in
   [DEPLOY.md](DEPLOY.md), and you have to add it yourself.

4. **Run first-time setup.** Visit `install.html` in your browser to create the
   first superadmin account. This only works once — the underlying
   `api.php?action=install` call permanently refuses as soon as any account
   exists, so it is safe to leave deployed.

5. **Log in** as that superadmin at `login.html`. The first thing it asks for is
   an authenticator: scan the QR code, enter the six digits, and **write down
   the ten recovery codes it then shows once** — for the first account there is
   nobody else who can reset it. Then use **Accounts** to add everybody else,
   and **Add person** to fill the Directory.

**Before anybody signs in, turn on HTTPS.** Until it is done the password and
the session cookie cross the network readable by anything in between, and both
the sign-in page and the roster say so in red across the top. The certificate,
nginx and reverse-proxy detail is all in [DEPLOY.md](DEPLOY.md), along with
cron, retention and backup.

## How it works

- **Accounts are not people.** A `users` row is somebody who can open the app;
  a `people` row is somebody the roster can send out or ring. Most staff are
  only ever the second and need no account at all.
- **Duties** are date ranges: a person is on `standby` (reachable by phone) or
  `onsite` (deployed to a named site) from a first day to a last day. Overlaps
  are allowed on purpose — two people can be on standby the same night.
- **Cover** is an override sitting on top of a duty. The duty stays the record
  of whose rotation it is; the override says who is actually reachable on those
  days, which is why regenerating a rotation cannot wipe an arrangement
  somebody made by hand.
- **Rotations** turn a repeating pattern into real duty rows, so everything
  else in the app keeps working on duties and knows nothing about rotations.
  Turns are counted from the rotation's own start date, so who is up next does
  not change just because it was regenerated on a different day. Regenerating
  deletes only the future duties that rotation wrote.
- **Leave** marks somebody unavailable. It never removes cover on its own — the
  roster warns instead, because deleting a duty when somebody books leave is
  how a night ends up with nobody on it.
- **Escalation** is who to try after the person on duty does not answer, per
  site, falling back to a default chain. The unanswered-call job uses the same
  chain, so the roster and the notifier can never disagree about it.
- **Calls** record who was rung, when, by whom, how it went and what to pass
  on. `logged_at` and `answered_at` are stamped by the server, never by the
  browser, so a time-to-answer figure survives being asked where it came from.
- **Concurrency is a version number, not a lock.** `meta.roster_version`
  increments on every successful write. The browser sends the version it last
  read; if the roster has moved on, the server returns **409** with the current
  state instead of writing, and the browser reloads and says to redo the
  change. Two people editing at once get told rather than silently overwriting
  each other. Each sync runs in one transaction with `SELECT … FOR UPDATE` on
  the version row, so either every operation in a change set lands or none does.
- **Polling, not websockets.** Browsers ask `?action=version` every 15 seconds
  and reload when it moves, so somebody else's change appears within about that
  long.
- **The audit log is written only by the server**, inside the same transaction
  as the change it describes. The API exposes no way to edit or delete a row
  and the browser never sends one. Undo appears as its own `Undid: …` entry
  rather than removing the entry it reverses. `who` comes from the session —
  the account that signed in with a password — and never from anything the
  browser sends. A change set's label is the browser's own description, so the
  server appends a tally counted from the operations it actually applied
  (`… [duties +2, overrides -1]`): an entry cannot say one thing while the
  transaction did another. Newlines are stripped from every entry, because one
  that can render as several lines can be made to look like a record of
  something that never happened.
- **Taking a copy is recorded.** The call history and the directory are
  exported by the server, not assembled in the browser, so every copy of
  everyone's numbers that leaves the system leaves an audit row naming who
  took it and how much. It cannot stop somebody reading numbers off the
  screen — nothing can — but the ordinary way of taking a copy is the recorded
  way. This is the POPIA question in [DEPLOY.md](DEPLOY.md) made answerable.
- **Calendar subscriptions** hand each person a feed Outlook can subscribe to,
  authorised by an unguessable key in the URL rather than a header, because
  Outlook cannot be made to send one. **Each link is a password.** Keys are
  128 bits from the system's own random source, and **Calendar links** rotates
  or revokes any of them — the thing to do when somebody leaves or a link goes
  astray. Rotating breaks every subscription to the old link, which is the
  point. The one the schema seeds the team feed with comes from MySQL's
  `UUID()`, which is the clock and a MAC address rather than randomness, so
  rotate it once after installing.
- **Every sign-in needs a second factor.** Standard TOTP — six digits from any
  authenticator app, no code sent by the system, nothing needed from the phone
  but its clock. This is the same model as its sibling system, Database
  Administration, down to the file it lives in (`mfa.php`), because two systems
  that disagree about how a second factor works are two systems somebody has to
  reason about twice.

  - **Nobody opts in, and nobody can opt out.** An account with no
    authenticator sets one up at its next sign-in, by scanning a QR code, and
    cannot get past that page without one. A signed-in session has already
    passed the second factor, which is why the app offers no switch for it.
  - **The key is proved before it is stored.** Enrolment holds it in the
    session until the app has produced a working code from it, so a scan
    somebody abandoned leaves the account exactly as it was.
  - **Keys are encrypted at rest** with `mfa_key` from `config.php`
    (AES-256-GCM), and recovery codes are stored as keyed HMACs. Read access to
    the `mfa` tables alone reveals neither.
  - **A code is accepted once.** `last_step` only ever moves forward, in a
    conditional `UPDATE` that must affect exactly one row, so two requests
    racing with the same code cannot both win.
  - **Ten single-use recovery codes** come with enrolment and are shown exactly
    once. Each is spent by a single indexed `UPDATE`.
  - **Five wrong codes** throws the half-finished sign-in away and sends the
    person back to their password.
  - A superadmin can **reset** a lost authenticator from Accounts. That does not
    turn the second factor off — there is no off — it forgets the authenticator
    so a new one is set up at the next sign-in. It leaves the password alone, so
    doing it does not hand over the account, and it is audited.

  The QR encoder (`assets/qr.js`) is copied from the same sibling system: this
  project takes no outside libraries and its CSP allows no CDN.
- **The handover** is the other half of the roster. The roster says who is
  reachable; the handover says what they are walking into.

  - **A handover item** is a ticket reference, a title, and what to look out
    for, at one of four priorities, either addressed to one person or left for
    whoever is on next. Anybody who can read the roster can read it.
  - **Acknowledging is the point.** "I have got this" turns a note somebody
    left into a thing somebody owns, and the count of unacknowledged items
    shows on the tab from every other view.
  - **Notes are append-only.** The thread on an item cannot be edited or
    deleted, because a record of what was passed on that somebody can quietly
    rewrite is not one.
  - **Nothing is deleted.** An item is closed, with who closed it and when, so
    "was this ever picked up" stays answerable weeks later — which is when
    somebody asks. Reopening clears the close but keeps the acknowledgement,
    because somebody did read it and that stays true.
  - **Shift reports** are the shift leader's write-up: what the team got
    through, what is still hanging over, and what would work better. The last
    is its own field rather than a paragraph in the middle of the first,
    because a suggestion buried in a status update is one nobody acts on. One
    report per shift per site per day, so re-posting corrects rather than
    duplicates.
  - **Every author and every timestamp is stamped by the server**, from the
    session, exactly as the audit log's `who` is. The browser sends the words
    and nothing else. This is why the handover has its own endpoints instead of
    going through `sync`, which takes whole rows and client-generated ids on
    trust — right for a roster the browser edits wholesale, wrong for a record
    whose entire value is that the server vouches for it.
- **Forgotten passwords** are self-service when `allow_password_reset` is on
  and `mail_from` is set — both, because without a way to send the link there
  is no way to tell the owner of an address from somebody who merely knows it.
  The link is one use, expires in an hour, and only its hash is stored. The
  form answers the same way whichever address is typed, so it cannot be used
  to find out who has an account.
- **Dormant accounts are visible.** Every sign-in stamps `last_login_at`, and
  the Accounts tab flags anything unused for 90 days and counts the accounts
  that have never been signed in to at all.
- **The caller's real address** is resolved through `trusted_proxies` in
  `config.php`. Behind a reverse proxy, `REMOTE_ADDR` is the proxy on every
  request: the per-IP sign-in lockout would then lock the whole company out
  when one attacker sprayed it, and every audit row would name the proxy
  instead of the person. `X-Forwarded-For` is read only when the connection
  itself came from a listed proxy, since anything that can reach the port can
  otherwise claim to be somebody else.
- **Strong passwords required everywhere one is set** — first-time setup, a
  superadmin creating an account, a superadmin resetting one, and a person
  changing their own: at least 10 characters with an uppercase letter, a
  lowercase letter, a number and a special character. A password a superadmin
  chose is flagged `must_change_password`, and the app forces it to be changed
  on first sign-in, because a password two people know is one the audit trail
  cannot honestly attribute.
- **The last active superadmin cannot be demoted or deactivated**, and nobody
  can deactivate their own account — either would leave nobody able to hand out
  accounts.
- **Retention** deletes call notes and finished duties older than
  `meta.retention_months` (default 24) and keeps the audit trail for twice as
  long, since it is the evidence the deletion happened and holds no call notes
  itself. See `bin/purge.php` and the POPIA note in [DEPLOY.md](DEPLOY.md).
- **Visual style** is the black/red devhub design system: a black masthead, red
  as the only signal colour, and a single light theme by intent so the UI stays
  the same on light and dark hosts alike.

## Project layout

```
db/schema.sql        Schema and upgrades — builds a new database, updates an old one
config.php           DB credentials, HTTPS/HSTS, proxies, sessions, 2FA, notifications (edit this)
db.php               app_config(), the PDO connection, and the caller's real IP
auth.php             Sessions, ROLES and capabilities, sign-in, reset tokens, CSRF, headers
mfa.php              The second factor: TOTP, encrypted keys, recovery codes
hub.php              The handover: items, their threads, and the shift reports
helpers.php          Business logic: roster state, who is on call, applying a change set, audit, CSV, mail
validation.php       Password strength rule
api.php              The entire backend - one JSON API, every action below

index.html           Asks the API who you are, redirects to app/login/install
install.html         One-time first superadmin setup
login.html           Sign in, the six-digit second factor, and first-time enrolment
forgot.html          Ask for a password reset link
reset.html           Choose a new password from a mailed link
app.html             The SPA shell - masthead, seven views and every dialog

assets/style.css     Styling (the eight old css/ files, cascade order preserved)
assets/api.js        Thin fetch() wrapper (CSRF handling, JSON in/out) used by every page
assets/qr.js         Self-contained QR encoder for authenticator setup (no CDN, no library)
assets/index.js      The redirect on the front door
assets/login.js      The sign-in card, the second factor, and enrolment
assets/forgot.js     Asking for a reset link
assets/reset.js      Setting the new password
assets/install.js    First-time setup
assets/app.js        All of app.html: the nine old js/ modules in dependency order

bin/notify.php       Cron: tomorrow's cover and gaps ahead, and unanswered calls
bin/purge.php        Cron: retention
```

## api.php actions

All under `api.php?action=<name>`. GET actions read; POST actions mutate and
require a `csrf_token` in the JSON body (fetch it once via `GET ?action=csrf`).
Everything needs a signed-in session except `csrf`, `me`, `login`, `logout`,
`install`, `signup` and `ical`.

| Action | Method | Who |
|---|---|---|
| `csrf` | GET | anyone |
| `me` | GET | anyone (reports auth state, whether the connection is encrypted, and whether setup has run) |
| `login`, `logout` | POST | anyone. A right password never signs anybody in — it returns `mfa: "verify"` or `mfa: "enroll"` |
| `login_mfa` | POST | anyone holding a half-finished sign-in — the six digits, or a recovery code |
| `login_enrol` | POST | the same, for an account with no authenticator yet |
| `forgot`, `reset` | POST | anyone, and only when `allow_password_reset` is on with a `mail_from` set |
| `install` | POST | anyone (only until the first account exists) |
| `signup` | POST | only when `allow_signup` is on and setup has run; the email must match `signup_domain`. Creates a `viewer`, and goes to enrolment rather than signing in |
| `change_password` | POST | signed in |
| `bootstrap`, `version` | GET | `roster.read` |
| `hub` | GET | `handover.read` |
| `handover_save`, `handover_ack`, `handover_note`, `handover_status` | POST | `handover.write`; editing or closing somebody else's also needs `handover.manage` |
| `shift_report_save` | POST | `shift.report` |
| `oncall` | GET | `roster.read` |
| `sync` | POST | per operation, via `TABLE_CAPS` in `auth.php` |
| `log` | GET | `history.read` |
| `feeds` | GET | `data.export` |
| `export` | GET | `data.export` — `what=calls` or `what=directory`, written to the audit log |
| `feed_rotate`, `feed_revoke` | POST | `people.write` |
| `rotate` | POST | `rotations.write` |
| `ical` | GET | the feed key in the URL — no session |
| `admin_users` | GET | `users.write` |
| `admin_user_create`, `admin_user_update`, `admin_user_reset_password`, `admin_user_mfa_reset` | POST | `users.write` |

There was a `note` action that wrote whatever the browser sent straight into
the audit log, needing only `roster.read`. Nothing ever called it and an audit
trail any reader can write lines into is not one, so it has been removed
rather than narrowed.

`oncall` returns the standby and on-site people with every way of reaching them
in order, overrides applied, whoever is on leave flagged, and the escalation
chain behind them. It is the endpoint for a monitoring check, a Teams bot or a
wallboard:

```
GET api.php?action=oncall
GET api.php?action=oncall&day=2026-09-10
GET api.php?action=ical&key=…
```

## Licence

MIT — see [LICENSE](LICENSE). Use it, change it, ship it; keep the copyright
notice and expect no warranty.
