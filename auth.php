<?php

declare(strict_types=1);

require_once __DIR__ . '/db.php';

/* For log_action: a recovery code being spent, or a password being reset
   through a mailed link, is a thing the audit trail has to know about at the
   moment it happens. helpers.php requires only db.php, so there is no cycle -
   and it stays loadable on its own, which is what the command-line scripts
   in bin/ do. */
require_once __DIR__ . '/helpers.php';

/* The second factor. Its own file, as in Database Administration: the codes,
   the encryption and the recovery codes are one subject, used by the sign-in
   flow and by the Accounts page, and they do not belong inside the session
   and capability code. */
require_once __DIR__ . '/mfa.php';

const ROLES = [

    'superadmin' => [
        'roster.read',      // see the roster at all
        'calls.write',      // log a call, change an outcome, edit a note
        'duties.write',     // add, edit and remove duties, and arrange cover
        'people.write',     // add, edit and remove people, contacts and leave
        'sites.write',      // add, rename and remove sites, set escalation
        'rotations.write',  // define rotations and generate duties from them
        'reports.read',     // the Reports tab
        'history.read',     // the audit trail
        'data.export',      // export CSV, see the calendar links
        'users.write',      // the Accounts tab: who may sign in, and as what
        'handover.read',    // the Handover tab
        'handover.write',   // leave a handover, add a note, acknowledge one
        'handover.manage',  // close or reopen somebody else's handover
        'shift.report',     // post the shift report
    ],

    'admin' => [
        'roster.read',
        'calls.write',
        'duties.write',
        'people.write',
        'sites.write',
        'rotations.write',
        'reports.read',
        'history.read',
        'data.export',
        'handover.read',
        'handover.write',
        'handover.manage',
        'shift.report',
    ],

    /* The shift leader. Everything an editor can do, plus the two things that
       are theirs by definition: signing off somebody else's handover, and
       writing the shift up at the end of it. Deliberately short of admin -
       running the roster and handing out accounts are different jobs. */
    'lead' => [
        'roster.read',
        'calls.write',
        'duties.write',
        'reports.read',
        'data.export',
        'handover.read',
        'handover.write',
        'handover.manage',
        'shift.report',
    ],

    'editor' => [
        'roster.read',
        'calls.write',
        'duties.write',     // so a shift can arrange its own cover
        'reports.read',
        'data.export',
        'handover.read',
        'handover.write',   // the people on shift are the ones with something to hand over
    ],

    'viewer' => [
        'roster.read',
        'reports.read',
        'handover.read',    // reading what to look out for is not a privilege
    ],
];

/* Actions the browser makes on its own. They keep a session alive against the
   hard limit but must not reset the idle clock. */
const IDLE_EXEMPT = ['version'];

/* Failed sign-ins allowed before an account, or an address, is made to wait.
   Per account first, so one person fat-fingering their password does not lock
   the team out; per IP as well, because one attacker spraying many accounts
   never trips the per-account count. */
const LOGIN_MAX_PER_EMAIL = 8;
const LOGIN_MAX_PER_IP    = 25;
const LOGIN_WINDOW_MIN    = 15;

/* Reset requests allowed from one address, and for one account, per hour.
   Without a cap the form is a way to have the system mail somebody
   repeatedly, whether or not the sender knows their password. */
const RESET_MAX_PER_EMAIL = 5;
const RESET_MAX_PER_IP    = 20;

const TABLE_CAPS = [
    'people'      => 'people.write',
    'contacts'    => 'people.write',
    'leave'       => 'people.write',
    'duties'      => 'duties.write',
    'overrides'   => 'duties.write',
    'calls'       => 'calls.write',
    'sites'       => 'sites.write',
    'escalations' => 'sites.write',
    'rotations'   => 'rotations.write',
    'meta'        => 'calls.write',   /* lastCaller, written when a call is logged */
];

function is_https(): bool
{
    if (!empty($_SERVER['HTTPS']) && strtolower((string) $_SERVER['HTTPS']) !== 'off') {
        return true;
    }
    if (proxy_may_speak()) {
        $proto = strtolower((string) ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? ''));
        if ($proto === 'https') {
            return true;
        }
        if ((string) ($_SERVER['HTTP_X_FORWARDED_SSL'] ?? '') === 'on') {
            return true;
        }
    }
    return false;
}

function force_https(): void
{
    if (is_https() || PHP_SAPI === 'cli') {
        return;
    }
    if (empty(app_config()['force_https'])) {
        return;
    }

    $host = (string) ($_SERVER['HTTP_HOST'] ?? '');
    $uri  = (string) ($_SERVER['REQUEST_URI'] ?? '/');
    if ($host !== '') {
        header('Location: https://' . $host . $uri, true, 302);
        exit;
    }
}

