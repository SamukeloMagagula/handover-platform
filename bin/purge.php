<?php

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit("This script runs from the command line only.\n");
}

require_once __DIR__ . '/../db.php';
require_once __DIR__ . '/../helpers.php';

$dry = in_array('--dry-run', $argv, true);
$pdo = get_db();

$months = (int) get_meta($pdo, 'retention_months');
if ($months < 1) {
    $months = 24;
}

$cutoff = date('Y-m-d', strtotime("-$months month"));

$st = $pdo->prepare('SELECT COUNT(*) FROM calls WHERE call_date < ?');
$st->execute([$cutoff]);
$calls = (int) $st->fetchColumn();

$st = $pdo->prepare('SELECT COUNT(*) FROM duties WHERE end_date < ?');
$st->execute([$cutoff]);
$duties = (int) $st->fetchColumn();

$logCutoff = date('Y-m-d H:i:s', strtotime('-' . ($months * 2) . ' month'));
$st = $pdo->prepare('SELECT COUNT(*) FROM audit_log WHERE logged_at < ?');
$st->execute([$logCutoff]);
$entries = (int) $st->fetchColumn();

echo "Retention: $months months (cutoff $cutoff)\n";
echo "  call notes older than the cutoff : $calls\n";
echo "  finished duties older than it    : $duties\n";
echo "  history entries older than " . ($months * 2) . "mo : $entries\n";

if ($dry) {
    echo "\n--dry-run: nothing deleted.\n";
    exit(0);
}

if ($calls === 0 && $duties === 0 && $entries === 0) {
    echo "\nNothing to remove.\n";
    exit(0);
}

$pdo->beginTransaction();
try {
    $pdo->query("SELECT v FROM meta WHERE k = 'roster_version' FOR UPDATE");

    $st = $pdo->prepare('DELETE FROM calls WHERE call_date < ?');
    $st->execute([$cutoff]);

    $st = $pdo->prepare('DELETE FROM duties WHERE end_date < ?');
    $st->execute([$cutoff]);

    $st = $pdo->prepare('DELETE FROM audit_log WHERE logged_at < ?');
    $st->execute([$logCutoff]);

    set_meta($pdo, 'roster_version', (string) (roster_version($pdo) + 1));

    $st = $pdo->prepare('INSERT INTO audit_log (logged_at, who, what, ip) VALUES (NOW(), ?, ?, ?)');
    $st->execute([
        'Retention job',
        "Removed $calls call notes and $duties finished duties older than $cutoff, "
            . "and $entries history entries older than $logCutoff",
        '',
    ]);

    $pdo->commit();
    echo "\nRemoved $calls call notes, $duties duties, $entries history entries.\n";
} catch (Throwable $e) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }
    fwrite(STDERR, 'Purge failed, nothing deleted: ' . $e->getMessage() . "\n");
    exit(1);
}
