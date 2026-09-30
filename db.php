<?php

declare(strict_types=1);

function app_config(): array
{
    static $config = null;
    if ($config === null) {
        $file = __DIR__ . '/config.php';
        if (!is_file($file)) {
            throw new RuntimeException(
                'config.php is missing. Copy config.php.example to config.php and fill it in.'
            );
        }
        $config = require $file;
    }
    return $config;
}

/* Does this address fall inside the range? Plain address or CIDR, IPv4 or
   IPv6. Compared as packed bytes rather than as text, so 10.0.0.1 and
   10.000.000.001 cannot disagree and ::1 matches 0:0:0:0:0:0:0:1. */
function ip_in_range(string $ip, string $range): bool
{
    $range = trim($range);
    if ($range === '' || $ip === '') {
        return false;
    }

    $bits = null;
    if (strpos($range, '/') !== false) {
        [$range, $suffix] = explode('/', $range, 2);
        if (!preg_match('/^\d{1,3}$/', trim($suffix))) {
            return false;
        }
        $bits = (int) trim($suffix);
    }

    $a = @inet_pton($ip);
    $b = @inet_pton(trim($range));
    if ($a === false || $b === false || strlen($a) !== strlen($b)) {
        return false;   /* one is v4 and the other v6, or neither parses */
    }

    if ($bits === null) {
        return hash_equals($b, $a);
    }
    if ($bits > strlen($a) * 8) {
        return false;
    }

    $whole = intdiv($bits, 8);
    $rest  = $bits % 8;

    if ($whole > 0 && strncmp($a, $b, $whole) !== 0) {
        return false;
    }
    if ($rest === 0) {
        return true;
    }

    $mask = chr((0xff << (8 - $rest)) & 0xff);
    return (($a[$whole] & $mask) === ($b[$whole] & $mask));
}

function is_trusted_proxy(string $address): bool
{
    foreach ((array) (app_config()['trusted_proxies'] ?? []) as $range) {
        if (ip_in_range($address, (string) $range)) {
            return true;
        }
    }
    return false;
}

/* X-Forwarded-For arrives as "client, proxy1, proxy2": each hop appends the
   address it heard from, so the rightmost entry is the one our own proxy
   wrote and everything to its left is progressively less trustworthy -
   the leftmost is whatever the client claimed and can be pure invention.
   Walking from the right and stopping at the first hop we do not recognise
   therefore lands on the last address a machine we trust vouched for. */
function forwarded_hop(string $raw): ?string
{
    $hops = array_map('trim', explode(',', $raw));

    for ($i = count($hops) - 1; $i >= 0; $i--) {
        $hop = strip_ip_port($hops[$i]);
        if ($hop === '') {
            continue;
        }
        if (@inet_pton($hop) === false) {
            return null;   /* not an address: believe nothing further left */
        }
        if (is_trusted_proxy($hop)) {
            continue;      /* another of our own hops */
        }
        return $hop;
    }
    return null;
}

/* "10.0.0.1:52001" and "[2001:db8::1]:52001" both carry a port some proxies
   append. Bare IPv6 has colons of its own, so it is left alone. */
function strip_ip_port(string $value): string
{
    $value = trim($value);
    if ($value === '') {
        return '';
    }
    if ($value[0] === '[') {
        $close = strpos($value, ']');
        return $close === false ? '' : substr($value, 1, $close - 1);
    }
    if (substr_count($value, ':') === 1) {
        return substr($value, 0, (int) strpos($value, ':'));
    }
    return $value;
}

/* Whether the machine in front may speak for the caller at all.

   Every read of an X-Forwarded-* header goes through this one decision, so
   the protocol check in auth.php and the address check below cannot drift
   apart and start trusting different things. Those headers are ordinary
   request headers: anything able to reach this port can set them, and a
   request that can claim to be encrypted when it is not can equally claim to
   come from somebody else's address. */
function proxy_may_speak(): bool
{
    if (empty(app_config()['behind_proxy'])) {
        return false;
    }

    /* An empty list means "nothing but the proxy can reach this port", so the
       machine that connected is taken to be it. Listing the proxy is better,
       and the sample config says so. */
    $listed = (array) (app_config()['trusted_proxies'] ?? []);
    if ($listed === []) {
        return true;
    }
    return is_trusted_proxy(strip_ip_port((string) ($_SERVER['REMOTE_ADDR'] ?? '')));
}

/* The address the request really came from.

   REMOTE_ADDR is the proxy's own address once anything sits in front, which
   would put the whole company behind one IP: the per-IP sign-in lockout would
   lock everybody out the moment one attacker sprayed it, and every audit row
   would name the proxy rather than the person.

   With behind_proxy off this returns REMOTE_ADDR and nothing else, which is
   what a server with no proxy in front should do. */
function client_ip(): string
{
    static $resolved = null;
    if ($resolved !== null) {
        return $resolved;
    }

    $resolved = mb_substr(strip_ip_port((string) ($_SERVER['REMOTE_ADDR'] ?? '')), 0, 45);

    if (!proxy_may_speak()) {
        return $resolved;
    }

    $forwarded = (string) ($_SERVER['HTTP_X_FORWARDED_FOR'] ?? '');
    if ($forwarded !== '') {
        $hop = forwarded_hop($forwarded);
        if ($hop !== null) {
            $resolved = mb_substr($hop, 0, 45);
        }
    }
    return $resolved;
}

function get_db(): PDO
{
    static $pdo = null;
    if ($pdo !== null) {
        return $pdo;
    }

    $c = app_config();
    $dsn = sprintf(
        'mysql:host=%s;port=%s;dbname=%s;charset=utf8mb4',
        $c['db_host'], $c['db_port'], $c['db_name']
    );

    try {
        $pdo = new PDO($dsn, $c['db_user'], $c['db_pass'], [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => false,
        ]);
    } catch (PDOException $e) {
        error_log('callbook: database connection failed: ' . $e->getMessage());
        throw new RuntimeException('The database is not reachable. Check the server log.');
    }

    return $pdo;
}
