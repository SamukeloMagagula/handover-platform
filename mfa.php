<?php

declare(strict_types=1);

// Second sign-in factor: time-based one-time codes (RFC 6238 TOTP — the
// 6-digit codes Google/Microsoft Authenticator show), required for every
// sign-in after the password. Secrets are stored encrypted with mfa_key from
// config.php, and recovery codes as keyed HMACs, so read access to the mfa
// tables alone reveals neither.
//
// This is the same model as Database Administration's mfa.php, deliberately:
// two systems that disagree about how a second factor works are two systems
// somebody has to reason about twice.
//
//   - Nobody opts in. An account with no authenticator enrols at its next
//     sign-in and cannot get past that page without one.
//   - The secret is proved before it is stored. Enrolment holds it in the
//     session until the app has produced a working code from it, so a scan
//     somebody abandoned leaves the account exactly as it was.
//   - A code is accepted once. last_step only ever moves forward, in a
//     conditional UPDATE, so two requests racing with the same code cannot
//     both win.
//   - Recovery codes are keyed HMACs, spent by a single indexed UPDATE.

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/helpers.php';

const MFA_ISSUER_FALLBACK = 'Call Book';

/** How long after the password step the code has to be entered. */
const MFA_PENDING_SECONDS = 300;

/** Wrong codes allowed per password entry before starting over. */
const MFA_MAX_TRIES = 5;

const MFA_RECOVERY_CODE_COUNT = 10;
const MFA_STEP_SECONDS = 30;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32_encode(string $bytes): string
{
    $bits = '';
    foreach (str_split($bytes) as $byte) {
        $bits .= str_pad(decbin(ord($byte)), 8, '0', STR_PAD_LEFT);
    }
    $out = '';
    foreach (str_split($bits, 5) as $chunk) {
        $out .= BASE32_ALPHABET[bindec(str_pad($chunk, 5, '0', STR_PAD_RIGHT))];
    }
    return $out;
}

/** Tolerates lower case, spaces, and '=' padding — however an authenticator app displays the key. */
function base32_decode(string $text): string
{
    $text = strtoupper((string) preg_replace('/[\s=]/', '', $text));
    $bits = '';
    foreach (str_split($text) as $char) {
        $value = strpos(BASE32_ALPHABET, $char);
        if ($value === false) {
            throw new InvalidArgumentException('Not a valid authenticator key');
        }
        $bits .= str_pad(decbin($value), 5, '0', STR_PAD_LEFT);
    }
    $out = '';
    foreach (str_split($bits, 8) as $byte) {
        if (strlen($byte) === 8) {
            $out .= chr(bindec($byte));
        }
    }
    return $out;
}

/** The 6-digit code for $secret (raw bytes) in 30-second window $step. */
function totp_code(string $secret, int $step): string
{
    $hmac = hash_hmac('sha1', pack('J', $step), $secret, true);
    $offset = ord($hmac[19]) & 0x0f;
    $number = ((ord($hmac[$offset]) & 0x7f) << 24)
        | (ord($hmac[$offset + 1]) << 16)
        | (ord($hmac[$offset + 2]) << 8)
        | ord($hmac[$offset + 3]);
    return str_pad((string) ($number % 1000000), 6, '0', STR_PAD_LEFT);
}

/** The window $code is valid for — now, or one either side for clock drift — else null. */
function totp_match(string $secretBase32, string $code): ?int
{
    $code = (string) preg_replace('/\s/', '', $code);
    if (preg_match('/^\d{6}$/', $code) !== 1) {
        return null;
    }
    $secret = base32_decode($secretBase32);
    $now = intdiv(time(), MFA_STEP_SECONDS);
    foreach ([$now, $now - 1, $now + 1] as $step) {
        if (hash_equals(totp_code($secret, $step), $code)) {
            return $step;
        }
    }
    return null;
}

function mfa_new_secret(): string
{
    return base32_encode(random_bytes(20));
}

/** What the QR code encodes — the standard format every authenticator app reads. */
function mfa_otpauth_uri(string $email, string $secretBase32): string
{
    $issuer = trim((string) (app_config()['mfa_issuer'] ?? '')) ?: MFA_ISSUER_FALLBACK;
    return 'otpauth://totp/' . rawurlencode($issuer . ':' . $email)
        . '?secret=' . $secretBase32
        . '&issuer=' . rawurlencode($issuer)
        . '&algorithm=SHA1&digits=6&period=' . MFA_STEP_SECONDS;
}

/** The key in groups of four, the way apps expect it typed in by hand. */
function mfa_format_secret(string $secretBase32): string
{
    return implode(' ', str_split($secretBase32, 4));
}

function mfa_key(): string
{
    $key = (string) (app_config()['mfa_key'] ?? '');
    if (preg_match('/^[0-9a-f]{64}$/', $key) !== 1) {
        throw new RuntimeException(
            'mfa_key is missing from config.php. Generate one with: openssl rand -hex 32'
        );
    }
    return (string) hex2bin($key);
}

function mfa_encrypt(string $plain): string
{
    $iv = random_bytes(12);
    $tag = '';
    $cipher = openssl_encrypt($plain, 'aes-256-gcm', mfa_key(), OPENSSL_RAW_DATA, $iv, $tag);
    if ($cipher === false) {
        throw new RuntimeException('Could not encrypt the authenticator key.');
    }
    return base64_encode($iv . $tag . $cipher);
}

