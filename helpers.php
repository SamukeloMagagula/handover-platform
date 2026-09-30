<?php

declare(strict_types=1);

require_once __DIR__ . '/db.php';

function operator_name(): string
{
    if (function_exists('current_user')) {
        $u = current_user();
        if ($u !== null) {
            return mb_substr($u['name'] . ' (' . $u['user'] . ')', 0, 160);
        }
    }
    return 'System';
}

/* An audit entry is one line describing one thing. Newlines and control
   characters are stripped rather than escaped, because a single entry that
   can render as several is an entry that can be made to look like a record of
   something that never happened. */
function clean_audit_text(string $what, int $max = 500): string
{
    $what = preg_replace('/[\x00-\x1f\x7f]+/u', ' ', $what) ?? $what;
    $what = preg_replace('/\s+/u', ' ', $what) ?? $what;
    return mb_substr(trim($what), 0, $max);
}

/* What the browser says it did, followed by what the server saw it do.

   The label is the client's own description and is the readable half; the
   tally is counted from the operations actually applied, so an entry can no
   longer claim to be one thing while the transaction was another. Anybody
   reading the trail can see the two halves agree - or that they do not. */
function audit_label(string $label, array $ops): string
{
    $label = clean_audit_text($label, 300);
    if ($label === '') {
        $label = 'Changed the roster';
    }

    /* Nested rather than a joined key, so a table name with a space in it
       cannot be split back apart into the wrong pieces. */
    $counts = [];
    foreach ($ops as $op) {
        if (!is_array($op)) {
            continue;
        }
        $table = clean_audit_text((string) ($op['table'] ?? '?'), 32);
        $sign  = ($op['op'] ?? '') === 'del' ? '-' : '+';
        $counts[$table][$sign] = ($counts[$table][$sign] ?? 0) + 1;
    }
    if ($counts === []) {
        return $label;
    }

    ksort($counts);
    $parts = [];
    foreach ($counts as $table => $signs) {
        ksort($signs);
        foreach ($signs as $sign => $n) {
            $parts[] = $table . ' ' . $sign . $n;
        }
    }
    return mb_substr($label . ' [' . implode(', ', $parts) . ']', 0, 500);
}

function roster_version(PDO $pdo): int
{
    $row = $pdo->query("SELECT v FROM meta WHERE k = 'roster_version'")->fetch();
    return (int) ($row['v'] ?? 0);
}

function get_meta(PDO $pdo, string $key): string
{
    $st = $pdo->prepare('SELECT v FROM meta WHERE k = ?');
    $st->execute([$key]);
    $row = $st->fetch();
    return (string) ($row['v'] ?? '');
}

function set_meta(PDO $pdo, string $key, string $value): void
{
    $st = $pdo->prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)');
    $st->execute([$key, mb_substr($value, 0, 190)]);
}

function log_action(PDO $pdo, string $what): void
{
    $st = $pdo->prepare('INSERT INTO audit_log (logged_at, who, what, ip) VALUES (NOW(), ?, ?, ?)');
    $st->execute([operator_name(), clean_audit_text($what), client_ip()]);
}

/* ==========================================================================
   CSV
   ==========================================================================
   Exports are built here and streamed by api.php rather than assembled in the
   browser, so that every copy of the directory or the call history that
   leaves the system leaves an audit row behind it. */

function csv_line(array $fields): string
{
    return implode(',', array_map(static function ($v): string {
        return '"' . str_replace('"', '""', (string) ($v ?? '')) . '"';
    }, $fields)) . "\r\n";
}

/* Excel reads a file without this as the machine's own codepage and turns
   every name with an accent in it into mojibake. */
const CSV_BOM = "\xEF\xBB\xBF";

