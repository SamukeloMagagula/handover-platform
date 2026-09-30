<?php

declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');

set_exception_handler(function (Throwable $e): void {
    if (!headers_sent()) {
        http_response_code(500);
    }
    echo json_encode(['error' => $e->getMessage()]);
});
register_shutdown_function(function (): void {
    $error = error_get_last();
    if ($error && ($error['type'] & (E_ERROR | E_PARSE | E_CORE_ERROR | E_COMPILE_ERROR))) {
        if (!headers_sent()) {
            http_response_code(500);
        }
        echo json_encode(['error' => sprintf(
            'Fatal: %s (%s line %d)', $error['message'], basename($error['file']), $error['line']
        )]);
    }
});

require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/validation.php';
require_once __DIR__ . '/hub.php';

function api_fail(string $message, int $status, array $extra = []): void
{
    http_response_code($status);
    header('Cache-Control: no-store');
    echo json_encode(array_merge(['error' => $message], $extra));
    exit;
}

function api_ok($data = []): void
{
    header('Cache-Control: no-store');
    echo json_encode(array_merge(['ok' => true], is_array($data) ? $data : ['data' => $data]));
    exit;
}

function read_json_body(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === false || $raw === '') {
        return [];
    }
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        api_fail('The request body was not valid JSON.', 400);
    }
    return $data;
}

function api_require_login(): array
{
    $user = current_user();
    if ($user === null) {
        api_fail('Not signed in.', 401, ['signedOut' => true]);
    }
    return $user;
}

function api_require_capability(string $capability): array
{
    $user = api_require_login();
    if (!in_array($capability, $user['can'], true)) {
        api_fail(
            'Your account (' . $user['role'] . ') is not allowed to do that.',
            403,
            ['needs' => $capability]
        );
    }
    return $user;
}

function api_require_csrf(array $body): void
{
    start_session();
    $submitted = (string) ($body['csrf_token'] ?? '');
    if (!hash_equals($_SESSION['csrf_token'] ?? '', $submitted)) {
        api_fail('Invalid or expired form submission. Please reload and try again.', 400);
    }
}

function signup_allowed(): bool
{
    return !empty(app_config()['allow_signup']);
}

/* Both halves are required. Without a from address there is no way to send
   the link, and without a way to send the link there is no way to tell the
   person asking from somebody who merely knows their email address - so the
   feature refuses rather than offering a form that cannot work. */
function password_reset_allowed(): bool
{
    $cfg = app_config();
    return !empty($cfg['allow_password_reset']) && trim((string) ($cfg['mail_from'] ?? '')) !== '';
}