function security_headers(): void
{
    if (headers_sent()) {
        return;
    }

    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: same-origin');
    header('X-Frame-Options: DENY');
    header('Permissions-Policy: geolocation=(), microphone=(), camera=(), interest-cohort=()');

    $cfg = app_config();
    $hsts = (int) ($cfg['hsts_seconds'] ?? 0);
    if (is_https() && $hsts > 0) {
        header('Strict-Transport-Security: max-age=' . $hsts
            . (!empty($cfg['hsts_subdomains']) ? '; includeSubDomains' : ''));
    }
}

function boot_request(): void
{
    force_https();
    security_headers();
    start_session();
}

function start_session(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }

    $https = is_https();

    ini_set('session.use_strict_mode', '1');
    ini_set('session.use_only_cookies', '1');

    session_set_cookie_params([
        'lifetime' => 0,          // until the browser closes
        'path'     => '/',
        'httponly' => true,       // script cannot read it, so XSS cannot steal it
        'secure'   => $https,     // only ever sent over TLS, when there is TLS
        'samesite' => 'Lax',      // blocks cross-site POSTs, keeps normal links working
    ]);

    session_name($https ? '__Host-CALLBOOK' : 'CALLBOOK');
    session_start();

    expire_session();
}

function expire_session(): void
{
    if (empty($_SESSION['user_id'])) {
        return;
    }

    $cfg   = app_config();
    $idle  = max(0, (int) ($cfg['session_idle_minutes'] ?? 480)) * 60;
    $hard  = max(0, (int) ($cfg['session_max_hours'] ?? 12)) * 3600;
    $now   = time();
    $seen  = (int) ($_SESSION['seen'] ?? $now);
    $since = (int) ($_SESSION['since'] ?? $now);

    if (($idle > 0 && $now - $seen > $idle) || ($hard > 0 && $now - $since > $hard)) {
        logout();
        start_session();
        return;
    }

    /* A background poll is not a person at the desk. The page asks for the
       version every twenty seconds whether anybody is there or not, so
       counting that as activity means the idle timer can never fire and only
       the hard limit ever ends a session. */
    if (!in_array((string) ($_GET['action'] ?? ''), IDLE_EXEMPT, true)) {
        $_SESSION['seen'] = $now;
    }
}

function is_super_admin(?string $email): bool
{
    if ($email === null || $email === '') {
        return false;
    }

    $email = strtolower(trim($email));
    $local = strstr($email, '@', true);
    if ($local === false) {
        $local = $email;
    }

    $list = app_config()['super_admins'] ?? [];
    if (!is_array($list)) {
        return false;
    }

    foreach ($list as $listed) {
        $listed = strtolower(trim((string) $listed));
        if ($listed === '') {
            continue;
        }
        if ($listed === $email) {
            return true;
        }
        if (strpos($listed, '@') === false && $listed === $local) {
            return true;
        }
    }
    return false;
}

function current_user(): ?array
{
    start_session();
    $id = $_SESSION['user_id'] ?? null;
    if (!$id) {
        return null;
    }

    static $cached = null;
    if ($cached !== null && $cached['id'] === $id) {
        return $cached;
    }

    $st = get_db()->prepare(
        'SELECT id, email, name, role, must_change_password
         FROM users WHERE id = ? AND is_active = 1'
    );
    $st->execute([$id]);
    $u = $st->fetch();
    if (!$u) {
        return null;
    }

    $pinned = is_super_admin($u['email']);
    $role   = $pinned ? 'superadmin' : (string) $u['role'];

    /* No two-factor state here. A signed-in session has already passed the
       second factor - that is the only way one comes into existence - so there
       is nothing for the app to ask about or offer to turn on. */
    $cached = [
        'id'                 => $u['id'],
        'user'               => $u['email'],
        'name'               => $u['name'],
        'role'               => $role,
        'mustChangePassword' => (int) $u['must_change_password'] === 1,
        'can'                => ROLES[$role] ?? [],
        'pinned'             => $pinned,
    ];
    return $cached;
}

function has_any_account(): bool
{
    return (int) get_db()->query('SELECT COUNT(*) FROM users')->fetchColumn() > 0;
}

/* Only ever called once the second factor has passed. */
function start_authenticated_session(array $row): void
{
    start_session();
    session_regenerate_id(true);

    /* The half-signed-in marker has done its job; leaving it behind would let
       a later request start a second session from it. */
    unset($_SESSION['mfa_pending']);

    $_SESSION['user_id'] = $row['id'];
    $_SESSION['since']   = time();
    $_SESSION['seen']    = time();

    /* Recorded on the way in rather than on the way out: a session that ends
       by timing out has nowhere to write, and an account nobody has used for
       months is exactly the one the Accounts tab needs to point at. */
    get_db()->prepare('UPDATE users SET last_login_at = NOW(), last_login_ip = ? WHERE id = ?')
        ->execute([client_ip(), $row['id']]);
}