function calls_csv(PDO $pdo, string $from, string $to): array
{
    $st = $pdo->prepare(
        'SELECT c.call_date, c.call_time, p.name, c.called_by, c.outcome, c.note,
                c.logged_at, c.answered_at
         FROM calls c JOIN people p ON p.id = c.person_id
         WHERE c.call_date BETWEEN ? AND ?
         ORDER BY c.call_date, c.call_time'
    );
    $st->execute([$from, $to]);
    $rows = $st->fetchAll();

    $csv = CSV_BOM . csv_line([
        'Date', 'Time', 'Person', 'Called by', 'Outcome', 'Note', 'Logged at', 'Answered at',
    ]);
    foreach ($rows as $r) {
        $csv .= csv_line([
            $r['call_date'], $r['call_time'], $r['name'], $r['called_by'],
            $r['outcome'], $r['note'], $r['logged_at'], $r['answered_at'],
        ]);
    }
    return [$csv, count($rows)];
}

function directory_csv(PDO $pdo): array
{
    $people = $pdo->query('SELECT * FROM people ORDER BY name')->fetchAll();

    $extra = [];
    foreach ($pdo->query('SELECT person_id, kind, value FROM contacts ORDER BY person_id, position, id')
        ->fetchAll() as $c) {
        $extra[$c['person_id']][] = $c['kind'] . ': ' . $c['value'];
    }

    $csv = CSV_BOM . csv_line([
        'Name', 'Role', 'Department', 'Site', 'Mobile', 'Email', 'Other numbers', 'Notes',
    ]);
    foreach ($people as $p) {
        $csv .= csv_line([
            $p['name'], $p['role'], $p['department'], $p['site'], $p['phone'], $p['email'],
            implode(' / ', $extra[$p['id']] ?? []), $p['notes'],
        ]);
    }
    return [$csv, count($people)];
}

/* ==========================================================================
   mail
   ==========================================================================
   PHP's mail() hands off to the machine's MTA and does not speak SMTP itself,
   so a blank mail_from - or no MTA - means no mail. Both are reported rather
   than swallowed: a reset link nobody receives should not look like one that
   was sent. */
function send_mail(string $to, string $subject, string $body): bool
{
    $from = (string) (app_config()['mail_from'] ?? '');
    if ($from === '' || $to === '') {
        return false;
    }

    $headers = 'From: ' . $from . "\r\n"
        . "Content-Type: text/plain; charset=utf-8\r\n"
        . "X-Auto-Response-Suppress: All\r\n";

    /* A newline smuggled into the subject would end the header and let the
       rest be read as headers of its own. */
    $subject = str_replace(["\r", "\n"], ' ', $subject);

    if (!mail($to, $subject, $body, $headers)) {
        error_log('callbook: mail() failed for ' . $to);
        return false;
    }
    return true;
}

