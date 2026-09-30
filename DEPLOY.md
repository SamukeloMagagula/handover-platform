# Deploying the Onsite Call Book

Static pages and one PHP API, MariaDB behind them, both on the same Linux
server. [README.md](README.md) covers what the app is and how it works; this
file is how to stand it up and keep it safe.

## Requirements

- PHP 7.4 or newer, with `pdo_mysql` and `mbstring`
- MariaDB 10.3 or newer
- Apache or nginx

## 1. The database

    mysql -u root -p < db/schema.sql

One file, both jobs: on an empty server it builds the database, on an existing
one it brings the schema up to date. Tables are created in dependency order so
the foreign keys resolve as they are declared, and every statement checks for
itself first — so running it twice does nothing the second time.

**Run it after every deployment.** Changes to tables that already exist live
in the `UPGRADES` section at the foot of the file, and that is the only thing
that applies them. Skipping it is how the code ends up asking for a column the
database has not got.

Then create the account the app uses. Do not let it connect as root, and do
not grant it DDL — the app never creates or alters a table:

    CREATE USER 'callbook'@'localhost' IDENTIFIED BY 'a-real-password';
    GRANT SELECT, INSERT, UPDATE, DELETE ON callbook.* TO 'callbook'@'localhost';
    FLUSH PRIVILEGES;

## 2. The files

Copy the whole folder into the document root, then:

    cp config.php.example config.php
    $EDITOR config.php              # database name, user, password

    chown -R root:www-data .
    chmod 640 config.php            # readable by PHP, by nobody else

Nothing in the app writes to disk, so no directory needs to be writable by
the web server.

## 3. The first account

Nobody can sign in until an account exists. There is deliberately no default
account and no default password.

Open **`install.html`** in a browser and create the first superadmin. That
page works exactly once: `api.php?action=install` refuses permanently as soon
as any account exists, so it is safe to leave deployed.

Everything after that is done in the app, under **Accounts** — add people,
change a role, deactivate somebody, reset a password. Accounts live in the
`users` table; there is no file to edit and nothing to restart.

**What each role may do is the `ROLES` array at the top of `auth.php`.** A
role is a list of capabilities; the API checks the capability, never the role
name, so inventing a role is a matter of adding an entry:

| Role | Can |
|---|---|
| `superadmin` | everything, including handing out accounts and clearing the roster |
| `admin` | run the roster — people, duties, sites, rotations, escalation |
| `editor` | log calls, arrange cover, fix a note; cannot add or remove people |
| `viewer` | read only: who is on, their numbers, the reports |

Enforcement is on the server, on every request. The page also hides controls a
role has not got, but that is only so nobody is offered work that would be
refused — it stops nobody who means it.

Two guards exist so nobody can lock everybody out: the last active superadmin
cannot be demoted or deactivated, and no account can deactivate itself.

### Permanent superadmins

`super_admins` in `config.php` is a list of email addresses that are superadmin
whatever the `users` table says:

    'super_admins' => ['owner@example.com'],

Checked on every request. It raises an account's powers rather than creating
one, so the address still needs a real row to sign in with. The Accounts tab
shows these accounts with a **config** badge and refuses to change their role
or status — the file would override the change anyway, so accepting it would
report a success that did nothing.

This is the intended way back in, and it needs shell access to the server
rather than a password. **If you are locked out** — every superadmin
deactivated by a database edit, say — add your address to that list, sign in,
and put the roles right from the Accounts tab. There is no recovery page, by
design.

Failing that, or if the account itself is deactivated, promote it directly:

    UPDATE users SET role = 'superadmin', is_active = 1 WHERE email = 'jsmith@example.com';

Sessions and their cookie are covered below, under **Cookies and sessions**.

## 4. HTTPS

Do this before anybody signs in. Until it is done, the password and the
session cookie cross the network readable by anything in between, and both
`login.html` and the roster say so in red across the top of the page.

**Get a certificate.** On an internet-facing host:

    apt install certbot python3-certbot-apache    # or -nginx
    certbot --apache -d callbook.example.co.za

On an internal host with no public DNS, use the company's internal CA — a
self-signed certificate works but every browser will warn, and people trained
to click through that warning are worse off than before.

**Apache** — the redirect, the security headers and the Content-Security-Policy
are in `.htaccess` already, and need `mod_rewrite` and `mod_headers`:

    a2enmod rewrite headers ssl
    systemctl restart apache2

Note that the pages are static files: Apache serves them without PHP ever
running, so `.htaccess` is what sets their headers. Under nginx that work has
to be done in the server block instead, or the pages go out bare.