function active_superadmins(PDO $pdo): int
{
    return (int) $pdo->query("SELECT COUNT(*) FROM users WHERE role = 'superadmin' AND is_active = 1")
        ->fetchColumn();
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$action = (string) ($_GET['action'] ?? '');

boot_request();

$body = $method === 'POST' ? read_json_body() : [];

$public = ['csrf', 'me', 'login', 'login_mfa', 'login_enrol', 'logout', 'install', 'signup',
    'ical', 'forgot', 'reset'];

if (!in_array($action, $public, true) && current_user() === null) {
    api_fail('Not signed in.', 401, ['signedOut' => true]);
}

if ($method === 'POST') {
    api_require_csrf($body);
}

if ($method === 'GET' && $action === 'csrf') {
    api_ok(['csrf_token' => csrf_token()]);
}

if ($method === 'GET' && $action === 'me') {
    $user = current_user();
    if ($user === null) {
        $installed = has_any_account();
        api_ok([
            'authenticated' => false,
            'installed'     => $installed,
            'signup'        => $installed && signup_allowed(),
            'reset'         => $installed && password_reset_allowed(),
        ]);
    }
    api_ok(['authenticated' => true, 'user' => $user]);
}

/* Every sign-in is two steps. The password only ever gets you as far as the
   second factor - either entering a code, or setting up the authenticator that
   will produce one. Nothing here reports anything about the account until both
   steps have passed. */
if ($method === 'POST' && $action === 'login') {
    $result = attempt_login((string) ($body['email'] ?? ''), (string) ($body['password'] ?? ''));
    if ($result['error'] !== null) {
        api_fail($result['error'], 401);
    }

    if ($result['mfa'] === 'enroll') {
        $secret = pending_enrol_secret();
        $user   = pending_mfa_user();
        api_ok([
            'mfa'       => 'enroll',
            'uri'       => mfa_otpauth_uri((string) $user['email'], $secret),
            'secret'    => mfa_format_secret($secret),
        ]);
    }

    api_ok(['mfa' => 'verify']);
}

/* Finishing a sign-in: a code from the authenticator, or a recovery code. */
if ($method === 'POST' && $action === 'login_mfa') {
    $user = pending_mfa_user();
    if ($user === null) {
        api_fail('That sign-in took too long. Please enter your password again.', 401,
            ['restart' => true]);
    }

    $code = trim((string) ($body['code'] ?? ''));

    try {
        $ok = mfa_check_code(get_db(), (string) $user['id'], $code);
    } catch (Throwable $e) {
        error_log('callbook mfa_check_code failed: ' . $e->getMessage());
        api_fail('Server error signing in. Check the PHP error log for detail.', 500);
    }

    if (!$ok) {
        if (count_mfa_failure('verify')) {
            api_fail('Too many wrong codes. Please sign in again.', 401, ['restart' => true]);
        }
        api_fail('That code did not work. Try the current one from your authenticator '
            . 'app, or a recovery code.', 401);
    }

    log_action(get_db(), 'Signed in');
    start_authenticated_session($user);
    api_ok(['user' => current_user()]);
}

/* First sign-in for an account with no authenticator. The key has been sitting
   in the pending session since the password step; it is only written to the
   database once a code proves the app actually holds it. */
if ($method === 'POST' && $action === 'login_enrol') {
    $user = pending_mfa_user();
    if ($user === null) {
        api_fail('That sign-in took too long. Please enter your password again.', 401,
            ['restart' => true]);
    }

    $secret = (string) ($_SESSION['mfa_pending']['enroll_secret'] ?? '');
    if ($secret === '') {
        api_fail('Something went wrong setting up your authenticator. Please sign in again.',
            400, ['restart' => true]);
    }

    try {
        $step = totp_match($secret, trim((string) ($body['code'] ?? '')));
        $codes = $step === null ? null : mfa_enroll(get_db(), (string) $user['id'], $secret, $step);
    } catch (Throwable $e) {
        error_log('callbook mfa_enroll failed: ' . $e->getMessage());
        api_fail('Server error setting up your authenticator. Check the PHP error log.', 500);
    }

    if ($codes === null) {
        if (count_mfa_failure('enrol')) {
            api_fail('Too many wrong codes. Please sign in again.', 401, ['restart' => true]);
        }
        api_fail("That code did not match. Check your phone's clock is right, then try "
            . 'the current code.', 400);
    }

    log_action(get_db(), 'Set up an authenticator app and signed in');
    start_authenticated_session($user);

    /* Shown once, and never again: only their hashes are kept. */
    api_ok(['user' => current_user(), 'recoveryCodes' => $codes]);
}

if ($method === 'POST' && $action === 'forgot') {
    if (!has_any_account()) {
        api_fail('Setup has not been completed yet.', 400);
    }
    if (!password_reset_allowed()) {
        api_fail('Password resets are handled by an administrator here.', 403);
    }

    $email = strtolower(trim((string) ($body['email'] ?? '')));
    $pdo   = get_db();

    /* The same answer whichever address was typed. Saying "no such account"
       here would turn this form into a way to find out who has one. */
    $said = 'If that address has an account, a reset link is on its way.';

    if ($email === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
        api_ok(['message' => $said]);
    }

    $st = $pdo->prepare('SELECT id, name, email FROM users WHERE email = ? AND is_active = 1');
    $st->execute([$email]);
    $user = $st->fetch();

    if ($user) {
        $token = create_reset_token($pdo, (string) $user['id']);
        if ($token !== null) {
            $minutes = max(5, min(1440, (int) (app_config()['reset_token_minutes'] ?? 60)));
            $link    = app_url() . '/reset.html?token=' . $token;

            $sent = send_mail(
                (string) $user['email'],
                'Reset your Call book password',
                "Somebody asked to reset the password for this Call book account.\n\n"
                . "Open this link to choose a new one:\n\n  " . $link . "\n\n"
                . "It stops working in " . $minutes . " minutes, and after it has been used once.\n\n"
                . "If this was not you, nothing has changed and you can ignore this message -\n"
                . "but tell whoever runs the Call book, because somebody knows your address.\n"
            );

            /* Recorded either way. A reset that could not be delivered is
               something the administrator needs to find out about from the
               trail rather than from the person who never got the mail. */
            log_action($pdo, $sent
                ? 'Sent a password reset link to ' . $user['email']
                : 'Could not send a password reset link to ' . $user['email']
                    . ' (check mail_from and the MTA)');
        } else {
            log_action($pdo, 'Refused a password reset for ' . $user['email']
                . ': too many requests in the last hour');
        }
    }

    api_ok(['message' => $said]);
}

if ($method === 'POST' && $action === 'reset') {
    if (!password_reset_allowed()) {
        api_fail('Password resets are handled by an administrator here.', 403);
    }

    $pdo   = get_db();
    $token = (string) ($body['token'] ?? '');
    $user  = reset_token_user($pdo, $token);

    if ($user === null) {
        api_fail('That link has expired or has already been used. Ask for a new one.', 400);
    }
    if ($problem = password_problem((string) ($body['password'] ?? ''), (string) ($body['confirm'] ?? ''))) {
        api_fail($problem, 400);
    }

    $pdo->beginTransaction();
    try {
        $pdo->prepare('UPDATE password_resets SET used_at = NOW() WHERE id = ? AND used_at IS NULL')
            ->execute([$user['reset_id']]);

        $pdo->prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?')
            ->execute([
                password_hash((string) ($body['password'] ?? ''), PASSWORD_DEFAULT),
                $user['id'],
            ]);

        /* The lockout was counting failed guesses at an account whose owner
           has now proved they can read its mail. */
        $pdo->prepare('DELETE FROM login_attempts WHERE email = ?')->execute([$user['email']]);

        log_action($pdo, 'Reset the password for ' . $user['email'] . ' using a mailed link');
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        error_log('callbook reset failed: ' . $e->getMessage());
        api_fail('The password could not be changed. Nothing was written.', 500);
    }

    api_ok();
}

if ($method === 'POST' && $action === 'logout') {
    logout();
    api_ok();
}

if ($method === 'POST' && $action === 'signup') {
    if (!has_any_account()) {
        api_fail('Setup has not been completed yet.', 400);
    }
    if (!signup_allowed()) {
        api_fail('Accounts are issued by an administrator here.', 403);
    }

    $name     = trim((string) ($body['name'] ?? ''));
    $email    = strtolower(trim((string) ($body['email'] ?? '')));
    $password = (string) ($body['password'] ?? '');
    $confirm  = (string) ($body['confirm'] ?? '');
    $domain   = strtolower(trim((string) (app_config()['signup_domain'] ?? '')));

    if ($name === '') {
        api_fail('A name is required.', 400);
    }
    if ($problem = email_problem($email)) {
        api_fail($problem, 400);
    }
    if ($domain !== '') {
        $suffix = '@' . $domain;
        if (substr($email, -strlen($suffix)) !== $suffix) {
            api_fail('Please sign up with your @' . $domain . ' email address.', 400);
        }
    }
    if ($problem = password_problem($password, $confirm)) {
        api_fail($problem, 400);
    }

    $pdo = get_db();
    try {
        $id = new_uuid();
        $pdo->prepare(
            "INSERT INTO users (id, email, name, role, password_hash, must_change_password)
             VALUES (?, ?, ?, 'viewer', ?, 0)"
        )->execute([$id, $email, $name, password_hash($password, PASSWORD_DEFAULT)]);
    } catch (PDOException $e) {
        api_fail('That email address cannot be registered.', 400);
    }

    $st = $pdo->prepare('SELECT * FROM users WHERE id = ?');
    $st->execute([$id]);
    $row = $st->fetch();
    if (!$row) {
        api_fail('The account could not be created.', 500);
    }

    log_action($pdo, 'Registered themselves: ' . $name . ' (' . $email . '), viewer');

    /* A new account is not signed in. It goes straight to setting up an
       authenticator, like any other account without one: registering yourself
       must not be a way around the second factor. */
    begin_mfa($row);
    $secret = pending_enrol_secret();
    api_ok([
        'mfa'    => 'enroll',
        'uri'    => mfa_otpauth_uri($email, $secret),
        'secret' => mfa_format_secret($secret),
    ]);
}

if ($method === 'POST' && $action === 'install') {
    if (has_any_account()) {
        api_fail('Setup has already been completed. An account already exists.', 400);
    }

    $email    = strtolower(trim((string) ($body['email'] ?? '')));
    $name     = trim((string) ($body['name'] ?? ''));
    $password = (string) ($body['password'] ?? '');
    $confirm  = (string) ($body['confirm'] ?? '');

    if ($name === '') {
        api_fail('A name is required.', 400);
    }
    if ($problem = email_problem($email)) {
        api_fail($problem, 400);
    }
    if ($problem = password_problem($password, $confirm)) {
        api_fail($problem, 400);
    }

    $pdo = get_db();
    $pdo->prepare(
        "INSERT INTO users (id, email, name, role, password_hash, must_change_password)
         VALUES (?, ?, ?, 'superadmin', ?, 0)"
    )->execute([new_uuid(), $email, $name, password_hash($password, PASSWORD_DEFAULT)]);

    log_action($pdo, 'Created the first account: ' . $name . ' (' . $email . '), superadmin');
    api_ok();
}

if ($method === 'POST' && $action === 'change_password') {
    $user = api_require_login();
    $pdo  = get_db();

    $current = (string) ($body['current_password'] ?? '');
    $new     = (string) ($body['new_password'] ?? '');
    $confirm = (string) ($body['confirm'] ?? '');

    $st = $pdo->prepare('SELECT password_hash FROM users WHERE id = ?');
    $st->execute([$user['id']]);
    $hash = (string) $st->fetchColumn();

    if (!password_verify($current, $hash)) {
        api_fail('Your current password is not right.', 400);
    }
    if ($problem = password_problem($new, $confirm)) {
        api_fail($problem, 400);
    }

    $pdo->prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?')
        ->execute([password_hash($new, PASSWORD_DEFAULT), $user['id']]);
    log_action($pdo, 'Changed their own password');
    api_ok();
}

$pdo = get_db();

if ($method === 'GET' && $action === 'oncall') {
    api_require_capability('roster.read');
    $day = (string) ($_GET['day'] ?? date('Y-m-d'));
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $day)) {
        api_fail('day must be YYYY-MM-DD.', 400);
    }

    $standby = on_call($pdo, $day, 'standby');
    $onsite  = on_call($pdo, $day, 'onsite');

    api_ok([
        'day'         => $day,
        'standby'     => $standby,
        'onsite'      => $onsite,
        'covered'     => $standby !== [],
        'escalation'  => escalation_chain($pdo, ''),
        'generatedAt' => date('c'),
    ]);
}