function roster_state(PDO $pdo): array
{
    return [
        'version' => roster_version($pdo),
        'people'  => array_map(static function (array $r): array {
            return [
                'id'         => $r['id'],
                'name'       => $r['name'],
                'role'       => $r['role'],
                'department' => $r['department'],
                'site'       => $r['site'],
                'phone'      => $r['phone'],
                'email'      => $r['email'],
                'notes'      => (string) $r['notes'],
                'feed'       => $r['feed_key'],
            ];
        }, $pdo->query('SELECT * FROM people ORDER BY name')->fetchAll()),

        'duties'  => array_map(static function (array $r): array {
            return [
                'id'       => $r['id'],
                'personId' => $r['person_id'],
                'type'     => $r['type'],
                'start'    => $r['start_date'],
                'end'      => $r['end_date'],
                'site'     => $r['site'],
                'note'     => (string) $r['note'],
            ];
        }, $pdo->query('SELECT * FROM duties ORDER BY start_date')->fetchAll()),

        'calls'   => array_map(static function (array $r): array {
            return [
                'id'       => $r['id'],
                'personId' => $r['person_id'],
                'date'     => $r['call_date'],
                'time'     => $r['call_time'],
                'by'       => $r['called_by'],
                'outcome'  => $r['outcome'],
                'note'     => (string) $r['note'],
                'loggedAt'   => $r['logged_at'],
                'answeredAt' => $r['answered_at'],
            ];
        }, $pdo->query('SELECT * FROM calls ORDER BY call_date, call_time')->fetchAll()),

        'sites'   => array_map(static function (array $r): array {
            return ['id' => $r['id'], 'name' => $r['name']];
        }, $pdo->query('SELECT * FROM sites ORDER BY name')->fetchAll()),

        'contacts' => array_map(static function (array $r): array {
            return [
                'id'       => $r['id'],
                'personId' => $r['person_id'],
                'kind'     => $r['kind'],
                'value'    => $r['value'],
                'position' => (int) $r['position'],
            ];
        }, $pdo->query('SELECT * FROM contacts ORDER BY person_id, position, id')->fetchAll()),

        'leave' => array_map(static function (array $r): array {
            return [
                'id'       => $r['id'],
                'personId' => $r['person_id'],
                'start'    => $r['start_date'],
                'end'      => $r['end_date'],
                'reason'   => $r['reason'],
            ];
        }, $pdo->query('SELECT * FROM leave_days ORDER BY start_date')->fetchAll()),

        'overrides' => array_map(static function (array $r): array {
            return [
                'id'       => $r['id'],
                'dutyId'   => $r['duty_id'],
                'personId' => $r['person_id'],
                'start'    => $r['start_date'],
                'end'      => $r['end_date'],
                'note'     => $r['note'],
            ];
        }, $pdo->query('SELECT * FROM overrides ORDER BY start_date')->fetchAll()),

        'escalations' => array_map(static function (array $r): array {
            return [
                'id'           => $r['id'],
                'site'         => $r['site'],
                'position'     => (int) $r['position'],
                'personId'     => $r['person_id'],
                'afterMinutes' => (int) $r['after_minutes'],
            ];
        }, $pdo->query('SELECT * FROM escalations ORDER BY site, position, id')->fetchAll()),

        'rotations' => array_map(static function (array $r): array {
            return [
                'id'          => $r['id'],
                'name'        => $r['name'],
                'type'        => $r['type'],
                'site'        => $r['site'],
                'start'       => $r['start_date'],
                'lengthDays'  => (int) $r['length_days'],
                'members'     => json_decode((string) $r['members'], true) ?: [],
                'generatedTo' => $r['generated_to'],
                'active'      => (int) $r['active'] === 1,
            ];
        }, $pdo->query('SELECT * FROM rotations ORDER BY name')->fetchAll()),

        'lastCaller' => get_meta($pdo, 'last_caller'),
        'teamFeed'   => get_meta($pdo, 'team_feed_key'),

        /* How a clicked number reaches a softphone, and what country to assume
           for a local one. Sent to the browser rather than hard-coded in the
           JavaScript so a different country or a different softphone is a
           config change, not an edit to a 90KB file. */
        'dial'       => dial_settings(),
    ];
}

function on_call(PDO $pdo, string $day, ?string $type = null): array
{
    $sql = 'SELECT d.id, d.person_id AS rota_person_id, d.type, d.start_date, d.end_date,
                   d.site, d.note,
                   o.person_id AS cover_person_id, o.note AS cover_note
            FROM duties d
            LEFT JOIN overrides o
              ON o.duty_id = d.id AND ? BETWEEN o.start_date AND o.end_date
            WHERE ? BETWEEN d.start_date AND d.end_date';
    $args = [$day, $day];

    if ($type === 'standby' || $type === 'onsite') {
        $sql .= ' AND d.type = ?';
        $args[] = $type;
    }
    $sql .= ' ORDER BY d.type, d.site';

    $st = $pdo->prepare($sql);
    $st->execute($args);

    $out = [];
    foreach ($st->fetchAll() as $r) {
        $personId = $r['cover_person_id'] ?: $r['rota_person_id'];
        $out[] = [
            'dutyId'    => $r['id'],
            'type'      => $r['type'],
            'site'      => $r['site'],
            'note'      => (string) $r['note'],
            'start'     => $r['start_date'],
            'end'       => $r['end_date'],
            'personId'  => $personId,
            'person'    => person_card($pdo, $personId),
            'coveringFor' => $r['cover_person_id']
                ? person_name($pdo, $r['rota_person_id'])
                : null,
            'coverNote' => (string) $r['cover_note'],
            'onLeave'   => is_on_leave($pdo, $personId, $day),
        ];
    }
    return $out;
}