**nginx** ignores `.htaccess` entirely. The whole thing has to go in the
server block:

    server {
        listen 80;
        server_name callbook.example.co.za;
        return 302 https://$host$request_uri;
    }

    server {
        listen 443 ssl http2;
        server_name callbook.example.co.za;
        root /var/www/callbook;
        index index.html;

        ssl_certificate     /etc/letsencrypt/live/callbook.example.co.za/fullchain.pem;
        ssl_certificate_key /etc/letsencrypt/live/callbook.example.co.za/privkey.pem;
        ssl_protocols       TLSv1.2 TLSv1.3;
        ssl_prefer_server_ciphers off;

        add_header Strict-Transport-Security "max-age=31536000" always;
        add_header X-Content-Type-Options    "nosniff" always;
        add_header Referrer-Policy           "same-origin" always;
        add_header X-Frame-Options           "DENY" always;
        add_header Permissions-Policy        "geolocation=(), microphone=(), camera=(), interest-cohort=()" always;

        # The pages are static, so nothing else will set this for them.
        # style-src has to allow inline: the roster sets a site's colour with a
        # style attribute in a hundred places.
        add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'" always;

        location ~ ^/(config|db|auth|mfa|hub|helpers|validation)\.php$ { deny all; }
        location = /config.php.example                         { deny all; }
        location ~ ^/bin/                                      { deny all; }
        location ~ /\.                                         { deny all; }
        location ~ \.(md|sql)$                                 { deny all; }

        location ~ \.php$ {
            include snippets/fastcgi-php.conf;
            fastcgi_pass unix:/run/php/php-fpm.sock;
        }
    }

**Behind a load balancer or reverse proxy** that terminates TLS, PHP sees a
plain HTTP request and would mark the cookie as not-Secure. Set
`'behind_proxy' => true` in `config.php` so it believes `X-Forwarded-Proto`.
Only with a proxy actually in front — that header can be sent by anyone, so
trusting it without one lets a plain request claim to be secure.

**Then list the proxy.** `trusted_proxies` takes plain addresses or CIDR, IPv4
and IPv6:

    'behind_proxy'    => true,
    'trusted_proxies' => ['10.0.0.7', '10.42.0.0/16'],

This governs two things: whether `X-Forwarded-Proto` is believed, and which
address the app treats as the caller's. Without it every request arrives as
the proxy's own address, and two things go wrong that are easy to miss:

- The per-IP lockout — 25 failed sign-ins in 15 minutes — counts the proxy,
  so **one attacker spraying passwords locks the whole company out**.
- Every row in the audit trail records the proxy, so "where did that change
  come from" has the same answer for everybody.

Leaving the list empty with `behind_proxy` on trusts whatever machine
connected. That is right only when nothing but the proxy can reach the port.
If anything else can, list the proxy.

**Check it** — from a machine that is not the proxy, sign in wrongly once and
look at the row it wrote:

    SELECT ip, tried_at FROM login_attempts ORDER BY tried_at DESC LIMIT 1;

That address should be the client's, not the proxy's. If it is the proxy's,
`trusted_proxies` does not yet include the proxy.

**Check it:**

    curl -sI http://your-server/index.html  | head -3   # 302 to https
    curl -sI https://your-server/index.html | grep -i strict-transport
    curl -sI https://your-server/index.html | grep -i content-security-policy
    curl -sI https://your-server/api.php?action=csrf | grep -i set-cookie
    # must show __Host-CALLBOOK, HttpOnly, Secure, SameSite=Lax

**HSTS is a one-way door.** Once a browser has seen that header it will refuse
plain HTTP to this host until it expires — a year, by default. Leave
`hsts_seconds` at 0 in `config.php` until certificate renewal has worked
at least once, then turn it up. Do not set `hsts_subdomains` unless *every*
subdomain of this host has TLS.

## Cookies and sessions

| | |
|---|---|
| Name | `__Host-CALLBOOK` over HTTPS, `CALLBOOK` otherwise |
| `HttpOnly` | yes — script cannot read it, so an XSS cannot steal it |
| `Secure` | whenever the request is HTTPS |
| `SameSite` | `Lax` — blocks cross-site POSTs, ordinary links still work |
| Lifetime | until the browser closes |
| Idle timeout | `session_idle_minutes`, default 8 hours |
| Hard timeout | `session_max_hours`, default 12 hours |

The `__Host-` prefix is a promise the browser enforces: Secure, path `/`, and
no `Domain`, so a sibling subdomain cannot overwrite the cookie. It only works
over HTTPS, which is why the name changes with the scheme — **moving to HTTPS
signs everybody out once**, by design.

Both timeouts exist because the page polls the server every fifteen seconds
while it is open. Idle alone would never fire on a tab left running, so the
hard limit is what eventually ends a session on a machine nobody is at.

`session.use_strict_mode` is on, so PHP refuses a session id it never issued —
that is what stops somebody planting an id in a link and waiting for it to be
signed in. The id is regenerated on sign-in, so anything captured beforehand
is useless.