if ($method === 'GET' && $action === 'ical') {
    $key = (string) ($_GET['key'] ?? '');
    if (!preg_match('/^[a-f0-9]{32}$/', $key)) {
        header('HTTP/1.1 404 Not Found');
        exit;
    }

    $who = null;

    if (hash_equals(get_meta($pdo, 'team_feed_key'), $key)) {
        $title = 'Onsite Call book — everyone';
    } else {
        $st = $pdo->prepare('SELECT id, name FROM people WHERE feed_key = ? AND feed_key <> ""');
        $st->execute([$key]);
        $person = $st->fetch();
        if (!$person) {
            header('HTTP/1.1 404 Not Found');
            exit;
        }
        $who = $person['id'];
        $title = 'On call — ' . $person['name'];
    }

    $sql = 'SELECT d.*, p.name FROM duties d JOIN people p ON p.id = d.person_id
            WHERE d.end_date > (CURDATE() - INTERVAL 1 YEAR)
              AND d.start_date < (CURDATE() + INTERVAL 1 YEAR)';
    $args = [];
    if ($who !== null) {
        $sql .= ' AND (d.person_id = ? OR d.id IN (SELECT duty_id FROM overrides WHERE person_id = ?))';
        $args = [$who, $who];
    }
    $sql .= ' ORDER BY d.start_date';

    $st = $pdo->prepare($sql);
    $st->execute($args);

    $lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Call Book//Onsite Call Book//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        'X-WR-CALNAME:' . ics_text($title),
        'X-PUBLISHED-TTL:PT1H',
    ];

    foreach ($st->fetchAll() as $d) {
        $label = ($d['type'] === 'onsite' ? 'On site' : 'Standby') .
            ($d['site'] !== '' ? ' · ' . $d['site'] : '') . ' — ' . $d['name'];

        $lines[] = 'BEGIN:VEVENT';
        $lines[] = 'UID:' . $d['id'] . '@callbook';
        $lines[] = 'DTSTAMP:' . gmdate('Ymd\THis\Z');
        $lines[] = 'DTSTART;VALUE=DATE:' . str_replace('-', '', $d['start_date']);
        $lines[] = 'DTEND;VALUE=DATE:' . date('Ymd', strtotime($d['end_date'] . ' +1 day'));
        $lines[] = 'SUMMARY:' . ics_text($label);
        if ($d['note'] !== null && $d['note'] !== '') {
            $lines[] = 'DESCRIPTION:' . ics_text((string) $d['note']);
        }
        if ($d['site'] !== '') {
            $lines[] = 'LOCATION:' . ics_text($d['site']);
        }
        $lines[] = 'TRANSP:TRANSPARENT';
        $lines[] = 'END:VEVENT';
    }

    $lines[] = 'END:VCALENDAR';

    header('Content-Type: text/calendar; charset=utf-8');
    header('Content-Disposition: inline; filename="callbook.ics"');
    header('Cache-Control: no-cache');
    echo implode("\r\n", $lines) . "\r\n";
    exit;
}