function person_name(PDO $pdo, string $id): string
{
    $st = $pdo->prepare('SELECT name FROM people WHERE id = ?');
    $st->execute([$id]);
    $row = $st->fetch();
    return (string) ($row['name'] ?? 'Removed person');
}

function person_card(PDO $pdo, string $id): array
{
    $st = $pdo->prepare('SELECT id, name, role, phone, email FROM people WHERE id = ?');
    $st->execute([$id]);
    $p = $st->fetch();
    if (!$p) {
        return ['id' => $id, 'name' => 'Removed person', 'contacts' => []];
    }

    $contacts = [];
    if ($p['phone'] !== '') {
        $contacts[] = ['kind' => 'mobile', 'value' => $p['phone']];
    }

    $st = $pdo->prepare('SELECT kind, value FROM contacts WHERE person_id = ? ORDER BY position, id');
    $st->execute([$id]);
    foreach ($st->fetchAll() as $c) {
        $contacts[] = ['kind' => $c['kind'], 'value' => $c['value']];
    }
    if ($p['email'] !== '') {
        $contacts[] = ['kind' => 'email', 'value' => $p['email']];
    }

    return [
        'id'       => $p['id'],
        'name'     => $p['name'],
        'role'     => $p['role'],
        'contacts' => $contacts,
    ];
}

function is_on_leave(PDO $pdo, string $personId, string $day): bool
{
    $st = $pdo->prepare('SELECT 1 FROM leave_days WHERE person_id = ? AND ? BETWEEN start_date AND end_date LIMIT 1');
    $st->execute([$personId, $day]);
    return (bool) $st->fetchColumn();
}

function escalation_chain(PDO $pdo, string $site): array
{
    $st = $pdo->prepare('SELECT person_id, after_minutes FROM escalations WHERE site = ? ORDER BY position, id');
    $st->execute([$site]);
    $rows = $st->fetchAll();

    if (!$rows && $site !== '') {
        $st->execute(['']);
        $rows = $st->fetchAll();
    }

    return array_map(static function (array $r) use ($pdo): array {
        return [
            'afterMinutes' => (int) $r['after_minutes'],
            'person'       => person_card($pdo, $r['person_id']),
        ];
    }, $rows);
}

function cover_gaps(PDO $pdo, int $days): array
{
    $gaps = [];
    for ($i = 0; $i < $days; $i++) {
        $day = date('Y-m-d', strtotime("+$i day"));
        if (!on_call($pdo, $day, 'standby')) {
            $gaps[] = $day;
        }
    }
    return $gaps;
}

function unanswered_calls(PDO $pdo, int $minutes): array
{
    $st = $pdo->prepare(
        "SELECT c.id, c.call_date, c.call_time, c.outcome, c.note, c.logged_at, p.name
         FROM calls c JOIN people p ON p.id = c.person_id
         WHERE c.answered_at IS NULL
           AND c.outcome IN ('', 'noanswer', 'again', 'waiting')
           AND c.logged_at IS NOT NULL
           AND c.logged_at < (NOW() - INTERVAL ? MINUTE)
           AND c.logged_at > (NOW() - INTERVAL 3 DAY)
         ORDER BY c.logged_at"
    );
    $st->execute([$minutes]);
    return $st->fetchAll();
}