On top of the cookie, **every POST carries a CSRF token** from
`?action=csrf`, checked with `hash_equals` before anything is written. The
`SameSite=Lax` cookie already blocks a cross-site POST; the token is the lock
that does not depend on the browser honouring it.

Deactivating an account takes effect on its **next request**, not whenever its
session happens to lapse: the account is read from the database on every
request rather than trusted from the session.

## 5. Blocking access to the secrets

`config.php` holds the database password. `db.php`, `auth.php`, `helpers.php`
and `validation.php` are includes, not endpoints — `api.php` is the only PHP
file a browser has any business fetching. The root `.htaccess` denies all of
them under Apache. **It does nothing under nginx** — use the `location` blocks
in the server block above instead.

Check it before going live. A plain-text database password served over HTTP
is the worst outcome here:

    curl -i http://your-server/config.php      # must not be 200 with content
    curl -i http://your-server/auth.php        # must not be 200 with content
    curl -i http://your-server/helpers.php     # must not be 200 with content

## 6. Check it works

    curl -s http://your-server/api.php?action=version
    # {"error":"Not signed in.","signedOut":true}

That 401 is the right answer: the API refuses everything without a session.
Then open the page in a browser — `index.html` should send you to
`login.html`. Sign in, and the roster loads.

Worth checking by hand once, because they are the things that fail quietly:

- **The conflict path.** Open the roster in two browsers, change something in
  each without reloading, and save the second. It must say somebody else got
  there first and reload, not overwrite.
- **The audit trail names the account.** Log a call, then **Data → History**.
  The entry must read `Their Name (email)`, never `Not named`.

## How writing works

Reads are ordinary queries. Writes all go through one endpoint:

    POST api.php?action=sync
    { "csrf_token": "…", "baseVersion": 41, "label": "Logged: Thabo K at 14:32", "ops": [ … ] }

`meta.roster_version` increments on every successful write. The browser sends
the version it last read; if the roster has moved on since, the server
returns **409** with the current state instead of writing. The browser then
reloads and tells the user to redo the change. Two people editing at once get
told rather than silently overwriting each other.

Each sync runs in one transaction with `SELECT … FOR UPDATE` on the version
row, so concurrent syncs serialise. Either every operation in a change set
lands or none of them does.

Browsers poll `?action=version` every 15 seconds and reload when it moves, so
a change made by one person appears on everyone else's screen within about
that long. There are no websockets.

## The audit trail

`audit_log` is written **only by the server**, inside the same transaction as
the change it describes. The API exposes no way to edit or delete a row, and
the browser never sends one. Undo appears as its own `Undid: …` entry rather
than removing the entry it reverses.

`who` is taken from the session — the account that signed in with a password
— and never from anything the browser sends. It records as
`Their Name (email)`. The cron scripts have no session and record as
`System`.

## Cron

    # 07:00 — who is on tomorrow, plus any gaps in the next fortnight
    0 7 * * *    php /var/www/callbook/bin/notify.php daily

    # every 10 minutes — calls logged and never answered
    */10 * * * * php /var/www/callbook/bin/notify.php unanswered

    # 03:00 on the 1st — retention
    0 3 1 * *    php /var/www/callbook/bin/purge.php

Set `teams_webhook` and/or `mail_from` in `config.php` first. With neither
configured the scripts print to stdout and cron mails it to you, which is a
reasonable way to check them before wiring anything up.

    php bin/notify.php daily          # prints what it would send
    php bin/purge.php --dry-run       # counts what it would delete

**Until these are in crontab, three things silently do not happen:** nobody is
told who is on tomorrow, nobody is told when a night has no cover, and nobody
is chased when a call goes unanswered. The app looks the same either way,
which is what makes it worth checking rather than assuming.

**The unanswered job needs an escalation chain to talk to.** Set one under
**Escalation** in the app — with an empty chain the job runs, finds nobody to
tell, and exits quietly.

And retention that is not scheduled is not retention: `bin/purge.php` is what
keeps call notes inside the window POPIA expects, and it only runs if cron
runs it.

## Endpoints other systems can use

    GET api.php?action=oncall              who is on today, with numbers
    GET api.php?action=oncall&day=2026-09-10
    GET api.php?action=ical&key=…          a calendar subscription

`oncall` returns the standby and on-site people with every way of reaching
them in order, overrides applied, whoever is on leave flagged, and the
escalation chain behind them. It is the endpoint for a monitoring check, a
Teams bot or a wallboard. It needs a signed-in session with `roster.read`.

The shape, so something else can be written against it:

    {
      "day": "2026-09-10",
      "covered": true,                     // false when nobody is on standby
      "standby": [ { "personId": "…", "person": { "name": "…", "role": "…",
                     "contacts": [ { "kind": "mobile", "value": "+27821234567" } ] },
                     "site": "", "coveringFor": null, "onLeave": false } ],
      "onsite":  [ … same shape … ],
      "escalation": [ { "afterMinutes": 15, "person": { … } } ],
      "generatedAt": "2026-09-10T06:00:00+02:00"
    }

