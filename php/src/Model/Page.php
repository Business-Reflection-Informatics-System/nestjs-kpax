<?php

declare(strict_types=1);

namespace BizReflex\Kpax\Model;

/**
 * One page of a paginated listing.
 *
 * @template T
 */
final class Page
{
    /** @param list<T> $data */
    public function __construct(
        public readonly array $data,
        public readonly ?PaginationMeta $meta = null,
    ) {
    }
}