function leave_overlaps(PDO $pdo, string $personId, string $from, string $to): bool
{
    $st = $pdo->prepare('SELECT 1 FROM leave_days WHERE person_id = ? AND start_date <= ? AND end_date >= ? LIMIT 1');
    $st->execute([$personId, $to, $from]);
    return (bool) $st->fetchColumn();
}

/* A calendar feed key, 128 random bits as 32 hex characters - the shape the
   ical endpoint's own pattern expects.

   Not MySQL's UUID(): that is a version-1 UUID, built from the time and the
   server's MAC address, so one key tells you roughly what the next will be.
   For an id that is fine. For a value the README calls a password, and which
   authorises reading somebody's movements for a year either way, it is not. */
/* The softphone handoff, as the browser needs it.

   Only schemes a browser will actually hand to an external application are
   allowed through: anything else here would put an unknown scheme into an
   href, and a typo would silently produce dead links rather than an error. */
function dial_settings(): array
{
    $cfg    = app_config();
    $scheme = strtolower(trim((string) ($cfg['dial_scheme'] ?? 'sip')));

    if (!in_array($scheme, ['sip', 'tel', 'callto', ''], true)) {
        error_log('callbook: unknown dial_scheme "' . $scheme . '", falling back to sip');
        $scheme = 'sip';
    }

    $cc = preg_replace('/\D/', '', (string) ($cfg['dial_country_code'] ?? '27')) ?? '27';

    return [
        'scheme'      => $scheme,
        /* A domain only means anything to sip:. tel: and callto: take a bare
           number, and appending @host to either produces a URI no handler
           will accept. */
        'domain'      => $scheme === 'sip'
            ? clean_string($cfg['dial_domain'] ?? '', 190)
            : '',
        'countryCode' => $cc === '' ? '27' : $cc,
    ];
}

function new_feed_key(): string
{
    return bin2hex(random_bytes(16));
}

function new_uuid(): string
{
    $b = random_bytes(16);
    $b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
    $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
    return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($b), 4));
}

/* Where this installation lives, with no trailing slash.

   Built from the request when app_url is blank, which is right on a plain
   server and wrong behind a proxy that rewrites the host - a calendar link or
   a reset link built from the wrong host points somewhere nobody can reach.
   Setting app_url in config.php takes the guesswork out. */
function app_url(): string
{
    $configured = rtrim((string) (app_config()['app_url'] ?? ''), '/');
    if ($configured !== '') {
        return $configured;
    }

    $host = $_SERVER['HTTP_HOST'] ?? 'localhost';
    $dir  = str_replace('\\', '/', dirname((string) ($_SERVER['SCRIPT_NAME'] ?? '/api.php')));
    $dir  = rtrim($dir, '/');
    if ($dir === '.') {
        $dir = '';
    }
    return (is_https() ? 'https://' : 'http://') . $host . $dir;
}

function api_base_url(): string
{
    return app_url() . '/api.php';
}

function ics_text(string $s): string
{
    $s = str_replace(['\\', ';', ','], ['\\\\', '\\;', '\\,'], $s);
    $s = str_replace(["\r\n", "\n", "\r"], '\\n', $s);
    return $s;
}

function clean_string($v, int $max): string
{
    return mb_substr(trim((string) $v), 0, $max);
}

function clean_date($v): string
{
    $s = trim((string) $v);
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $s)) {
        throw new RuntimeException('Bad date: ' . $s);
    }
    return $s;
}

