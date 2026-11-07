<?php

declare(strict_types=1);

namespace BizReflex\Kpax\Model;

/** A KPAX account (hierarchy node). */
final class Account
{
    /** @param array<string, mixed> $raw */
    public function __construct(
        public readonly ?int $id,
        public readonly ?string $name,
        public readonly ?string $parentType,
        public readonly ?int $parentId,
        public readonly ?string $activationCode,
        public readonly array $raw,
    ) {
    }

    /** @param array<string, mixed> $raw */
    public static function fromArray(array $raw): self
    {
        return new self(
            Convert::int($raw['id'] ?? null),
            Convert::str($raw['name'] ?? null),
            Convert::str($raw['parent_type'] ?? null),
            Convert::int($raw['parent_id'] ?? null),
            Convert::str($raw['activation_code'] ?? null),
            $raw,
        );
    }
}