if ($method === 'GET' && $action === 'bootstrap') {
    api_require_capability('roster.read');
    api_ok(roster_state($pdo));
}

if ($method === 'GET' && $action === 'version') {
    $me = api_require_capability('roster.read');

    $out = ['version' => roster_version($pdo)];

    /* The open-handover count rides along with the poll the page already makes
       every twenty seconds. It is one indexed COUNT, and it means the nav can
       show that something is waiting without anybody having to open the tab to
       find out. Only for somebody who may open that tab. */
    if (in_array('handover.read', $me['can'], true)) {
        $out['handoversOpen'] = handover_open_count($pdo);
    }

    api_ok($out);
}

/* ==========================================================================
   the handover
   ==========================================================================
   Its own endpoints rather than the sync path, because sync takes whole rows
   and client-generated ids on trust. That is right for a roster the browser
   edits wholesale; it is wrong for a record whose whole value is that the
   server vouches for who wrote it and when. */

if ($method === 'GET' && $action === 'hub') {
    api_require_capability('handover.read');
    api_ok(hub_state($pdo));
}

if ($method === 'POST' && $action === 'handover_save') {
    $me = api_require_capability('handover.write');

    $id      = clean_string($body['id'] ?? '', 36);
    $title   = hub_text($body['title'] ?? '', 190);
    $ticket  = hub_text($body['ticketRef'] ?? '', 64);
    $note    = hub_text($body['body'] ?? '', 8000);
    $site    = clean_string($body['site'] ?? '', 160);
    $prio    = handover_priority((string) ($body['priority'] ?? 'normal'));
    $forWho  = clean_string($body['forPersonId'] ?? '', 36) ?: null;

    if ($title === '') {
        api_fail('Give it a title — a line somebody skimming at handover will understand.', 400);
    }

    $existing = $id === '' ? null : handover_by_id($pdo, $id);

    if ($existing === null) {
        $id = new_uuid();
        $pdo->prepare(
            'INSERT INTO handovers
               (id, ticket_ref, title, body, priority, status, site, for_person_id,
                author, author_user_id, created_at)
             VALUES (?, ?, ?, ?, ?, "open", ?, ?, ?, ?, NOW())'
        )->execute([$id, $ticket, $title, $note, $prio, $site, $forWho,
            operator_name(), $me['id']]);

        log_action($pdo, 'Left a handover: ' . $title
            . ($ticket !== '' ? ' (' . $ticket . ')' : '') . ', ' . $prio);
        api_ok(['id' => $id, 'state' => hub_state($pdo)]);
    }

    /* Anybody may add a note to somebody else's handover, but the item itself
       is edited by the person who wrote it - or by a shift leader, whose job
       includes tidying up what the shift left behind. */
    $mine = $existing['author_user_id'] !== null && $existing['author_user_id'] === $me['id'];
    if (!$mine && !in_array('handover.manage', $me['can'], true)) {
        api_fail('That handover was left by somebody else. You can add a note to it instead.', 403);
    }

    $pdo->prepare(
        'UPDATE handovers SET ticket_ref = ?, title = ?, body = ?, priority = ?,
                site = ?, for_person_id = ? WHERE id = ?'
    )->execute([$ticket, $title, $note, $prio, $site, $forWho, $id]);

    log_action($pdo, 'Edited the handover: ' . $title);
    api_ok(['id' => $id, 'state' => hub_state($pdo)]);
}