function apply_operation(PDO $pdo, array $op): int
{
    $table = (string) ($op['table'] ?? '');
    $kind  = (string) ($op['op'] ?? '');
    $id    = (string) ($op['id'] ?? '');
    $data  = is_array($op['data'] ?? null) ? $op['data'] : [];

    if ($id === '' || mb_strlen($id) > 36) {
        throw new RuntimeException('An operation arrived without a usable id.');
    }

    if ($table === 'meta') {
        if ($id === 'lastCaller') {
            set_meta($pdo, 'last_caller', (string) ($data['value'] ?? ''));
            return 1;
        }
        return 0;
    }

    $tables = [
        'people'      => 'people',
        'duties'      => 'duties',
        'calls'       => 'calls',
        'sites'       => 'sites',
        'contacts'    => 'contacts',
        'leave'       => 'leave_days',
        'overrides'   => 'overrides',
        'escalations' => 'escalations',
        'rotations'   => 'rotations',
    ];
    if (!isset($tables[$table])) {
        throw new RuntimeException('Unknown table: ' . $table);
    }
    $physical = $tables[$table];

    if ($kind === 'del') {
        $st = $pdo->prepare("DELETE FROM `$physical` WHERE id = ?");
        $st->execute([$id]);
        return $st->rowCount();
    }

    if ($kind !== 'put') {
        throw new RuntimeException('Unknown operation: ' . $kind);
    }

    if ($table === 'people') {
        /* feed_key is set on insert and never on update, so editing somebody
           does not silently invalidate a calendar they are subscribed to.
           Rotating it is a deliberate action of its own. */
        $st = $pdo->prepare(
            'INSERT INTO people (id, name, role, department, site, phone, email, notes, feed_key)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE name = VALUES(name), role = VALUES(role),
               department = VALUES(department), site = VALUES(site),
               phone = VALUES(phone), email = VALUES(email), notes = VALUES(notes)'
        );
        $st->execute([
            $id,
            clean_string($data['name'] ?? '', 160),
            clean_string($data['role'] ?? '', 160),
            clean_string($data['department'] ?? '', 160),
            clean_string($data['site'] ?? '', 160),
            clean_string($data['phone'] ?? '', 64),
            clean_string($data['email'] ?? '', 190),
            (string) ($data['notes'] ?? ''),
            new_feed_key(),
        ]);
        return 1;
    }

    if ($table === 'contacts') {
        $st = $pdo->prepare(
            'INSERT INTO contacts (id, person_id, kind, value, position) VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE person_id = VALUES(person_id), kind = VALUES(kind),
               value = VALUES(value), position = VALUES(position)'
        );
        $st->execute([
            $id,
            clean_string($data['personId'] ?? '', 36),
            clean_string($data['kind'] ?? 'mobile', 16),
            clean_string($data['value'] ?? '', 190),
            (int) ($data['position'] ?? 0),
        ]);
        return 1;
    }

    if ($table === 'leave') {
        $st = $pdo->prepare(
            'INSERT INTO leave_days (id, person_id, start_date, end_date, reason) VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE person_id = VALUES(person_id), start_date = VALUES(start_date),
               end_date = VALUES(end_date), reason = VALUES(reason)'
        );
        $st->execute([
            $id,
            clean_string($data['personId'] ?? '', 36),
            clean_date($data['start'] ?? ''),
            clean_date($data['end'] ?? ''),
            clean_string($data['reason'] ?? '', 190),
        ]);
        return 1;
    }

    if ($table === 'overrides') {
        $st = $pdo->prepare(
            'INSERT INTO overrides (id, duty_id, person_id, start_date, end_date, note)
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE duty_id = VALUES(duty_id), person_id = VALUES(person_id),
               start_date = VALUES(start_date), end_date = VALUES(end_date), note = VALUES(note)'
        );
        $st->execute([
            $id,
            clean_string($data['dutyId'] ?? '', 36),
            clean_string($data['personId'] ?? '', 36),
            clean_date($data['start'] ?? ''),
            clean_date($data['end'] ?? ''),
            clean_string($data['note'] ?? '', 190),
        ]);
        return 1;
    }

    if ($table === 'escalations') {
        $st = $pdo->prepare(
            'INSERT INTO escalations (id, site, position, person_id, after_minutes)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE site = VALUES(site), position = VALUES(position),
               person_id = VALUES(person_id), after_minutes = VALUES(after_minutes)'
        );
        $st->execute([
            $id,
            clean_string($data['site'] ?? '', 160),
            (int) ($data['position'] ?? 0),
            clean_string($data['personId'] ?? '', 36),
            max(1, min(1440, (int) ($data['afterMinutes'] ?? 15))),
        ]);
        return 1;
    }

    if ($table === 'rotations') {
        $members = $data['members'] ?? [];
        if (!is_array($members)) {
            $members = [];
        }
        $st = $pdo->prepare(
            'INSERT INTO rotations (id, name, type, site, start_date, length_days, members, generated_to, active)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE name = VALUES(name), type = VALUES(type), site = VALUES(site),
               start_date = VALUES(start_date), length_days = VALUES(length_days),
               members = VALUES(members), generated_to = VALUES(generated_to), active = VALUES(active)'
        );
        $st->execute([
            $id,
            clean_string($data['name'] ?? 'Rotation', 160),
            ($data['type'] ?? '') === 'onsite' ? 'onsite' : 'standby',
            clean_string($data['site'] ?? '', 160),
            clean_date($data['start'] ?? ''),
            max(1, min(365, (int) ($data['lengthDays'] ?? 7))),
            json_encode(array_values(array_map('strval', $members))),
            isset($data['generatedTo']) && $data['generatedTo'] ? clean_date($data['generatedTo']) : null,
            !empty($data['active']) ? 1 : 0,
        ]);
        return 1;
    }

    if ($table === 'sites') {
        $st = $pdo->prepare(
            'INSERT INTO sites (id, name) VALUES (?, ?)
             ON DUPLICATE KEY UPDATE name = VALUES(name)'
        );
        $st->execute([$id, clean_string($data['name'] ?? '', 160)]);
        return 1;
    }

    if ($table === 'duties') {
        $type = ($data['type'] ?? '') === 'onsite' ? 'onsite' : 'standby';
        $st = $pdo->prepare(
            'INSERT INTO duties (id, person_id, type, start_date, end_date, site, note, rotation_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE person_id = VALUES(person_id), type = VALUES(type),
               start_date = VALUES(start_date), end_date = VALUES(end_date),
               site = VALUES(site), note = VALUES(note)'
        );
        $st->execute([
            $id,
            clean_string($data['personId'] ?? '', 36),
            $type,
            clean_date($data['start'] ?? ''),
            clean_date($data['end'] ?? ''),
            clean_string($data['site'] ?? '', 160),
            (string) ($data['note'] ?? ''),
            isset($data['rotationId']) && $data['rotationId'] ? clean_string($data['rotationId'], 36) : null,
        ]);
        return 1;
    }

    $answering = in_array($data['outcome'] ?? '', ['answered', 'onway', 'escalated'], true);

    $st = $pdo->prepare('SELECT outcome, logged_at, answered_at FROM calls WHERE id = ?');
    $st->execute([$id]);
    $existing = $st->fetch();

    $loggedAt = $existing ? $existing['logged_at'] : null;
    $answeredAt = $existing ? $existing['answered_at'] : null;
    if ($answeredAt === null && $answering) {
        $answeredAt = date('Y-m-d H:i:s');
    }

    $st = $pdo->prepare(
        'INSERT INTO calls (id, person_id, call_date, call_time, called_by, outcome, note, logged_at, answered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, NOW()), ?)
         ON DUPLICATE KEY UPDATE person_id = VALUES(person_id), call_date = VALUES(call_date),
           call_time = VALUES(call_time), called_by = VALUES(called_by),
           outcome = VALUES(outcome), note = VALUES(note), answered_at = VALUES(answered_at)'
    );
    $st->execute([
        $id,
        clean_string($data['personId'] ?? '', 36),
        clean_date($data['date'] ?? ''),
        clean_string($data['time'] ?? '', 5),
        clean_string($data['by'] ?? '', 160),
        clean_string($data['outcome'] ?? '', 32),
        (string) ($data['note'] ?? ''),
        $loggedAt,
        $answeredAt,
    ]);
    return 1;
}
