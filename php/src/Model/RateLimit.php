<?php

declare(strict_types=1);

namespace BizReflex\Kpax\Model;

/** Last X-RateLimit-* values seen (B08). $reset is unix seconds. */
final class RateLimit
{
    public function __construct(
        public readonly ?int $limit,
        public readonly ?int $remaining,
        public readonly ?int $reset,
    ) {
    }
}
