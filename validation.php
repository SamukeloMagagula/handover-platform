<?php

declare(strict_types=1);

function email_problem(string $email): ?string
{
    if ($email === '') {
        return 'An email address is required.';
    }
    if (mb_strlen($email) > 190) {
        return 'That email address is too long.';
    }
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
        return 'Enter a valid email address.';
    }
    return null;
}

function password_problem(string $password, ?string $confirm = null): ?string
{
    if ($confirm !== null && $password !== $confirm) {
        return 'The two passwords do not match.';
    }
    if (mb_strlen($password) < 10) {
        return 'Use at least 10 characters.';
    }
    if (!preg_match('/[A-Z]/', $password)) {
        return 'Include at least one uppercase letter.';
    }
    if (!preg_match('/[a-z]/', $password)) {
        return 'Include at least one lowercase letter.';
    }
    if (!preg_match('/\d/', $password)) {
        return 'Include at least one number.';
    }
    if (!preg_match('/[^A-Za-z0-9]/', $password)) {
        return 'Include at least one special character.';
    }
    return null;
}