/* How many failures stand against this address and this caller inside the
   window. Old rows are pruned here rather than by a job, so the table stays
   small without anything else having to remember it. */
function login_failures(PDO $pdo, string $email, string $ip): array
{
    $pdo->prepare('DELETE FROM login_attempts WHERE tried_at < (NOW() - INTERVAL ? MINUTE)')
        ->execute([LOGIN_WINDOW_MIN * 4]);

    $st = $pdo->prepare(
        'SELECT
           SUM(email = ?) AS by_email,
           SUM(ip = ? AND ? <> "") AS by_ip
         FROM login_attempts
         WHERE tried_at > (NOW() - INTERVAL ? MINUTE)'
    );
    $st->execute([$email, $ip, $ip, LOGIN_WINDOW_MIN]);
    $row = $st->fetch() ?: [];

    return [(int) ($row['by_email'] ?? 0), (int) ($row['by_ip'] ?? 0)];
}

/* The password was right - now the second factor.

   Nothing in the session counts as signed in yet (no user_id), only this
   pending entry, which the sign-in page turns into the code prompt or into
   first-time enrolment. A caller who stops here has exactly as much access as
   one who never started.

   Every sign-in comes through here. There is no branch that skips it for an
   account without an authenticator: that account is made to set one up, which
   is what makes the second factor a property of the system rather than a
   preference each person gets to decline. */
function begin_mfa(array $user): void
{
    start_session();
    session_regenerate_id(true);

    /* The CSRF token is deliberately carried across. The pending sign-in is
       still a form flow, and the browser already holds this token. */
    $csrf = $_SESSION['csrf_token'] ?? bin2hex(random_bytes(32));

    $_SESSION = [
        'csrf_token'  => $csrf,
        'mfa_pending' => [
            'user_id' => $user['id'],
            'email'   => $user['email'],
            'at'      => time(),
            'tries'   => 0,
        ],
    ];
}

/* Returns ['error' => ?string, 'mfa' => 'verify'|'enroll'|null].

   'verify' means an authenticator already exists; 'enroll' means one has to be
   set up before this account goes any further. */
function attempt_login(string $email, string $password): array
{
    start_session();

    $key = strtolower(trim($email));
    $pdo = get_db();
    $ip  = client_ip();

    /* Checked before the password is even looked at, so a locked-out guesser
       cannot use the response time to learn anything either. The message is
       the same whether or not the account exists. */
    [$byEmail, $byIp] = login_failures($pdo, $key, $ip);
    if ($byEmail >= LOGIN_MAX_PER_EMAIL || $byIp >= LOGIN_MAX_PER_IP) {
        usleep(400000);
        return ['error' => 'Too many failed attempts. Wait ' . LOGIN_WINDOW_MIN
            . ' minutes and try again.', 'mfa' => null];
    }

    $st = $pdo->prepare('SELECT * FROM users WHERE email = ? AND is_active = 1');
    $st->execute([$key]);
    $u = $st->fetch();

    $hash = is_array($u)
        ? (string) $u['password_hash']
        : '$2y$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';

    $ok = password_verify($password, $hash) && is_array($u);

    if (!$ok) {
        $pdo->prepare('INSERT INTO login_attempts (email, ip) VALUES (?, ?)')
            ->execute([$key, $ip]);
        usleep(400000);   // slows a guessing script without troubling a person
        return ['error' => 'That email and password do not match.', 'mfa' => null];
    }

    /* A right password clears this account's own failures, so somebody who
       mistyped twice and then got it right is not still counting down. The
       second factor has its own separate allowance - MFA_MAX_TRIES. */
    $pdo->prepare('DELETE FROM login_attempts WHERE email = ?')->execute([$key]);

    $enrolled = mfa_is_enrolled($pdo, (string) $u['id']);
    log_action($pdo, 'Password accepted for ' . $u['email'] . '; awaiting second factor');

    begin_mfa($u);
    return ['error' => null, 'mfa' => $enrolled ? 'verify' : 'enroll'];
}

/* The account row behind the pending sign-in, or null if there is none, it has
   expired, or the account has since been deactivated. */
function pending_mfa_user(): ?array
{
    start_session();

    $pending = mfa_pending();
    if ($pending === null) {
        return null;
    }

    $st = get_db()->prepare('SELECT * FROM users WHERE id = ? AND is_active = 1');
    $st->execute([$pending['user_id']]);
    $u = $st->fetch();
    if (!$u) {
        unset($_SESSION['mfa_pending']);
        return null;
    }
    return $u;
}

