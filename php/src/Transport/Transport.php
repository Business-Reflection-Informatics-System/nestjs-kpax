<?php

declare(strict_types=1);

namespace BizReflex\Kpax\Transport;

use BizReflex\Kpax\Exception\TransportException;

/**
 * Sends one HTTP request. Implement it to use Guzzle, a PSR-18 client, Symfony HttpClient, …
 * Throw TransportException for network failures (they are retried for idempotent methods).
 */
interface Transport
{
    /** @throws TransportException */
    public function send(HttpRequest $request): HttpResponse;
}
