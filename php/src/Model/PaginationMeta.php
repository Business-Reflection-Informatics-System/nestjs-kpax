<?php

declare(strict_types=1);

namespace BizReflex\Kpax\Model;

/** KPAX's Laravel-style page metadata. */
final class PaginationMeta
{
    public function __construct(
        public readonly ?int $currentPage = null,
        public readonly ?int $lastPage = null,
        public readonly ?int $perPage = null,
        public readonly ?int $total = null,
        public readonly ?int $from = null,
        public readonly ?int $to = null,
    ) {
    }

    /** @param array<string, mixed>|null $raw */
    public static function fromArray(?array $raw): ?self
    {
        if ($raw === null) {
            return null;
        }

        return new self(
            Convert::int($raw['current_page'] ?? null),
            Convert::int($raw['last_page'] ?? null),
            Convert::int($raw['per_page'] ?? null),
            Convert::int($raw['total'] ?? null),
            Convert::int($raw['from'] ?? null),
            Convert::int($raw['to'] ?? null),
        );
    }
}