/* Acknowledging is the whole point of the thing: it turns "somebody wrote this
   down" into "somebody has read it and owns it". Stamped from the session, so
   it is a name that means something. */
if ($method === 'POST' && $action === 'handover_ack') {
    $me = api_require_capability('handover.write');
    $id = clean_string($body['id'] ?? '', 36);

    $existing = handover_by_id($pdo, $id);
    if ($existing === null) {
        api_fail('No such handover.', 404);
    }
    if ($existing['status'] !== 'open') {
        api_fail('That one has already been picked up.', 400);
    }

    $pdo->prepare(
        "UPDATE handovers SET status = 'acknowledged', acknowledged_by = ?,
                acknowledged_at = NOW()
          WHERE id = ? AND status = 'open'"
    )->execute([operator_name(), $id]);

    log_action($pdo, 'Picked up the handover: ' . $existing['title']);
    api_ok(['state' => hub_state($pdo)]);
}

if ($method === 'POST' && $action === 'handover_status') {
    $me     = api_require_capability('handover.write');
    $id     = clean_string($body['id'] ?? '', 36);
    $wanted = (string) ($body['status'] ?? '');

    if (!in_array($wanted, ['open', 'closed'], true)) {
        api_fail('A handover is either open or closed.', 400);
    }

    $existing = handover_by_id($pdo, $id);
    if ($existing === null) {
        api_fail('No such handover.', 404);
    }

    $mine = $existing['author_user_id'] !== null && $existing['author_user_id'] === $me['id'];
    if (!$mine && !in_array('handover.manage', $me['can'], true)) {
        api_fail('Only the person who left this, or a shift leader, can close it.', 403);
    }

    if ($wanted === 'closed') {
        $pdo->prepare(
            "UPDATE handovers SET status = 'closed', closed_by = ?, closed_at = NOW()
              WHERE id = ?"
        )->execute([operator_name(), $id]);
        log_action($pdo, 'Closed the handover: ' . $existing['title']);
    } else {
        /* Reopening clears the close but keeps the acknowledgement: somebody
           did read it, and that stays true. */
        $pdo->prepare(
            "UPDATE handovers SET status = IF(acknowledged_at IS NULL, 'open', 'acknowledged'),
                    closed_by = NULL, closed_at = NULL
              WHERE id = ?"
        )->execute([$id]);
        log_action($pdo, 'Reopened the handover: ' . $existing['title']);
    }

    api_ok(['state' => hub_state($pdo)]);
}

if ($method === 'POST' && $action === 'handover_note') {
    $me   = api_require_capability('handover.write');
    $id   = clean_string($body['id'] ?? '', 36);
    $text = hub_text($body['body'] ?? '', 4000);

    if ($text === '') {
        api_fail('Nothing to add.', 400);
    }

    $existing = handover_by_id($pdo, $id);
    if ($existing === null) {
        api_fail('No such handover.', 404);
    }

    $pdo->prepare(
        'INSERT INTO handover_notes (id, handover_id, body, author, author_user_id, created_at)
         VALUES (?, ?, ?, ?, ?, NOW())'
    )->execute([new_uuid(), $id, $text, operator_name(), $me['id']]);

    log_action($pdo, 'Added a note to the handover: ' . $existing['title']);
    api_ok(['state' => hub_state($pdo)]);
}

/* The shift leader's write-up. One per shift per site per day: posting again
   corrects what is there rather than adding a second version of the same
   shift, which is how two accounts of one night end up in circulation. */
