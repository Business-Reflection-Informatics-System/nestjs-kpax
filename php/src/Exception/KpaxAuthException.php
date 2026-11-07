<?php

declare(strict_types=1);

namespace BizReflex\Kpax\Exception;

/** The /oauth/token endpoint refused the credentials, or was unreachable (status 0) (B05). */
final class KpaxAuthException extends KpaxException
{
    public function __construct(
        public readonly int $status,
        public readonly string $host,
        public readonly mixed $body,
        ?\Throwable $previous = null,
    ) {
        parent::__construct(
            sprintf('KPAX token request to %s failed with HTTP %d%s', $host, $status, Describe::body($body)),
            $status,
            $previous,
        );
    }
}
