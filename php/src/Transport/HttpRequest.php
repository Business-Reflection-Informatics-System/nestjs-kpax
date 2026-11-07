<?php

declare(strict_types=1);

namespace BizReflex\Kpax\Transport;

/** An outgoing HTTP request. */
final class HttpRequest
{
    /** @param array<string, string> $headers */
    public function __construct(
        public readonly string $method,
        public readonly string $url,
        public readonly array $headers = [],
        public readonly ?string $body = null,
        public readonly float $timeout = 30.0,
    ) {
    }
}
