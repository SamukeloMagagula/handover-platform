<?php

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit("This script runs from the command line only.\n");
}

require_once __DIR__ . '/../db.php';
require_once __DIR__ . '/../helpers.php';

$job = $argv[1] ?? 'daily';
$pdo = get_db();
$cfg = app_config();

function send_notification(string $title, string $body, array $emails = []): void
{
    $cfg = app_config();
    $sent = false;

    $hook = (string) ($cfg['teams_webhook'] ?? '');
    if ($hook !== '') {
        $payload = json_encode([
            '@type'      => 'MessageCard',
            '@context'   => 'https://schema.org/extensions',
            'summary'    => $title,
            'themeColor' => 'C8102E',
            'title'      => $title,
            'text'       => nl2br(htmlspecialchars($body, ENT_QUOTES)),
        ]);

        $ch = curl_init($hook);
        curl_setopt_array($ch, [
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => $payload,
            CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 10,
        ]);
        $res = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);

        if ($res === false || $code >= 300) {
            fwrite(STDERR, "Teams webhook failed (HTTP $code)\n");
        } else {
            $sent = true;
        }
    }

    foreach (array_unique(array_filter($emails)) as $to) {
        if (send_mail((string) $to, $title, $body)) {
            $sent = true;
        } else {
            fwrite(STDERR, "mail to $to was not sent (check mail_from and the MTA)\n");
        }
    }

    if (!$sent) {
        echo "[not delivered] $title\n$body\n";
    }
}

function duty_lines(array $duties): string
{
    if (!$duties) {
        return "  nobody\n";
    }
    $out = '';
    foreach ($duties as $d) {
        $numbers = array_map(static function (array $c): string {
            return $c['value'];
        }, array_slice($d['person']['contacts'], 0, 2));

        $out .= '  ' . $d['person']['name'];
        if ($d['site'] !== '') {
            $out .= ' · ' . $d['site'];
        }
        if ($numbers) {
            $out .= ' · ' . implode(' / ', $numbers);
        }
        if ($d['coveringFor']) {
            $out .= ' (covering for ' . $d['coveringFor'] . ')';
        }
        if ($d['onLeave']) {
            $out .= '  ⚠ ON LEAVE';
        }
        $out .= "\n";
    }
    return $out;
}

if ($job === 'daily') {
    $tomorrow = date('Y-m-d', strtotime('+1 day'));
    $standby  = on_call($pdo, $tomorrow, 'standby');
    $onsite   = on_call($pdo, $tomorrow, 'onsite');
    $gaps     = cover_gaps($pdo, 14);

    $body  = "Cover for " . date('D j M', strtotime($tomorrow)) . "\n\n";
    $body .= "On standby:\n" . duty_lines($standby);
    $body .= "\nOn site:\n" . duty_lines($onsite);

    if ($gaps) {
        $body .= "\nNo standby cover on " . count($gaps) . " of the next 14 days:\n  "
            . implode(', ', array_map(static function (string $d): string {
                return date('D j M', strtotime($d));
            }, $gaps)) . "\n";
    }

    $emails = [];
    foreach (array_merge($standby, $onsite) as $d) {
        foreach ($d['person']['contacts'] as $c) {
            if ($c['kind'] === 'email') {
                $emails[] = $c['value'];
            }
        }
    }

    $title = $gaps
        ? 'Call book: cover for tomorrow, and ' . count($gaps) . ' days with no standby'
        : 'Call book: cover for tomorrow';

    send_notification($title, $body, $emails);
    log_action($pdo, 'Sent the daily cover notification');
    exit(0);
}

if ($job === 'unanswered') {
    $after = (int) ($cfg['unanswered_minutes'] ?? 30);
    $open  = unanswered_calls($pdo, $after);

    if (!$open) {
        exit(0);
    }

    $body = "Logged more than $after minutes ago and still not answered:\n\n";
    foreach ($open as $c) {
        $body .= '  ' . $c['name'] . ' — ' . $c['call_date'] . ' ' . $c['call_time']
            . ' · ' . ($c['outcome'] === '' ? 'no outcome recorded' : $c['outcome']) . "\n";
        if ($c['note'] !== null && $c['note'] !== '') {
            $body .= '      ' . $c['note'] . "\n";
        }
    }

    $chain = escalation_chain($pdo, '');
    if ($chain) {
        $body .= "\nEscalation order:\n";
        foreach ($chain as $i => $step) {
            $numbers = array_map(static function (array $c): string {
                return $c['value'];
            }, array_slice($step['person']['contacts'], 0, 2));
            $body .= '  ' . ($i + 1) . '. ' . $step['person']['name']
                . ($numbers ? ' · ' . implode(' / ', $numbers) : '')
                . ' (after ' . $step['afterMinutes'] . " min)\n";
        }
    }

    $emails = [];
    foreach ($chain as $step) {
        foreach ($step['person']['contacts'] as $c) {
            if ($c['kind'] === 'email') {
                $emails[] = $c['value'];
            }
        }
    }

    send_notification('Call book: ' . count($open) . ' unanswered call(s)', $body, $emails);
    exit(0);
}

fwrite(STDERR, "Unknown job: $job. Use 'daily' or 'unanswered'.\n");
exit(1);