if ($method === 'POST' && $action === 'shift_report_save') {
    $me = api_require_capability('shift.report');

    try {
        $date = clean_date($body['date'] ?? date('Y-m-d'));
    } catch (RuntimeException $e) {
        api_fail('The date must be YYYY-MM-DD.', 400);
    }
    $shift = clean_string($body['shift'] ?? 'day', 32);
    $site  = clean_string($body['site'] ?? '', 160);

    $progress      = hub_text($body['progress'] ?? '', 8000);
    $watchItems    = hub_text($body['watchItems'] ?? '', 8000);
    $optimisations = hub_text($body['optimisations'] ?? '', 8000);

    if ($shift === '') {
        api_fail('Say which shift this is.', 400);
    }
    if ($progress === '' && $watchItems === '' && $optimisations === '') {
        api_fail('An empty report says nothing. Fill in at least one section.', 400);
    }

    /* leader and created_at come from the session and the server clock. An
       upsert keeps created_at as first written and lets the rest be corrected. */
    $pdo->prepare(
        'INSERT INTO shift_reports
           (id, report_date, shift, site, leader, leader_user_id,
            progress, watch_items, optimisations, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
           leader = VALUES(leader), leader_user_id = VALUES(leader_user_id),
           progress = VALUES(progress), watch_items = VALUES(watch_items),
           optimisations = VALUES(optimisations)'
    )->execute([new_uuid(), $date, $shift, $site, operator_name(), $me['id'],
        $progress, $watchItems, $optimisations]);

    log_action($pdo, 'Posted the ' . $shift . ' shift report for ' . $date
        . ($site !== '' ? ' at ' . $site : '')
        . ($optimisations !== '' ? ', with suggestions' : ''));

    api_ok(['state' => hub_state($pdo)]);
}

if ($method === 'GET' && $action === 'log') {
    api_require_capability('history.read');
    $limit = (int) ($_GET['limit'] ?? app_config()['log_limit']);
    $limit = max(1, min($limit, (int) app_config()['log_limit']));

    $rows = $pdo->query('SELECT logged_at, who, what FROM audit_log ORDER BY id DESC LIMIT ' . $limit)->fetchAll();

    api_ok(['entries' => array_map(static function (array $r): array {
        return ['at' => $r['logged_at'], 'who' => $r['who'], 'what' => $r['what']];
    }, $rows)]);
}

if ($method === 'GET' && $action === 'feeds') {
    api_require_capability('data.export');
    $base = api_base_url();
    $rows = $pdo->query('SELECT id, name, feed_key FROM people ORDER BY name')->fetchAll();

    api_ok([
        'team'    => $base . '?action=ical&key=' . get_meta($pdo, 'team_feed_key'),
        'canEdit' => in_array('people.write', current_user()['can'], true),
        'people'  => array_map(static function (array $r) use ($base): array {
            return [
                'id'   => $r['id'],
                'name' => $r['name'],
                /* A revoked feed has no key and so has no link. It is still
                   listed, so it is visible that this person has none rather
                   than their simply being missing from the dialog. */
                'url'  => $r['feed_key'] === ''
                    ? '' : $base . '?action=ical&key=' . $r['feed_key'],
            ];
        }, $rows),
    ]);
}

/* A feed link is a password that cannot be rotated by changing a password:
   anybody who kept one keeps reading that calendar until the key behind it
   changes. Both of these are audited - who rotated whose feed, and when, is
   the question asked after somebody leaves. */
if ($method === 'POST' && ($action === 'feed_rotate' || $action === 'feed_revoke')) {
    api_require_capability('people.write');

    $scope = (string) ($body['scope'] ?? 'person');

    if ($scope === 'team') {
        if ($action === 'feed_revoke') {
            api_fail('The team feed cannot be revoked, only rotated.', 400);
        }
        $key = new_feed_key();
        set_meta($pdo, 'team_feed_key', $key);
        log_action($pdo, 'Rotated the team calendar key. Every old team link has stopped working.');
        api_ok(['team' => api_base_url() . '?action=ical&key=' . $key]);
    }

    $id = clean_string($body['id'] ?? '', 36);
    $st = $pdo->prepare('SELECT id, name FROM people WHERE id = ?');
    $st->execute([$id]);
    $person = $st->fetch();
    if (!$person) {
        api_fail('No such person.', 404);
    }

    if ($action === 'feed_revoke') {
        $pdo->prepare('UPDATE people SET feed_key = "" WHERE id = ?')->execute([$id]);
        log_action($pdo, 'Revoked the calendar feed for ' . $person['name']
            . '. Their old link has stopped working.');
        api_ok(['url' => '']);
    }

    $key = new_feed_key();
    $pdo->prepare('UPDATE people SET feed_key = ? WHERE id = ?')->execute([$key, $id]);
    log_action($pdo, 'Rotated the calendar key for ' . $person['name']
        . '. Their old link has stopped working.');

    api_ok(['url' => api_base_url() . '?action=ical&key=' . $key]);
}

/* Exports are built here rather than in the browser so that every copy of the
   directory or the call history that leaves the system leaves a row in the
   audit log behind it.

   This does not stop somebody reading numbers off the screen and typing them
   out - nothing can. What it does is make the sanctioned way of taking a copy
   the recorded way, so "who has had a full copy of everyone's numbers, and
   when" has an answer. */
if ($method === 'GET' && $action === 'export') {
    api_require_capability('data.export');

    $what = (string) ($_GET['what'] ?? 'calls');
    $stamp = date('Y-m-d');

    if ($what === 'directory') {
        [$csv, $rows] = directory_csv($pdo);
        $filename = 'callbook-directory-' . $stamp . '.csv';
        log_action($pdo, 'Exported the directory: ' . $rows . ' people, with every number');
    } elseif ($what === 'calls') {
        $from = (string) ($_GET['from'] ?? date('Y-m-01'));
        $to   = (string) ($_GET['to'] ?? date('Y-m-d'));
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $from) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $to)) {
            api_fail('from and to must be YYYY-MM-DD.', 400);
        }
        if ($from > $to) {
            api_fail('The start of the period is after its end.', 400);
        }

        [$csv, $rows] = calls_csv($pdo, $from, $to);
        $filename = 'callbook-calls-' . $from . '-to-' . $to . '.csv';
        log_action($pdo, 'Exported the call history for ' . $from . ' to ' . $to
            . ': ' . $rows . ' calls');
    } else {
        api_fail('Unknown export: ' . $what, 400);
    }

    /* No Content-Length: mod_deflate and friends compress this on the way out
       and a length measured before that is a truncated download. */
    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: attachment; filename="' . $filename . '"');
    header('Cache-Control: no-store');
    echo $csv;
    exit;
}

/* There was a 'note' action here that wrote whatever the browser sent into
   the audit log, needing only roster.read. Nothing in the app ever called it,
   and an audit trail a reader can write arbitrary lines into is not one, so
   it is gone rather than narrowed. Every entry now comes from an action the
   server carried out. */