/* The key being enrolled, held in the session for the length of this pending
   sign-in so it does not change after it has been scanned. */
function pending_enrol_secret(): string
{
    start_session();
    if (empty($_SESSION['mfa_pending']['enroll_secret'])) {
        $_SESSION['mfa_pending']['enroll_secret'] = mfa_new_secret();
    }
    return (string) $_SESSION['mfa_pending']['enroll_secret'];
}

/* Counts one wrong code against the pending sign-in. Returns true when the
   allowance is used up and the whole attempt has been thrown away, so the
   caller tells them to start from the password again. */
function count_mfa_failure(string $why): bool
{
    start_session();

    $tries = (int) ($_SESSION['mfa_pending']['tries'] ?? 0) + 1;

    try {
        log_action(get_db(), 'Wrong second factor for '
            . (string) ($_SESSION['mfa_pending']['email'] ?? 'an account')
            . ' (' . $why . ', attempt ' . $tries . ')');
    } catch (Throwable $e) {
        error_log('callbook: could not record an MFA failure: ' . $e->getMessage());
    }

    if ($tries >= MFA_MAX_TRIES) {
        unset($_SESSION['mfa_pending']);
        return true;
    }
    $_SESSION['mfa_pending']['tries'] = $tries;
    return false;
}

function logout(): void
{
    if (session_status() !== PHP_SESSION_ACTIVE) {
        start_session();
    }
    $_SESSION = [];

    if (ini_get('session.use_cookies')) {
        $p = session_get_cookie_params();
        setcookie(session_name(), '', [
            'expires'  => time() - 42000,
            'path'     => $p['path'],
            'domain'   => $p['domain'],
            'secure'   => $p['secure'],
            'httponly' => $p['httponly'],
            'samesite' => $p['samesite'] ?? 'Lax',
        ]);
    }
    session_destroy();
}

function csrf_token(): string
{
    start_session();
    if (empty($_SESSION['csrf_token'])) {
        $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
    }
    return $_SESSION['csrf_token'];
}

/* ==========================================================================
   forgotten passwords
   ==========================================================================
   The token is returned to the caller once, to be mailed, and only its
   SHA-256 hash is kept. A reader of the table therefore cannot reset
   anybody's password with what is in it. SHA-256 rather than password_hash
   because the token is 256 random bits already - there is nothing to slow a
   guesser down for, and the lookup has to be by exact value. */

function reset_requests_recently(PDO $pdo, string $userId, string $ip): array
{
    $pdo->prepare('DELETE FROM password_resets WHERE requested_at < (NOW() - INTERVAL 7 DAY)')
        ->execute();

    $st = $pdo->prepare(
        'SELECT SUM(user_id = ?) AS by_user, SUM(requested_ip = ? AND ? <> "") AS by_ip
         FROM password_resets WHERE requested_at > (NOW() - INTERVAL 1 HOUR)'
    );
    $st->execute([$userId, $ip, $ip]);
    $row = $st->fetch() ?: [];

    return [(int) ($row['by_user'] ?? 0), (int) ($row['by_ip'] ?? 0)];
}

/* Returns the token to mail, or null if this address has asked too often. */
function create_reset_token(PDO $pdo, string $userId): ?string
{
    $ip = client_ip();

    [$byUser, $byIp] = reset_requests_recently($pdo, $userId, $ip);
    if ($byUser >= RESET_MAX_PER_EMAIL || $byIp >= RESET_MAX_PER_IP) {
        return null;
    }

    /* Asking again retires the link sent before it, so only the newest one
       works and an older mail cannot be used later. */
    $pdo->prepare('UPDATE password_resets SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL')
        ->execute([$userId]);

    $minutes = max(5, min(1440, (int) (app_config()['reset_token_minutes'] ?? 60)));
    $token   = bin2hex(random_bytes(32));

    $pdo->prepare(
        'INSERT INTO password_resets (id, user_id, token_hash, requested_ip, requested_at, expires_at)
         VALUES (?, ?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL ? MINUTE))'
    )->execute([new_uuid(), $userId, hash('sha256', $token), $ip, $minutes]);

    return $token;
}

/* The account a token belongs to, or null if it is unknown, spent or stale. */
function reset_token_user(PDO $pdo, string $token): ?array
{
    if (!preg_match('/^[a-f0-9]{64}$/', $token)) {
        return null;
    }

    $st = $pdo->prepare(
        'SELECT r.id AS reset_id, u.*
         FROM password_resets r JOIN users u ON u.id = r.user_id
         WHERE r.token_hash = ? AND r.used_at IS NULL AND r.expires_at > NOW()
           AND u.is_active = 1'
    );
    $st->execute([hash('sha256', $token)]);
    $row = $st->fetch();
    return $row ?: null;
}