`covered: false` is the one worth alerting on: it means the day has nobody on
standby at all. `contacts` is already in the order to try them, and numbers
are stored E.164, so a dialler can use them as they are.

`escalation` is whatever is set under **Escalation** in the app — an empty
array means no chain is configured, not that there is nobody to call.

`ical` is authorised by the unguessable key in the URL rather than a session,
because Outlook cannot send headers. **Each link is a password** — anyone
holding one can read that person's duties. Rotate one with:

    UPDATE people SET feed_key = REPLACE(UUID(),'-','') WHERE id = '…';

## On a phone

An ordinary page in the browser. It is not a PWA and has no service worker:
the roster lives on the server, so with no connection there is no roster to
show, and a cached shell would only have bought a stale copy of the app
talking to a newer API.

iOS can still put it on the home screen through Share → Add to Home Screen,
and it opens without browser chrome.

## Retention and POPIA

Call notes name identifiable staff and record what happened to them, which is
personal information. `bin/purge.php` deletes call notes and finished duties
older than `meta.retention_months` (default 24) and keeps the audit trail for
twice as long, since it is the evidence the deletion happened and holds no
call notes itself.

    UPDATE meta SET v = '12' WHERE k = 'retention_months';

Set it to whatever the business has actually agreed, and write that down
somewhere other than this file.

**Copies leaving the system are recorded.** The directory and the call history
are exported by the server rather than assembled in the browser, so each one
writes an audit row naming who took it and how many records it held:

    SELECT logged_at, who, what, ip FROM audit_log
     WHERE what LIKE 'Exported%' ORDER BY id DESC;

That is the answer to "who has had a full copy of everyone's personal numbers,
and when". It is not a control — anybody who can see the Directory can read
numbers off the screen, and no software prevents that — but it makes the
ordinary way of taking a copy the recorded way, and it means an unexplained
export is something you can find rather than something you have to assume
never happened.

**Calendar links are personal data too.** Each one lets its holder read where
somebody is expected to be for a year either way, with no sign-in. Rotate or
revoke them under **Calendar links** when somebody leaves; both are audited.

## Backup

Everything lives in the database, and the database is what gets backed up.
The app offers no backup or restore of its own — a second, partial copy taken
through the browser is a way to restore stale data over good data, and it is
not a backup strategy in any case.

    mysqldump --single-transaction callbook | gzip > callbook-$(date +%F).sql.gz

Run that on whatever schedule the business has agreed, keep it off this
server, and **test a restore** — a backup nobody has restored is a guess.
`--single-transaction` takes it without locking the roster, so it is safe to
run while people are using the app.

This covers accounts as well as the roster: `users` is in the same database.

## Known limits

- **No SSO.** Passwords here are separate from Windows or Microsoft 365, so
  they are one more thing to rotate when somebody leaves. Deactivating an
  account under **Accounts** signs them out on their next request.
- **Sign-in throttling is per account and per address**, 8 and 25 failures in
  15 minutes, plus a fixed 400ms delay on every attempt whether right or
  wrong, so the time taken does not reveal whether an account exists. The
  per-address half is only as good as `trusted_proxies` — see HTTPS above.
  Put a rate limiter in front as well if the app is internet-facing.
- **Self-service password reset is off by default.** Turning it on needs both
  `allow_password_reset` and a `mail_from` with a working MTA, because without
  a way to send the link there is no way to tell the owner of an address from
  somebody who merely knows it. Left off, a superadmin resets passwords under
  **Accounts** and the person is forced to change it on their next sign-in.
- **Two-factor is required, and cannot be turned off.** Every sign-in needs a
  code after the password; an account without an authenticator sets one up
  before it gets any further. There is no per-person exemption and no global
  switch. Plan for it: everybody needs a phone with an authenticator app on it
  before they next sign in, and **`mfa_key` must be in `config.php` and in your
  backups** — losing it locks the whole team out of their own authenticators.
  Somebody who loses their phone *and* their recovery codes needs a superadmin
  to reset their authenticator, which is audited.
- **The first account has no safety net.** There is nobody else to reset its
  authenticator, so the recovery codes it is shown at enrolment are the only way
  back in. Print them.
- **Last writer is refused, not merged.** Conflicting edits are rejected and
  the change is redone by hand. There is no field-level merge.
- **Sessions end when the browser closes**, so a shared control-room machine
  needs signing out by hand if the browser is left open.
- **The app shell is public.** `app.html` is a static file, so anybody can
  fetch its markup — labels, dialog structure, nothing more. Every byte of
  roster data comes from the session-gated API.