if ($method === 'POST' && $action === 'sync') {
    $base  = (int) ($body['baseVersion'] ?? -1);
    $label = trim((string) ($body['label'] ?? 'Changed the roster'));
    $ops   = $body['ops'] ?? [];

    if (!is_array($ops)) {
        api_fail('ops must be a list.', 400);
    }
    if ($ops === []) {
        api_ok(['version' => roster_version($pdo), 'applied' => 0]);
    }

    foreach ($ops as $op) {
        $table = is_array($op) ? (string) ($op['table'] ?? '') : '';
        $needs = TABLE_CAPS[$table] ?? null;
        if ($needs === null) {
            api_fail('Unknown table: ' . $table, 400);
        }
        api_require_capability($needs);
    }

    $pdo->beginTransaction();
    try {
        $row = $pdo->query("SELECT v FROM meta WHERE k = 'roster_version' FOR UPDATE")->fetch();
        $current = (int) ($row['v'] ?? 0);

        if ($base !== $current) {
            $pdo->rollBack();
            api_fail('Someone else changed the roster first.', 409, [
                'version' => $current,
                'state'   => roster_state($pdo),
            ]);
        }

        $applied = 0;
        foreach ($ops as $op) {
            $applied += apply_operation($pdo, is_array($op) ? $op : []);
        }

        $next = $current + 1;
        set_meta($pdo, 'roster_version', (string) $next);

        /* The label is the browser's own account of what it did. It is kept
           because it reads well, but a tally counted from the operations that
           actually ran is appended to it, so an entry cannot describe one
           thing while the transaction did another. */
        log_action($pdo, audit_label($label, $ops));

        $pdo->commit();
        api_ok(['version' => $next, 'applied' => $applied]);
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        error_log('callbook sync failed: ' . $e->getMessage());
        api_fail('The change could not be saved. Nothing was written.', 500);
    }
}