function mfa_decrypt(string $blob): string
{
    $raw = (string) base64_decode($blob, true);
    $plain = openssl_decrypt(
        substr($raw, 28),
        'aes-256-gcm',
        mfa_key(),
        OPENSSL_RAW_DATA,
        substr($raw, 0, 12),
        substr($raw, 12, 16)
    );
    if ($plain === false) {
        throw new RuntimeException('Could not decrypt the stored authenticator key (was mfa_key changed?).');
    }
    return $plain;
}

function mfa_is_enrolled(PDO $pdo, string $userId): bool
{
    $st = $pdo->prepare('SELECT 1 FROM mfa WHERE user_id = ?');
    $st->execute([$userId]);
    return (bool) $st->fetchColumn();
}

/** True if $code is a current TOTP code or an unused recovery code for $userId — each accepted at most once. */
function mfa_check_code(PDO $pdo, string $userId, string $code): bool
{
    $st = $pdo->prepare('SELECT secret_enc FROM mfa WHERE user_id = ?');
    $st->execute([$userId]);
    $enc = $st->fetchColumn();
    if ($enc === false) {
        return false;
    }

    $step = totp_match(mfa_decrypt((string) $enc), $code);
    if ($step !== null) {
        // Only moves forward, atomically — the same code (or an older one)
        // can't be accepted twice, even by two requests racing each other.
        $upd = $pdo->prepare('UPDATE mfa SET last_step = ? WHERE user_id = ? AND last_step < ?');
        $upd->execute([$step, $userId, $step]);
        return $upd->rowCount() === 1;
    }

    return mfa_use_recovery_code($pdo, $userId, $code);
}

/** Saves $userId's authenticator key (already verified with a code for window $step) and returns fresh recovery codes to show once. */
function mfa_enroll(PDO $pdo, string $userId, string $secretBase32, int $step): array
{
    $codes = mfa_generate_recovery_codes();
    $pdo->beginTransaction();
    try {
        /* REPLACE rather than INSERT: an administrator's reset removes the
           row, but a half-finished enrolment retried in a second tab must not
           collide with the first. */
        $pdo->prepare('REPLACE INTO mfa (user_id, secret_enc, last_step) VALUES (?, ?, ?)')
            ->execute([$userId, mfa_encrypt($secretBase32), $step]);
        mfa_store_recovery_codes($pdo, $userId, $codes);
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }
    return $codes;
}

function mfa_generate_recovery_codes(): array
{
    $codes = [];
    for ($i = 0; $i < MFA_RECOVERY_CODE_COUNT; $i++) {
        $codes[] = implode('-', str_split(substr(base32_encode(random_bytes(8)), 0, 12), 4));
    }
    return $codes;
}

function mfa_recovery_hash(string $code): string
{
    $normalized = strtoupper((string) preg_replace('/[\s-]/', '', $code));
    return hash_hmac('sha256', $normalized, mfa_key());
}

function mfa_store_recovery_codes(PDO $pdo, string $userId, array $codes): void
{
    $pdo->prepare('DELETE FROM mfa_recovery_codes WHERE user_id = ?')->execute([$userId]);
    $ins = $pdo->prepare('INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES (?, ?)');
    foreach ($codes as $code) {
        $ins->execute([$userId, mfa_recovery_hash($code)]);
    }
}

function mfa_use_recovery_code(PDO $pdo, string $userId, string $code): bool
{
    if (preg_match('/^[A-Za-z2-7]{4}-?[A-Za-z2-7]{4}-?[A-Za-z2-7]{4}$/', trim($code)) !== 1) {
        return false;
    }
    $st = $pdo->prepare(
        'UPDATE mfa_recovery_codes SET used_at = NOW()
         WHERE user_id = ? AND code_hash = ? AND used_at IS NULL LIMIT 1'
    );
    $st->execute([$userId, mfa_recovery_hash($code)]);
    if ($st->rowCount() !== 1) {
        return false;
    }
    log_action($pdo, 'Signed in with a recovery code');
    return true;
}

/** Removes $userId's authenticator and recovery codes — they enrol a new one at their next sign-in. */
function mfa_reset(PDO $pdo, string $userId): void
{
    $pdo->prepare('DELETE FROM mfa_recovery_codes WHERE user_id = ?')->execute([$userId]);
    $pdo->prepare('DELETE FROM mfa WHERE user_id = ?')->execute([$userId]);
}

function mfa_codes_left(PDO $pdo, string $userId): int
{
    $st = $pdo->prepare(
        'SELECT COUNT(*) FROM mfa_recovery_codes WHERE user_id = ? AND used_at IS NULL'
    );
    $st->execute([$userId]);
    return (int) $st->fetchColumn();
}

/** Everyone enrolled, keyed by user id, with when and how many recovery codes are left. */
function mfa_enrolled_by_user(PDO $pdo): array
{
    $rows = $pdo->query(
        'SELECT m.user_id, m.created_at,
                (SELECT COUNT(*) FROM mfa_recovery_codes r
                  WHERE r.user_id = m.user_id AND r.used_at IS NULL) AS codes_left
           FROM mfa m'
    )->fetchAll();

    $out = [];
    foreach ($rows as $r) {
        $out[(string) $r['user_id']] = [
            'enrolledAt' => $r['created_at'],
            'codesLeft'  => (int) $r['codes_left'],
        ];
    }
    return $out;
}

/** The half-finished sign-in waiting for its code, or null if there isn't one or it has expired. */
function mfa_pending(): ?array
{
    $pending = $_SESSION['mfa_pending'] ?? null;
    if (!is_array($pending) || time() - (int) ($pending['at'] ?? 0) > MFA_PENDING_SECONDS) {
        unset($_SESSION['mfa_pending']);
        return null;
    }
    return $pending;
}
