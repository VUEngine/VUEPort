<?php

declare(strict_types=1);

// the one place both proxies reach the outside world from, so a failed connection always has the same shape

// $headers are "Name: value" strings; returns status, body and contentType, or only error when the request failed
function vueport_http_request(string $method, string $url, array $headers, ?string $body, int $timeoutSeconds = 15): array
{
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HEADER => false,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_TIMEOUT => $timeoutSeconds,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
    ]);
    if ($body !== null) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
    }

    $responseBody = curl_exec($ch);
    if ($responseBody === false) {
        $error = curl_error($ch) ?: 'unknown error';
        curl_close($ch);
        return ['status' => null, 'body' => null, 'contentType' => null, 'error' => $error];
    }

    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $contentType = curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
    curl_close($ch);
    return [
        'status' => $status,
        'body' => (string) $responseBody,
        'contentType' => $contentType !== null && $contentType !== '' ? $contentType : null,
        'error' => null,
    ];
}