if ($method === 'POST' && $action === 'rotate') {
    api_require_capability('rotations.write');
    $id     = clean_string($body['id'] ?? '', 36);
    $weeks  = max(1, min(104, (int) ($body['weeks'] ?? 12)));
    $dryRun = !empty($body['preview']);

    $st = $pdo->prepare('SELECT * FROM rotations WHERE id = ?');
    $st->execute([$id]);
    $rot = $st->fetch();
    if (!$rot) {
        api_fail('No such rotation.', 404);
    }

    $members = json_decode((string) $rot['members'], true);
    if (!is_array($members) || !$members) {
        api_fail('That rotation has nobody in it.', 400);
    }

    $length = max(1, (int) $rot['length_days']);
    $from   = date('Y-m-d');
    $until  = date('Y-m-d', strtotime("+$weeks week"));

    $turn = 0;
    $cursor = $rot['start_date'];
    while (date('Y-m-d', strtotime($cursor . ' +' . ($length - 1) . ' day')) < $from) {
        $cursor = date('Y-m-d', strtotime($cursor . ' +' . $length . ' day'));
        $turn++;
    }

    $planned = [];
    while ($cursor <= $until) {
        $end = date('Y-m-d', strtotime($cursor . ' +' . ($length - 1) . ' day'));
        $personId = $members[$turn % count($members)];
        $planned[] = [
            'personId' => $personId,
            'person'   => person_name($pdo, (string) $personId),
            'start'    => $cursor,
            'end'      => $end,
            'onLeave'  => leave_overlaps($pdo, (string) $personId, $cursor, $end),
        ];
        $cursor = date('Y-m-d', strtotime($end . ' +1 day'));
        $turn++;
    }

    if ($dryRun) {
        api_ok(['planned' => $planned, 'until' => $until]);
    }

    $pdo->beginTransaction();
    try {
        $pdo->query("SELECT v FROM meta WHERE k = 'roster_version' FOR UPDATE");

        $del = $pdo->prepare('DELETE FROM duties WHERE rotation_id = ? AND start_date >= ?');
        $del->execute([$id, $from]);

        $ins = $pdo->prepare(
            'INSERT INTO duties (id, person_id, type, start_date, end_date, site, note, rotation_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        );
        foreach ($planned as $p) {
            $ins->execute([
                new_uuid(),
                $p['personId'],
                $rot['type'],
                $p['start'],
                $p['end'],
                $rot['site'],
                'From the ' . $rot['name'] . ' rotation',
                $id,
            ]);
        }

        $upd = $pdo->prepare('UPDATE rotations SET generated_to = ? WHERE id = ?');
        $upd->execute([$until, $id]);

        set_meta($pdo, 'roster_version', (string) (roster_version($pdo) + 1));
        log_action($pdo, 'Generated ' . count($planned) . ' duties from the ' . $rot['name'] .
            ' rotation, through ' . $until);

        $pdo->commit();
        api_ok(['created' => count($planned), 'until' => $until, 'state' => roster_state($pdo)]);
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        error_log('callbook rotate failed: ' . $e->getMessage());
        api_fail('The rotation could not be generated. Nothing was written.', 500);
    }
}


/* There were totp_start / totp_confirm / totp_disable / totp_codes actions
   here, letting each person turn a second factor on or off for themselves.
   They are gone, and deliberately: under this model the second factor is not
   a preference. Every session in existence has already passed it, so a
   signed-in account has nothing to enable, and nothing it may switch off.
   Enrolment happens during sign-in - see login_enrol - and only a superadmin
   can undo it, by resetting the authenticator so the person enrols again. */


if ($method === 'GET' && $action === 'admin_users') {
    api_require_capability('users.write');

    $rows = $pdo->query(
        'SELECT id, email, name, role, is_active, must_change_password, created_at,
                last_login_at, last_login_ip
         FROM users ORDER BY email'
    )->fetchAll();

    $mfa = mfa_enrolled_by_user($pdo);

    foreach ($rows as &$row) {
        $row['pinned'] = is_super_admin($row['email']);
        if ($row['pinned']) {
            $row['role'] = 'superadmin';
        }

        /* Absence of a row is the whole story: no authenticator means that
           account sets one up before it gets in again. */
        $enrolment = $mfa[(string) $row['id']] ?? null;
        $row['mfa_enrolled']   = $enrolment !== null;
        $row['mfa_since']      = $enrolment['enrolledAt'] ?? null;
        $row['mfa_codes_left'] = $enrolment['codesLeft'] ?? 0;
    }
    unset($row);

    api_ok(['users' => $rows, 'roles' => array_keys(ROLES)]);
}

if ($method === 'POST' && $action === 'admin_user_create') {
    api_require_capability('users.write');

    $email    = strtolower(trim((string) ($body['email'] ?? '')));
    $name     = trim((string) ($body['name'] ?? ''));
    $role     = (string) ($body['role'] ?? 'viewer');
    $password = (string) ($body['password'] ?? '');

    if ($problem = email_problem($email)) {
        api_fail($problem, 400);
    }
    if ($name === '') {
        api_fail('A name is required.', 400);
    }
    if (!isset(ROLES[$role])) {
        api_fail('Unknown role: ' . $role, 400);
    }
    if ($problem = password_problem($password)) {
        api_fail($problem, 400);
    }

    try {
        $pdo->prepare(
            'INSERT INTO users (id, email, name, role, password_hash, must_change_password)
             VALUES (?, ?, ?, ?, ?, 1)'
        )->execute([new_uuid(), $email, $name, $role, password_hash($password, PASSWORD_DEFAULT)]);
    } catch (PDOException $e) {
        api_fail('An account with that email already exists.', 400);
    }

    log_action($pdo, 'Added the account ' . $name . ' (' . $email . '), role ' . $role);
    api_ok();
}

if ($method === 'POST' && $action === 'admin_user_update') {
    $me = api_require_capability('users.write');

    $id       = (string) ($body['id'] ?? '');
    $name     = trim((string) ($body['name'] ?? ''));
    $role     = (string) ($body['role'] ?? 'viewer');
    $isActive = !empty($body['is_active']) ? 1 : 0;

    if ($name === '') {
        api_fail('A name is required.', 400);
    }
    if (!isset(ROLES[$role])) {
        api_fail('Unknown role: ' . $role, 400);
    }

    $st = $pdo->prepare('SELECT * FROM users WHERE id = ?');
    $st->execute([$id]);
    $target = $st->fetch();
    if (!$target) {
        api_fail('No such account.', 404);
    }

    if (is_super_admin($target['email'])) {
        if ($role !== 'superadmin' || $isActive !== 1) {
            api_fail(
                'This account is a permanent superadmin, named in config.php. '
                . 'Remove it from super_admins there to change its role.',
                400
            );
        }
    }

    $wasActiveSuper = $target['role'] === 'superadmin' && (int) $target['is_active'] === 1;
    $staysActiveSuper = $role === 'superadmin' && $isActive === 1;
    if ($wasActiveSuper && !$staysActiveSuper && active_superadmins($pdo) <= 1) {
        api_fail('This is the last active superadmin. Promote somebody else first.', 400);
    }
    if ($target['id'] === $me['id'] && $isActive === 0) {
        api_fail('You cannot deactivate your own account.', 400);
    }

    $pdo->prepare('UPDATE users SET name = ?, role = ?, is_active = ? WHERE id = ?')
        ->execute([$name, $role, $isActive, $id]);

    log_action($pdo, 'Updated the account ' . $name . ' (' . $target['email'] . '): role '
        . $role . ', ' . ($isActive ? 'active' : 'deactivated'));
    api_ok();
}

if ($method === 'POST' && $action === 'admin_user_reset_password') {
    api_require_capability('users.write');

    $id       = (string) ($body['id'] ?? '');
    $password = (string) ($body['password'] ?? '');

    $st = $pdo->prepare('SELECT email, name FROM users WHERE id = ?');
    $st->execute([$id]);
    $target = $st->fetch();
    if (!$target) {
        api_fail('No such account.', 404);
    }
    if ($problem = password_problem($password)) {
        api_fail($problem, 400);
    }

    $pdo->prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?')
        ->execute([password_hash($password, PASSWORD_DEFAULT), $id]);

    log_action($pdo, 'Reset the password for ' . $target['name'] . ' (' . $target['email'] . ')');
    api_ok();
}

/* The way back in for somebody whose authenticator was on a phone they no
   longer have and whose recovery codes went with it.

   This does not turn the second factor off - there is no off. It forgets the
   authenticator, so the next sign-in on that account sets up a new one. It
   does not touch the password and does not sign anybody in, so an
   administrator doing this still cannot read the account. Audited, because it
   is the one action that lets somebody else's second factor be replaced. */
if ($method === 'POST' && $action === 'admin_user_mfa_reset') {
    api_require_capability('users.write');

    $id = (string) ($body['id'] ?? '');
    $st = $pdo->prepare('SELECT id, email, name FROM users WHERE id = ?');
    $st->execute([$id]);
    $target = $st->fetch();
    if (!$target) {
        api_fail('No such account.', 404);
    }
    if (!mfa_is_enrolled($pdo, (string) $target['id'])) {
        api_fail('That account has no authenticator set up — it will be asked to set '
            . 'one up at its next sign-in already.', 400);
    }

    mfa_reset($pdo, (string) $target['id']);
    log_action($pdo, 'Reset the authenticator for ' . $target['name']
        . ' (' . $target['email'] . '). They set up a new one at their next sign-in.');
    api_ok();
}

api_fail('No such action: ' . ($action === '' ? '(none given)' : $action), 404);
