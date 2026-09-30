<?php

declare(strict_types=1);

// The handover: what the shift going off watch needs the shift coming on to
// know, and what the shift leader wants recorded about how it went.
//
// The roster answers "who is reachable". This answers "what are they walking
// into" — the ticket that is still open, the site that has been flaky all
// night, the customer who will ring at seven, and the thing the last three
// shifts have all worked around and nobody has written down.
//
// Two deliberate rules run through everything here:
//
//   - The server stamps who and when. Every author, every acknowledgement,
//     every close. The browser sends the words and nothing else. A handover
//     nobody can be held to is worth less than no handover at all, and it is
//     the same reasoning that keeps the audit log's `who` off the wire.
//
//   - Nothing is deleted. A handover is closed, with who closed it; a note is
//     append-only. "Was this ever picked up, and by whom" has to stay
//     answerable weeks later, which is exactly when somebody asks.
//
// This does not go through api.php's sync/apply_operation path, and must not:
// that path takes client-supplied ids and whole rows on trust, which is right
// for a roster the browser is editing wholesale and wrong for a record whose
// entire value is that the server vouches for it.

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/helpers.php';

const HANDOVER_PRIORITIES = ['low', 'normal', 'high', 'critical'];

/** How much of the hub is loaded at once. The handover is a working list, not an archive. */
const HANDOVER_RECENT_DAYS  = 30;
const SHIFT_REPORT_RECENT   = 30;

function handover_priority(string $value): string
{
    return in_array($value, HANDOVER_PRIORITIES, true) ? $value : 'normal';
}

/** Everything the Handover view draws, in one round trip. */
function hub_state(PDO $pdo): array
{
    return [
        'handovers'    => handover_list($pdo),
        'shiftReports' => shift_report_list($pdo),
        'openCount'    => handover_open_count($pdo),
    ];
}

/* Open items always, whatever their age — an open handover does not stop
   mattering because it is old, and one that has been open a fortnight is
   precisely the one somebody should see. Closed ones only for a window, so
   the list stays a working list. */
function handover_list(PDO $pdo): array
{
    $st = $pdo->prepare(
        "SELECT h.*, p.name AS for_person_name,
                (SELECT COUNT(*) FROM handover_notes n WHERE n.handover_id = h.id) AS note_count
           FROM handovers h
           LEFT JOIN people p ON p.id = h.for_person_id
          WHERE h.status <> 'closed'
             OR h.closed_at > (NOW() - INTERVAL ? DAY)
          ORDER BY h.status = 'closed',
                   FIELD(h.priority, 'critical', 'high', 'normal', 'low'),
                   h.created_at DESC"
    );
    $st->execute([HANDOVER_RECENT_DAYS]);
    $rows = $st->fetchAll();

    /* One query for every thread rather than one per handover: the notes are
       drawn inline under each item, so fetching them per row would be a query
       per row on the busiest view in the app. */
    $notes = [];
    if ($rows) {
        $ids = array_column($rows, 'id');
        $in  = implode(',', array_fill(0, count($ids), '?'));
        $ns  = $pdo->prepare(
            "SELECT id, handover_id, body, author, created_at
               FROM handover_notes
              WHERE handover_id IN ($in)
              ORDER BY created_at"
        );
        $ns->execute($ids);
        foreach ($ns->fetchAll() as $n) {
            $notes[(string) $n['handover_id']][] = [
                'id'      => $n['id'],
                'body'    => (string) $n['body'],
                'author'  => $n['author'],
                'at'      => $n['created_at'],
            ];
        }
    }

    return array_map(static function (array $h) use ($notes): array {
        return [
            'id'             => $h['id'],
            'ticketRef'      => $h['ticket_ref'],
            'title'          => $h['title'],
            'body'           => (string) $h['body'],
            'priority'       => $h['priority'],
            'status'         => $h['status'],
            'site'           => $h['site'],
            'forPersonId'    => $h['for_person_id'],
            'forPerson'      => $h['for_person_name'],
            'author'         => $h['author'],
            'authorUserId'   => $h['author_user_id'],
            'createdAt'      => $h['created_at'],
            'acknowledgedBy' => $h['acknowledged_by'],
            'acknowledgedAt' => $h['acknowledged_at'],
            'closedBy'       => $h['closed_by'],
            'closedAt'       => $h['closed_at'],
            'notes'          => $notes[(string) $h['id']] ?? [],
        ];
    }, $rows);
}

function handover_open_count(PDO $pdo): int
{
    return (int) $pdo->query(
        "SELECT COUNT(*) FROM handovers WHERE status <> 'closed'"
    )->fetchColumn();
}

function shift_report_list(PDO $pdo): array
{
    $st = $pdo->prepare(
        'SELECT * FROM shift_reports ORDER BY report_date DESC, shift, site LIMIT ?'
    );
    $st->bindValue(1, SHIFT_REPORT_RECENT, PDO::PARAM_INT);
    $st->execute();

    return array_map(static function (array $r): array {
        return [
            'id'            => $r['id'],
            'date'          => $r['report_date'],
            'shift'         => $r['shift'],
            'site'          => $r['site'],
            'leader'        => $r['leader'],
            'leaderUserId'  => $r['leader_user_id'],
            'progress'      => (string) $r['progress'],
            'watchItems'    => (string) $r['watch_items'],
            'optimisations' => (string) $r['optimisations'],
            'createdAt'     => $r['created_at'],
            'updatedAt'     => $r['updated_at'],
        ];
    }, $st->fetchAll());
}

function handover_by_id(PDO $pdo, string $id): ?array
{
    $st = $pdo->prepare('SELECT * FROM handovers WHERE id = ?');
    $st->execute([$id]);
    $row = $st->fetch();
    return $row ?: null;
}

/* Free text, but not unbounded and not multi-line-hostile: paragraphs are the
   point of a handover, so newlines survive where the audit log strips them.
   Control characters other than newline and tab do not. */
function hub_text($value, int $max): string
{
    $text = (string) $value;
    $text = str_replace(["\r\n", "\r"], "\n", $text);
    $text = preg_replace('/[^\P{C}\n\t]+/u', '', $text) ?? $text;
    return mb_substr(trim($text), 0, $max);
}
