<?php

declare(strict_types=1);

namespace BizReflex\Kpax\Transport;

use BizReflex\Kpax\Exception\TransportException;

/** Default transport built on ext-curl. */
final class CurlTransport implements Transport
{
    /** @param array<int, mixed> $curlOptions extra CURLOPT_* values (proxy, CA bundle, …) */
    public function __construct(private readonly array $curlOptions = [])
    {
        if (!\function_exists('curl_init')) {
            throw new \LogicException('ext-curl is required by CurlTransport; install it or pass your own Transport');
        }
    }

    public function send(HttpRequest $request): HttpResponse
    {
        $ch = curl_init();
        $headers = [];
        $lines = [];
        foreach ($request->headers as $name => $value) {
            $lines[] = $name . ': ' . $value;
        }
        $options = [
            CURLOPT_URL => $request->url,
            CURLOPT_CUSTOMREQUEST => $request->method,
            CURLOPT_HTTPHEADER => $lines,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_TIMEOUT_MS => (int) round($request->timeout * 1000),
            CURLOPT_HEADERFUNCTION => static function ($ch, string $line) use (&$headers): int {
                $parts = explode(':', $line, 2);
                if (\count($parts) === 2) {
                    $headers[strtolower(trim($parts[0]))] = trim($parts[1]);
                }

                return \strlen($line);
            },
        ];
        if ($request->body !== null) {
            $options[CURLOPT_POSTFIELDS] = $request->body;
        }
        curl_setopt_array($ch, $this->curlOptions + $options);
        $body = curl_exec($ch);
        if ($body === false) {
            $error = curl_error($ch);
            curl_close($ch);
            throw new TransportException('KPAX request failed: ' . $error);
        }
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);

        return new HttpResponse($status, $headers, (string) $body);
    }
}
