<?php

declare(strict_types=1);

namespace BizReflex\Kpax\Exception;

/**
 * KPAX answered with a non-2xx status after retries (B09). Status 0 means a network error
 * that persisted through retries. KPAX uses 401 both for bad tokens and missing scopes, and
 * 403 for resources outside the API client's hierarchy level.
 */
final class KpaxApiException extends KpaxException
{
    public function __construct(
        public readonly int $status,
        public readonly string $method,
        public readonly string $path,
        public readonly mixed $body,
        ?string $message = null,
        ?\Throwable $previous = null,
    ) {
        parent::__construct(
            $message ?? sprintf('KPAX %s %s failed with HTTP %d%s', $method, $path, $status, Describe::body($body)),
            $status,
            $previous,
        );
    }

    public function isUnauthorized(): bool
    {
        return $this->status === 401;
    }

    public function isForbidden(): bool
    {
        return $this->status === 403;
    }

    public function isNotFound(): bool
    {
        return $this->status === 404;
    }

    public function isRateLimited(): bool
    {
        return $this->status === 429;
    }
}
