<?php

declare(strict_types=1);

namespace BizReflex\Kpax\Model;

/** Result of KpaxClient::testConnection() (B17). */
final class ConnectionTestResult
{
    /** @param 'config'|'auth'|'api'|null $stage */
    public function __construct(
        public readonly bool $ok,
        public readonly int $latencyMs,
        public readonly ?string $stage = null,
        public readonly ?int $status = null,
        public readonly ?string $message = null,
        public readonly ?ServerStatus $server = null,
    ) {
    }
}
